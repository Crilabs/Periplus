import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;
/** Created by global-setup: a place with an approved title image built on the cadastre imagery. */
const PLACE = process.env.E2E_IMAGE_PLACE!;

test("the Titelbild tab shows the approved image, its camera and why it is not delivered", async ({ page }, testInfo) => {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();

  await page.goto(`/places/${PLACE}`);
  await page.getByRole("link", { name: "Titelbild" }).click();
  await expect(page).toHaveURL(/tab=image/);

  await expect(page.getByText("KI-Illustration", { exact: true })).toBeVisible();
  await expect(page.getByText("Mittag")).toBeVisible();
  await expect(page.getByText("Nicht geliefert: Freigabe Luftbildquelle ktimatologio fehlt")).toBeVisible();
  await expect(page.getByText("Aufnahme von S, Blick nach N (0°), 260 m Höhe, Neigung 30°")).toBeVisible();

  // the pictures come from the archive through the admin route
  await page.getByText("Rendering und Maske").click();
  const sources = await page.locator("img[src^='/images/file']").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).getAttribute("src")!));
  expect(sources.length).toBe(3);
  for (const src of sources) expect((await page.request.get(src)).status(), src).toBe(200);

  await expect(page.getByRole("button", { name: "Weitere Ansicht erzeugen" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("titelbild-tab.png"), fullPage: true });
});
