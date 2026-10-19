import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;
/** Created by global-setup with a unique domain per run. */
const DOMAIN = process.env.E2E_SOURCE_DOMAIN!;
const TASK = process.env.E2E_SOURCE_TASK!;

test("admin approves a proposed source in the review and it is listed as approved", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();

  await page.getByRole("navigation").getByRole("link", { name: "Quellen" }).click();
  await expect(page.getByRole("heading", { name: "Quellen", exact: true })).toBeVisible();
  await page.goto(`/sources?q=${encodeURIComponent(DOMAIN)}`);
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: DOMAIN, exact: true }) });
  await expect(row.getByRole("cell", { name: "Vorgeschlagen", exact: true })).toBeVisible();

  await page.goto(`/review/${TASK}`);
  await expect(page.getByRole("heading", { name: "Quellenvorschlag" })).toBeVisible();
  await page.getByRole("button", { name: "Freigeben" }).click();
  await expect(page).not.toHaveURL(new RegExp(`/review/${TASK}$`));

  await page.goto(`/sources?q=${encodeURIComponent(DOMAIN)}`);
  await expect(row.getByRole("cell", { name: "Freigegeben", exact: true })).toBeVisible();

  // Committed test sources must not stay approved (they would join "Alle freigegebenen crawlen" in other tests).
  await row.getByRole("link", { name: DOMAIN, exact: true }).click();
  await page.getByRole("button", { name: "Pausieren" }).click();
  await page.goto(`/sources?q=${encodeURIComponent(DOMAIN)}`);
  await expect(row.getByRole("cell", { name: "Pausiert", exact: true })).toBeVisible();
});
