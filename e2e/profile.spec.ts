import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;
/** Created by global-setup: a place with one verified holding fact and its consolidated profile (version 1, today). */
const PLACE = process.env.E2E_FACT_PLACE!;
const QUOTE = process.env.E2E_FACT_QUOTE!;

test("the profile tab shows each attribute's provenance and its quoted fact; the timeline shows the profile as of a date", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();

  await page.goto(`/places/${PLACE}`);
  await page.getByRole("navigation", { name: "Reiter" }).getByRole("link", { name: "Profil" }).click();
  await expect(page).toHaveURL(new RegExp(`/places/${PLACE}\\?tab=profile$`));
  const holding = page.getByRole("row").filter({ hasText: "Halt" });
  await expect(holding).toContainText("gut");
  await expect(holding).toContainText("Text");
  await expect(page.getByRole("heading", { name: "Lücken" })).toBeVisible();

  await holding.getByRole("link", { name: "Halt" }).click();
  await expect(page).toHaveURL(new RegExp(`tab=profile&attr=holding$`));
  await expect(page.locator('mark[data-kind="quote"]').first()).toHaveText(QUOTE);

  await page.getByRole("navigation", { name: "Reiter" }).getByRole("link", { name: "Zeitachse" }).click();
  await expect(page.getByRole("slider")).toBeVisible();
  await page.getByLabel("Stand zum").fill("2020-01-01");
  await page.getByRole("button", { name: "Anzeigen" }).click();
  await expect(page).toHaveURL(/tab=timeline&asOf=2020-01-01$/);
  await expect(page.getByText("Kein Profil zum 2020-01-01")).toBeVisible();
});
