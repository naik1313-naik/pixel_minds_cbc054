import { haversineKm, roadDistanceKm, etaMinutes } from "./geo";
import {
  demoRegistryLookup,
  verifyDocument,
  verifyDocumentAsync,
  type DocumentCheck,
  type DocumentRegistryLookup,
} from "./identity";

// Simulated, swappable providers. In DEMO_MODE messages print to the terminal.

export interface SmsProvider {
  send(to: string, message: string): void;
}

class ConsoleSmsProvider implements SmsProvider {
  send(to: string, message: string): void {
    // eslint-disable-next-line no-console
    console.log(`\n[SMS → ${to}] ${message}\n`);
  }
}

let sms: SmsProvider = new ConsoleSmsProvider();
export function getSmsProvider(): SmsProvider {
  return sms;
}
export function setSmsProvider(p: SmsProvider): void {
  sms = p;
}

// ------------------------------------------------------------ notifications

/**
 * Outbound message to a person, not a system.
 *
 * Separate from SmsProvider on purpose: OTP delivery is a security control and
 * must fail loudly if it does not go out, whereas an advisory "your rider is on
 * the way" is a convenience. A delivery that goes out without the notification
 * is still a delivery; a delivery that waits on a gateway is not.
 */
export interface NotificationProvider {
  name: string;
  notify(input: { to: string | null | undefined; message: string }): Promise<void>;
}

class ConsoleNotificationProvider implements NotificationProvider {
  name = "console";
  async notify(input: { to: string | null | undefined; message: string }): Promise<void> {
    if (!input.to) return;
    // eslint-disable-next-line no-console
    console.log(`\n[${this.name} → ${input.to}] ${input.message}\n`);
  }
}

/** Routes through an HTTP gateway when MM_SMS_ENDPOINT is configured. */
function httpNotificationProvider(endpoint: string, apiKey?: string): NotificationProvider {
  return {
    name: "http",
    async notify({ to, message }) {
      if (!to) return;
      try {
        await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ to, message }),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Swallowed on purpose: a notification failure must never roll back or
        // fail the order it was describing.
      }
    },
  };
}

function defaultNotificationProvider(): NotificationProvider {
  return process.env.MM_SMS_ENDPOINT
    ? httpNotificationProvider(process.env.MM_SMS_ENDPOINT, process.env.MM_SMS_API_KEY)
    : new ConsoleNotificationProvider();
}

let notifications: NotificationProvider = defaultNotificationProvider();

export function getNotificationProvider(): NotificationProvider {
  return notifications;
}

/** Pass null to restore the configured default, mirroring setPaymentGateway. */
export function setNotificationProvider(p: NotificationProvider | null): void {
  notifications = p ?? defaultNotificationProvider();
}

export interface RouteResult {
  distanceKm: number;
  durationMinutes: number;
}

export interface RoutingProvider {
  route(a: { lat: number; lng: number }, b: { lat: number; lng: number }): RouteResult;
}

// Straight-line distance with a road factor and city-speed ETA.
export const demoRoutingProvider: RoutingProvider = {
  route(a, b) {
    const distanceKm = roadDistanceKm(a, b);
    return { distanceKm, durationMinutes: etaMinutes(distanceKm) };
  },
};

export function straightLineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  return haversineKm(a, b);
}

export interface PaymentProvider {
  authorize(amountPaise: number, ref: string): { ok: boolean; ref: string };
  refund(amountPaise: number, ref: string): { ok: boolean; ref: string };
}

// No real money moves in the demo; amounts are recorded in paise.
export const demoPaymentProvider: PaymentProvider = {
  authorize(amountPaise, ref) {
    return { ok: amountPaise >= 0, ref: `pay_${ref}` };
  },
  refund(amountPaise, ref) {
    return { ok: amountPaise >= 0, ref: `refund_${ref}` };
  },
};

export function getPaymentProvider(): PaymentProvider {
  return demoPaymentProvider;
}

// ------------------------------------------------------------------- identity

// Confirms a person's government document (Aadhaar/PAN/DL/…). The default
// implementation validates structure + checksum offline and then consults a
// deterministic registry. Set MM_KYC_ENDPOINT (and MM_KYC_API_KEY) to route
// checks to a real KYC/eKYC gateway instead.
export interface IdentityProvider {
  verify(input: { type: string; number: string; name?: string }): DocumentCheck | Promise<DocumentCheck>;
}

export const demoIdentityProvider: IdentityProvider = {
  verify(input) {
    return verifyDocument(input, demoRegistryLookup);
  },
};

// A real gateway is expected to accept POST { type, number, name } and reply
// with { found|verified, reference, nameMatch?, note? }. Any transport failure
// is surfaced as `unverifiable` (not `invalid`) so an outage never silently
// rejects a legitimate applicant — admins still make the final call.
export function httpIdentityProvider(endpoint: string, apiKey?: string): IdentityProvider {
  return {
    verify(input) {
      return verifyDocumentAsync(input, async ({ type, number, name }) => {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({ type, number, name }),
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) {
            return { found: false, reference: null, unavailable: true, note: `KYC gateway error (${res.status})` };
          }
          const data = (await res.json()) as {
            found?: boolean;
            verified?: boolean;
            reference?: string;
            nameMatch?: boolean;
            note?: string;
          };
          return {
            found: Boolean(data.found ?? data.verified),
            reference: data.reference ?? null,
            nameMatch: data.nameMatch,
            note: data.note,
          };
        } catch {
          return { found: false, reference: null, unavailable: true, note: "KYC gateway unreachable" };
        }
      });
    },
  };
}

function selectIdentityProvider(): IdentityProvider {
  const endpoint = process.env.MM_KYC_ENDPOINT;
  if (endpoint) return httpIdentityProvider(endpoint, process.env.MM_KYC_API_KEY);
  return demoIdentityProvider;
}

let identity: IdentityProvider = selectIdentityProvider();
export function getIdentityProvider(): IdentityProvider {
  return identity;
}
export function setIdentityProvider(p: IdentityProvider): void {
  identity = p;
}

export type { DocumentCheck, DocumentRegistryLookup };
