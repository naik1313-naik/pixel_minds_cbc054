"use client";

/**
 * Loads the Razorpay Checkout script on demand and opens it.
 *
 * Kept in its own module because the script is a third-party global: it is only
 * fetched when a customer actually starts a payment, and it is never bundled
 * into the initial page load.
 */

interface RazorpayOptions {
  key: string;
  order_id: string;
  handler: (response: {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  }) => void | Promise<void>;
  theme?: { color: string };
  modal?: { ondismiss?: () => void };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => { open: () => void };
  }
}

const SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Could not load the payment page")));
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load the payment page"));
    document.body.appendChild(script);
  });
}

/**
 * Opens Checkout for an order and hands the signed result to the caller, which
 * posts it to /api/payments/verify. Dismissing the modal resolves without a
 * payment rather than throwing, so a closed popup is not an error state.
 */
export default async function openRazorpayCheckout(
  keyId: string,
  orderId: string,
  requestId: number
): Promise<void> {
  await loadScript();
  if (!window.Razorpay) throw new Error("Payment page unavailable");

  await new Promise<void>((resolve, reject) => {
    const checkout = new window.Razorpay!({
      key: keyId,
      order_id: orderId,
      theme: { color: "#0d9488" },
      handler: async (response) => {
        try {
          const res = await fetch("/api/payments/verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              razorpaySignature: response.razorpay_signature,
            }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            reject(new Error(body?.error ?? "Could not verify the payment"));
            return;
          }
          resolve();
        } catch (e) {
          reject(e instanceof Error ? e : new Error("Could not verify the payment"));
        }
      },
      modal: { ondismiss: () => resolve() },
    });
    checkout.open();
  });

  // `requestId` is unused by the widget but keeps the call site readable about
  // which order is being paid for.
  void requestId;
}