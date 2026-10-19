import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;
/**
 * Created by global-setup: a place with verified holding and `shelter.N` facts and its consolidated profile, version 1
 * ten days ago (shelter.N 0,90) and version 2 today (shelter.N 0,50 after a worse text).
 */
const PLACE = process.env.E2E_FACT_PLACE!;
const QUOTE = process.env.E2E_FACT_QUOTE!;
/** The quote of the shelter.N text fact that sets the current value (version 2). */
const SHELTER_QUOTE = process.env.E2E_SHELTER_QUOTE!;

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();
}

test("the profile tab shows each attribute's provenance and its quoted fact; the timeline shows the profile as of a date", async ({ page }) => {
  await login(page);

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

test("shelter.N shows origin Text with its quoted fact; the version slider at version 1 shows the old value", async ({ page }) => {
  await login(page);
  await page.goto(`/places/${PLACE}?tab=profile`);
  const shelterRow = () => page.getByRole("row").filter({ has: page.getByRole("link", { name: "Schutz aus N", exact: true }) });
  await expect(shelterRow()).toContainText("0,50");
  await expect(shelterRow()).toContainText("Text");

  await shelterRow().getByRole("link", { name: "Schutz aus N", exact: true }).click();
  await expect(page).toHaveURL(/tab=profile&attr=shelter\.N$/);
  await expect(page.locator('mark[data-kind="quote"]').filter({ hasText: SHELTER_QUOTE }).first()).toBeVisible();

  await page.getByRole("navigation", { name: "Reiter" }).getByRole("link", { name: "Zeitachse" }).click();
  const slider = page.getByRole("slider");
  await expect(slider).toHaveAttribute("aria-valuetext", "Version 2 von 2");
  await expect(shelterRow()).toContainText("0,50");
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/tab=timeline&v=1$/);
  await expect(page.getByRole("slider")).toHaveAttribute("aria-valuetext", "Version 1 von 2");
  await expect(shelterRow()).toContainText("0,90");
  await expect(page.getByText("Erste Version.")).toBeVisible();
});
