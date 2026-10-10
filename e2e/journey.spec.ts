import { expect, test } from "@playwright/test";
import { loginAs } from "./helpers";

test.describe("customer journey", () => {
  test("customer can search, reserve and track a medicine", async ({ page }) => {
    await loginAs(page, "customer1@medimesh.demo", "/app");
    await expect(page.getByRole("heading", { name: /Hello/i })).toBeVisible();

    // Search narrows the catalogue.
    await page.getByPlaceholder(/Search by name or salt/i).fill("Paracetamol");
    const firstMedicine = page.locator("button", { hasText: /available/i }).first();
    await expect(firstMedicine).toBeVisible();
    await firstMedicine.click();

    // The detail panel offers a reservation form.
    await expect(page.getByText(/Request this medicine/i)).toBeVisible();
    const requestButton = page.getByRole("button", { name: /Request \d+ ×/i });
    await expect(requestButton).toBeEnabled();
    await requestButton.click();

    // We land on the tracker for the new request.
    await page.waitForURL(/\/app\/request\/\d+/);
    await expect(page.getByText(/Progress/i)).toBeVisible();
    await expect(page.getByText(/Back to search/i)).toBeVisible();
  });

  test("pharmacy owner (2FA) reaches the console", async ({ page }) => {
    await loginAs(page, "owner1@medimesh.demo", "/pharmacy");
    await expect(page.getByRole("main").getByText(/Pharmacy console/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Incoming requests/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Inventory/i })).toBeVisible();
  });

  test("rider reaches the delivery app", async ({ page }) => {
    await loginAs(page, "rider1@medimesh.demo", "/rider");
    await expect(page.getByRole("button", { name: /Go online|Go offline/i })).toBeVisible();
  });

  test("admin (2FA) reaches the admin console", async ({ page }) => {
    await loginAs(page, "admin@medimesh.demo", "/admin");
    await expect(page.getByRole("heading", { name: /Network administration/i })).toBeVisible();
  });
});
