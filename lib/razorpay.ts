/**
 * Razorpay integration.
 *
 * Two responsibilities, kept separate on purpose:
 *   1. Server-side API calls (order create, capture, refund) — signed with the
 *      merchant key pair.
 *   2. Cryptographic signature verification (checkout response + webhooks).
 *
 * Money flow: the customer pays MediMesh's order, and at capture time the
 * pharmacy owner's share is transferred straight to their own linked Razorpay
 * account. Only MediMesh's platform fee is retained. Funds therefore never sit
 * in a MediMesh bank balance waiting for a manual payout.
 *
 * If no credentials are configured the demo gateway is used instead, so the
 * whole order -> pay -> settle -> on-chain-record flow stays testable offline.
 */
import { createHmac, timingSafeEqual } from "crypto";

const API_BASE = "https://api.razorpay.com/v1";

export interface GatewayOrderInput {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}

export interface GatewayOrder {
  /** Gateway order id handed to the checkout widget. */
  id: string;
  amountPaise: number;
  currency: string;
  /** Pre-computed checkout signature so the client need not hold the secret. */
  checkoutSignature?: string;
}

export interface CaptureInput {
  paymentId: string;
  amountPaise: number;
  /** Pharmacy owner's linked account that receives the routed share. */
  beneficiaryAccountId?: string | null;
  beneficiaryAmountPaise?: number;
}

export interface CaptureResult {
  paymentId: string;
  transferId?: string;
  status: string;
}

export interface RefundResult {
  refundId: string;
  amountPaise: number;
  status: string;
}

export class GatewayError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
  }
}

export function razorpayConfigured(): boolean {
  return Boolean(process.env.MM_RAZORPAY_KEY_ID && process.env.MM_RAZORPAY_KEY_SECRET);
}

// ------------------------------------------------------------------ signing

function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time compare so signature checks cannot be timed-probed. */
function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verifies the signature Razorpay returns after a successful checkout.
 *
 * The payload is `order_id|payment_id` signed with the merchant key secret.
 * Returns false (never throws) on any malformed input, so callers can treat
 * this as a plain boolean guard.
 */
export function verifyCheckoutSignature(input: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  const secret = process.env.MM_RAZORPAY_KEY_SECRET;
  if (!secret || !input.orderId || !input.paymentId || !input.signature) return false;
  return safeEqualHex(hmacHex(secret, `${input.orderId}|${input.paymentId}`), input.signature);
}

/** Verifies an `x-razorpay-signature` webhook header against the raw body. */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.MM_RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  return safeEqualHex(hmacHex(secret, rawBody), signature);
}

// -------------------------------------------------- pharmacy payout accounts

export interface LinkedAccount {
  accountId: string;
  status: "pending" | "submitted" | "activated" | "rejected";
  onboardingUrl?: string;
}

/**
 * Creates a linked account for a pharmacy owner and returns the hosted
 * onboarding link.
 *
 * The owner enters their own bank details on the gateway's page; MediMesh never
 * sees or stores a bank account number. That is what keeps the PCI scope and
 * the payout details out of this database entirely.
 */
async function createLinkedAccount(input: {
  email: string;
  phone?: string | null;
}): Promise<LinkedAccount> {
  const body = await call<{ id: string; status?: string }>("/accounts", {
    method: "POST",
    body: {
      // Standardised account type keeps settlement rails consistent.
      type: "bank_account",
      email: input.email,
      ...(input.phone ? { contact: input.phone } : {}),
      legal_entity_profile: "individual",
      // Documents are collected on the hosted onboarding page.
      notes: { source: "medimesh_pharmacy_onboarding" },
    },
  });
  const link = await call<{ short_url?: string }>(`/accounts/${body.id}/links`, {
    method: "POST",
    body: { purpose: "account_updation" },
  });
  const status = (body.status ?? "pending") as LinkedAccount["status"];
  return { accountId: body.id, status, onboardingUrl: link.short_url };
}

async function fetchLinkedAccount(accountId: string): Promise<LinkedAccount["status"]> {
  try {
    const body = await call<{ status?: string }>(`/accounts/${encodeURIComponent(accountId)}`, {
      method: "GET",
    });
    return (body.status ?? "pending") as LinkedAccount["status"];
  } catch {
    return "pending";
  }
}

// --------------------------------------------------------------- transport

