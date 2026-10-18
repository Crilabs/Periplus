import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;
/** Created by global-setup with a unique name per run. */
const PLACE = process.env.E2E_REVIEW_PLACE!;

test("admin confirms a place candidate with key 1", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();

  await page.getByRole("navigation").getByRole("link", { name: "Prüfen" }).click();
  await expect(page.getByRole("heading", { name: "Prüfen", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^Ortskandidat: \d+$/ })).toBeVisible();
  await page.getByRole("link", { name: /^Ortskandidat: \d+$/ }).click();
  await page.getByRole("link", { name: PLACE, exact: true }).click();

  await expect(page.getByRole("heading", { name: `Ortskandidat: ${PLACE}` })).toBeVisible();
  const taskUrl = page.url();
  expect(taskUrl).toMatch(/\/review\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Kandidat", { exact: true })).toBeVisible();
  await expect(page.locator("body[data-decision-keys=on]")).toBeAttached();

  await page.keyboard.press("1");
  // Back in the queue: the next candidate or the list, never the decided task.
  await expect(page).not.toHaveURL(taskUrl);
  await expect(page).toHaveURL(/\/review(\/[0-9a-f-]{36})?$/);

  await page.goto(taskUrl);
  await expect(page.getByText("Bereits entschieden")).toBeVisible();
  await expect(page.getByText("Bestätigt", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Bestätigen" })).toHaveCount(0);
});
