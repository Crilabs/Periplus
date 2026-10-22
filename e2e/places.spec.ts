import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;
/** Created by global-setup: a marina the system confirmed on its own website, with an OSM website. */
const PLACE = process.env.E2E_AUTO_PLACE!;

test("the place page shows the automatic confirmation with its rule, the website and the berth flag", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();

  await page.goto(`/places/${PLACE}`);
  await expect(page.getByTestId("auto-decision")).toContainText("Automatisch bestätigt am");
  await expect(page.getByTestId("auto-decision")).toContainText("(Regel: Eigene Website)");
  await expect(page.getByRole("link", { name: "https://marina.e2e.test.invalid/" })).toBeVisible();
  await expect(page.getByText("(OSM)")).toBeVisible();
  await expect(page.getByText("Festmachplatz")).toBeVisible();
});