function authHeader(): string {
  const id = process.env.MM_RAZORPAY_KEY_ID ?? "";
  const secret = process.env.MM_RAZORPAY_KEY_SECRET ?? "";
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

async function call<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: { "content-type": "application/json", authorization: authHeader() },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch {
    throw new GatewayError("Payment gateway is unreachable");
  }
  const text = await res.text();
  if (!res.ok) {
    // Razorpay returns { error: { code, description } }; surface the
    // description but never echo the key pair back to the client.
    let detail = `Payment gateway error (${res.status})`;
    try {
      const parsed = JSON.parse(text) as { error?: { description?: string; code?: string } };
      if (parsed.error?.description) detail = parsed.error.description;
      else if (parsed.error?.code) detail = parsed.error.code;
    } catch {
      /* keep the generic message */
    }
    throw new GatewayError(detail, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

// ------------------------------------------------------------------ gateway

export interface PaymentGateway {
  readonly name: "razorpay" | "demo";
  createOrder(input: GatewayOrderInput): Promise<GatewayOrder>;
  capture(input: CaptureInput): Promise<CaptureResult>;
  refund(paymentId: string, amountPaise: number): Promise<RefundResult>;
  /** Resolves a client-reported payment id against the gateway (best effort). */
  verifyPayment?(paymentId: string): Promise<boolean>;
  /**
   * Confirms the checkout result really came from the payment rail.
   *
   * This is the gate that stops a forged "I paid" body from triggering a
   * capture, so each gateway must answer for itself: the live one re-derives
   * the HMAC with the merchant secret, and the demo one checks the shape of the
   * ids it issued. Putting the check on the interface rather than in the caller
   * means a new gateway cannot accidentally ship with no verification at all.
   */
  verifyCheckout(input: { orderId: string; paymentId: string; signature: string }): boolean;
  /** Hosted onboarding for a pharmacy owner's own payout account. */
  createLinkedAccount(input: { email: string; phone?: string | null }): Promise<LinkedAccount>;
  fetchLinkedAccount(accountId: string): Promise<LinkedAccount["status"]>;
}

const razorpayGateway: PaymentGateway = {
  name: "razorpay",

  async createOrder(input) {
    const body = await call<{ id: string; amount: number; currency: string }>("/orders", {
      method: "POST",
      body: {
        amount: input.amountPaise,
        currency: "INR",
        // Receipt must be unique per attempt; the order ref is opaque.
        receipt: input.receipt,
        notes: input.notes ?? {},
      },
    });
    const signature = process.env.MM_RAZORPAY_KEY_SECRET
      ? hmacHex(process.env.MM_RAZORPAY_KEY_SECRET, body.id)
      : undefined;
    return {
      id: body.id,
      amountPaise: body.amount,
      currency: body.currency,
      checkoutSignature: signature,
    };
  },

  async capture(input) {
    // A capture without an authorized beneficiary is a hard error: it would
    // route the entire amount to the MediMesh account, which is exactly the
    // outcome this design avoids.
    if (!input.beneficiaryAccountId || !input.beneficiaryAmountPaise) {
      throw new GatewayError(
        "Pharmacy payout account is not activated yet; settlement cannot be routed",
        409
      );
    }
    const body = await call<{
      id: string;
      status: string;
      transfers?: { id?: string }[];
    }>(`/payments/${encodeURIComponent(input.paymentId)}/capture`, {
      method: "POST",
      body: {
        amount: input.amountPaise,
        currency: "INR",
        transfer: [
          {
            account: input.beneficiaryAccountId,
            amount: input.beneficiaryAmountPaise,
            currency: "INR",
            on_behalf_of: input.beneficiaryAccountId,
            settle_on: "automatic",
          },
        ],
      },
    });
    return {
      paymentId: body.id ?? input.paymentId,
      transferId: body.transfers?.[0]?.id,
      status: body.status ?? "captured",
    };
  },

  async refund(paymentId, amountPaise) {
    const body = await call<{ id: string; amount: number; status?: string }>(
      `/payments/${encodeURIComponent(paymentId)}/refund`,
      { method: "POST", body: { amount: amountPaise } }
    );
    return { refundId: body.id, amountPaise: body.amount, status: body.status ?? "processed" };
  },

  async verifyPayment(paymentId) {
    try {
      const body = await call<{ status?: string }>(`/payments/${encodeURIComponent(paymentId)}`, {
        method: "GET",
      });
      return body.status === "captured" || body.status === "authorized";
    } catch {
      return false;
    }
  },

  createLinkedAccount,

  async fetchLinkedAccount(accountId) {
    return fetchLinkedAccount(accountId);
  },

  verifyCheckout(input) {
    return verifyCheckoutSignature(input);
  },
};

/**
 * Offline stand-in. Records nothing externally and derives deterministic ids,
 * which keeps the end-to-end flow (and the test suite) runnable without
 * merchant credentials. It is only selected when Razorpay keys are absent.
 */
const demoGateway: PaymentGateway = {
  name: "demo",

  async createOrder(input) {
    return { id: `order_demo_${input.receipt}`, amountPaise: input.amountPaise, currency: "INR" };
  },

  async capture(input) {
    if (!input.beneficiaryAccountId) {
      // Demo tolerates a missing linked account so an unseeded pharmacy can
      // still walk the flow; real mode refuses above.
      return { paymentId: input.paymentId, status: "captured" };
    }
    return {
      paymentId: input.paymentId,
      transferId: `trf_demo_${input.paymentId}`,
      status: "captured",
    };
  },

  async refund(paymentId, amountPaise) {
    return { refundId: `rfnd_demo_${paymentId}`, amountPaise, status: "processed" };
  },

  async verifyPayment(paymentId) {
    return paymentId.startsWith("pay_demo_");
  },

  verifyCheckout(input) {
    // The demo rail has no secret to sign with, so authenticity rests on the
    // id shape this gateway itself issued. That is adequate precisely because
    // no money exists — and it is why this branch must never be reachable in a
    // configured deployment, where the Razorpay gateway answers instead.
    return (
      input.orderId.startsWith("order_demo_") &&
      input.paymentId.startsWith("pay_demo_") &&
      /^order_demo_[A-Za-z0-9_-]+$/.test(input.orderId) &&
      /^pay_demo_[A-Za-z0-9_-]+$/.test(input.paymentId)
    );
  },

  async createLinkedAccount(input) {
    // Deterministic per owner so re-running onboarding does not create a new
    // account each click, and activated immediately so the demo flow completes
    // without a bank-details page nobody can fill in.
    const handle = Buffer.from(input.email).toString("base64url").slice(0, 12);
    return { accountId: `acc_demo_${handle}`, status: "activated" };
  },

  async fetchLinkedAccount(accountId) {
    return accountId.startsWith("acc_demo_") ? "activated" : "pending";
  },
};

let override: PaymentGateway | null = null;

export function getPaymentGateway(): PaymentGateway {
  if (override) return override;
  return razorpayConfigured() ? razorpayGateway : demoGateway;
}

/** Test seam; mirrors setSmsProvider/setIdentityProvider in lib/providers.ts. */
export function setPaymentGateway(g: PaymentGateway | null): void {
  override = g;
}