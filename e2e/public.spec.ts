import { expect, test } from "@playwright/test";

test.describe("public surface", () => {
  test("landing page renders the value proposition", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Every medicine");
    await expect(page.getByRole("main").getByRole("link", { name: /Get started/i })).toBeVisible();
    // Stats load from the live API.
    await expect(page.getByText(/Pharmacies/i).first()).toBeVisible();
    await expect(page.getByText(/Units in network/i).first()).toBeVisible();
  });

  test("login page is reachable from the landing CTA", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: /Explore the live demo/i }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();
  });

  test("protected app redirects anonymous users to login", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login$/);
  });
});
