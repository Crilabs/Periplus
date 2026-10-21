import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();
}

test("Karte: Landesteil wählen, Revier anklicken, Beleg und Quelle sehen", async ({ page }) => {
  await login(page);
  await page.goto("/map");
  await page.getByLabel("Landesteil der Reviere").selectOption({ label: "Attika (E2E)" });

  // the view now fits the Landesteil, so its Revier lies in the middle of the map
  const map = page.getByRole("region", { name: "Karte" });
  await expect(map).toBeVisible();
  const box = (await map.boundingBox())!;
  await expect(async () => {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByRole("complementary", { name: "Auswahl" })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });

  const panel = page.getByRole("complementary", { name: "Auswahl" });
  await expect(panel.getByRole("heading", { name: "E2E-Revier" })).toBeVisible();
  await expect(panel.getByText("E2E Sailing Area")).toBeVisible();
  await expect(panel.getByRole("link", { name: "E2E-Hafen" })).toBeVisible();
  await expect(panel.getByText("E2E-Geisterhafen")).toBeVisible();
  await expect(panel.getByText("überlappt")).toBeVisible();
  await expect(panel.getByText("Das Revier Attika (E2E) ist ein ruhiges Segelrevier.")).toBeVisible();
  await expect(panel.getByText("Quelle: Revier-Bot, Korrekturen dort")).toBeVisible();
});
