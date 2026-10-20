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
  await expect(page.locator("body[data-decision-keys=on]")).toBeAttached();

  // „Ablehnen“ (key 2) asks first: the domain would be ignored for good (UI-2). While the question is open, the decision
  // keys do nothing behind it (UI-9); „Abbrechen“ leaves the proposal open.
  await page.keyboard.press("2");
  const ask = page.getByRole("dialog", { name: "Quelle ablehnen" });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText("dauerhaft ignoriert");
  await page.keyboard.press("1");
  // a decision the key had submitted would have redirected by now
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(new RegExp(`/review/${TASK}$`));
  await ask.getByRole("button", { name: "Abbrechen" }).click();
  await expect(ask).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "Freigeben" })).toBeEnabled();

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
