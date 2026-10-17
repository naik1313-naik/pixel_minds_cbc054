/**
 * Captures the screens used in the README.
 *
 * Writes to `docs/images/` — a tracked directory — rather than `demo-assets/`,
 * which is gitignored because it holds large demo recordings. A README that
 * points at untracked files shows broken images for anyone who clones the repo.
 *
 *   npx playwright test e2e/screenshots.spec.ts --project=desktop
 *
 * Screenshots are written as artefacts rather than asserted on: this is a
 * documentation job, not a test, and a pixel-perfect comparison would make it
 * fail every time a font or a card border changed.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";

const OUT = path.join(process.cwd(), "docs", "images");

test.beforeAll(() => {
  fs.mkdirSync(OUT, { recursive: true });
});

/** Signs in through the demo one-tap persona, the way a judge would. */
async function loginAs(page: Page, key: string) {
  await page.goto("/login");
  const button = page.getByRole("button", { name: new RegExp(key, "i") }).first();
  await expect(button).toBeVisible();
  await button.click();
  await page.waitForURL((url: URL) => !url.pathname.includes("/login"), { timeout: 20_000 });
}

test("capture the README screens", async ({ page, browser }) => {
  const shot = async (name: string) => {
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  };

  /**
   * Runs one delivery to completion through the API so the rider's earnings
   * panel has something true to show.
   *
   * Worth doing rather than shipping a screenshot of an empty dashboard: a
   * README that pictures ₹0 next to a feature named "rider earnings" argues
   * against itself.
   *
   * Each role gets its own browser context so the session cookies are kept
   * apart. Hand-rolling cookie headers is a trap — a response often clears one
   * cookie and sets another, and keeping only the first produces a 401 that
   * looks like an authentication bug rather than a test bug.
   */
  const earnForRider = async () => {
    const actors = {
      customer: "customer",
      owner: "owner1",
      rider: "rider1",
    } as const;
    const contexts = {} as Record<keyof typeof actors, Awaited<ReturnType<typeof browser.newContext>>>;
    for (const [actor, key] of Object.entries(actors)) {
      contexts[actor as keyof typeof actors] = await browser.newContext();
      await contexts[actor as keyof typeof actors].request.post("/api/auth/demo-login", {
        data: { key },
      });
    }
    const call = async (
      actor: keyof typeof actors,
      method: "GET" | "POST",
      path: string,
      body?: unknown
    ) => {
      const res = await contexts[actor].request.fetch(path, {
        method,
        data: body as never,
      });
      if (!res.ok()) {
        console.log(`      ${method} ${path} -> ${res.status()}`);
      }
      return res.json().catch(() => ({}));
    };

    await call("rider", "POST", "/api/rider/status", { online: true });

    const created = await call("customer", "POST", "/api/requests", {
      medicineId: 2,
      qty: 1,
      fulfilmentType: "delivery",
      preferredPharmacyId: 1,
      deliveryAddress: "42 Test Street, Indiranagar",
      deliveryLat: 12.9719,
      deliveryLng: 77.6412,
    });
    const requestId = created?.requestId;
    if (!requestId) return;

    await call("owner", "POST", `/api/requests/${requestId}/confirm`, {});
    const ready = await call("owner", "POST", `/api/requests/${requestId}/ready`, {});
    const deliveryId = ready?.deliveryId;
    if (!deliveryId) return;

    const order = await call("customer", "POST", `/api/requests/${requestId}/payment`, {});
    await call("customer", "POST", "/api/payments/verify", {
      razorpayOrderId: order?.razorpayOrderId,
      razorpayPaymentId: `pay_demo_${String(order?.razorpayOrderId ?? "").replace(/^order_demo_/, "")}`,
      razorpaySignature: "demo-signature-not-required",
    });

    await call("rider", "POST", "/api/rider/offers", { deliveryId, action: "accept" });
    await call("owner", "POST", `/api/pharmacy/deliveries/${deliveryId}/approve`, {});
    for (const status of ["ArrivedAtPharmacy", "PickedUp", "OutForDelivery", "ArrivedAtDestination"]) {
      await call("rider", "POST", `/api/rider/deliveries/${deliveryId}/status`, { status });
    }
    const otp = await call("customer", "GET", `/api/requests/${requestId}/otp`);
    await call("rider", "POST", `/api/rider/deliveries/${deliveryId}/handover`, {
      otp: otp?.otp,
      idChecked: true,
    });

    for (const context of Object.values(contexts)) await context.close();
  };

  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/");
  await shot("01-landing");

  await page.goto("/login");
  await shot("02-signin");

  await loginAs(page, "Asha");
  await shot("03-customer-catalogue");

  await loginAs(page, "Apollo Pharmacy");
  await page.waitForTimeout(1400);
  await shot("04-pharmacy-console");

  await loginAs(page, "Demo Admin");
  await page.waitForTimeout(1400);
  await shot("05-admin-operations");

  const outbox = page.getByRole("button", { name: /write outbox/i });
  if (await outbox.count()) {
    await outbox.first().click();
    await shot("06-admin-reconciliation");
  }

  const disputes = page.getByRole("button", { name: /disputes/i });
  if (await disputes.count()) {
    await disputes.first().click();
    await shot("07-admin-disputes");
  }

  await earnForRider();
  await loginAs(page, "Kiran");
  await page.waitForTimeout(1600);
  await shot("08-rider-earnings");
});