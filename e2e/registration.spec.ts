import { expect, test } from "@playwright/test";

// Rider registration verifies the ID document before an account is created.
test.describe("rider registration document verification", () => {
  test("valid driving licence verifies and registers", async ({ page }) => {
    await page.goto("/rider/register");
    await page.getByLabel("Full name").fill("Playwright Rider");
    await page.getByLabel("Email").fill(`pw.rider.${Date.now()}@medimesh.demo`);
    await page.getByLabel("Phone").fill("9800011111");
    await page.getByLabel("Vehicle number").fill("KA-09-PW-1234");
    await page.getByLabel("ID type").selectOption("DL");
    await page.getByLabel("ID number").fill("KA0120210009988");

    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/Valid DL/i)).toBeVisible();

    await page.getByLabel("Password", { exact: true }).fill("Str0ng!Passw0rd#");
    await page.getByLabel("Confirm password").fill("Str0ng!Passw0rd#");
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { name: /Almost there/i })).toBeVisible();
    await expect(page.getByText(/Document verified/i)).toBeVisible();
  });

  test("invalid Aadhaar is rejected inline", async ({ page }) => {
    await page.goto("/rider/register");
    await page.getByLabel("Full name").fill("Playwright Bad");
    await page.getByLabel("ID type").selectOption("Aadhaar");
    await page.getByLabel("ID number").fill("123456789012");

    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByText(/cannot start with 0 or 1/i)).toBeVisible();
  });
});
