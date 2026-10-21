import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;
/** Created by global-setup: the synthetic delivery subdivision `XT-E2E-DELIVERY` with its valid package, version 1. */
const SUBDIVISION = process.env.E2E_DELIVERY_SUBDIVISION!;

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();
}

test("the synthetic subdivision's package is valid with 17 passed checks, spots.json downloads, „Paket bauen“ opens its run", async ({ page }) => {
  await login(page);

  await page.goto("/deliveries");
  const card = page.getByRole("list", { name: "Landesteile" }).getByRole("listitem").filter({ hasText: "XT-E2E-DELIVERY" });
  await expect(card).toContainText("Version 1");

  await page.goto(`/deliveries?subdivision=${SUBDIVISION}`);
  const row = page.getByRole("row").filter({ hasText: "Gültig" }).first();
  await expect(row.getByRole("cell").nth(2)).toHaveText("1");
  await row.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/deliveries\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /Version 1$/ })).toBeVisible();
  await expect(page.getByText("Alle 17 Prüfungen bestanden.")).toBeVisible();
  const checks = page.locator("section").filter({ has: page.getByRole("heading", { name: "Validierungsbericht" }) }).getByRole("listitem");
  await expect(checks).toHaveCount(17);
  for (const check of await checks.all()) await expect(check.getByText("ok", { exact: true })).toBeVisible();

  const download = page.locator('a[download][href$="/files/spots.json"]');
  const res = await page.request.get((await download.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { spots: unknown[] }).spots.length).toBeGreaterThan(0);

  await page.goto("/deliveries");
  await card.getByRole("button", { name: /^Paket bauen/ }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("progressbar", { name: "Fortschritt delivery.build" })).toBeVisible();

  // no worker runs in e2e: end the run, so its job never waits in the test database
  await page.getByRole("button", { name: "Lauf beenden …" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Lauf beenden" }).click();
  await expect(page.getByRole("button", { name: "Lauf beenden …" })).toHaveCount(0);
});
