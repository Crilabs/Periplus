import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;
/**
 * Created by global-setup: a bay with a place and verified text facts of the active extraction run (holding, quoted
 * as `QUOTE`, and two shelter facts quoted from the same chunk).
 */
const PLACE = process.env.E2E_FACT_PLACE!;
const QUOTE = process.env.E2E_FACT_QUOTE!;

test("a fact on the place page shows its quote highlighted, and so does its document", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();

  await page.goto(`/places/${PLACE}`);
  await page.getByRole("navigation", { name: "Reiter" }).getByRole("link", { name: "Facts" }).click();
  await expect(page).toHaveURL(new RegExp(`/places/${PLACE}\\?tab=facts$`));
  const fact = page.getByRole("listitem").filter({ has: page.locator('mark[data-kind="quote"]', { hasText: QUOTE }) });
  await expect(fact.locator('mark[data-kind="quote"]')).toHaveText(QUOTE);
  await expect(fact).toContainText("gut");
  await expect(fact).not.toContainText("nicht aktiver Lauf");

  await fact.getByRole("link", { name: /\.e2e\.test\.invalid$/ }).click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}\?v=[0-9a-f-]{36}&tab=annotations$/);
  // highlighted in the chunk text (and again in the facts table under it)
  await expect(page.getByRole("article").locator('mark[data-kind="quote"]', { hasText: QUOTE })).toHaveText(QUOTE);
});
