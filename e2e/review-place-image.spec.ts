import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;
/** Created by global-setup: an open title image task with render, mask and candidate in the test archive. */
const TASK = process.env.E2E_IMAGE_TASK!;

test("admin approves a place image", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();

  const taskUrl = `/review/${TASK}`;
  await page.goto(taskUrl);
  await expect(page.getByText("Bild prüfen: Ankerplatz")).toBeVisible();
  await expect(page.getByText("Aufnahme von S, Blick nach N (0°), 260 m Höhe, Neigung 30°")).toBeVisible();
  await expect(page.getByRole("button", { name: "Freigeben" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Neu erzeugen" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kein Bild" })).toBeVisible();

  // the render and the illustration are served from the archive through the admin route
  const sources = await page.locator("img[src^='/images/file']").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).getAttribute("src")!));
  expect(sources.length).toBeGreaterThanOrEqual(2);
  for (const src of sources) expect((await page.request.get(src)).status(), src).toBe(200);

  await page.getByRole("button", { name: "Freigeben" }).click();
  await expect(page).toHaveURL(/\/review(\/[0-9a-f-]{36})?(\?.*)?$/);
  await expect(page).not.toHaveURL(new RegExp(`${TASK}$`));

  await page.goto(taskUrl);
  await expect(page.getByText("Bereits entschieden")).toBeVisible();
  await expect(page.getByRole("button", { name: "Freigeben" })).toHaveCount(0);
});
