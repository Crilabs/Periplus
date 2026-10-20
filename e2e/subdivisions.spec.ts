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

test("Länder und Landesteile: Griechenland aufklappen, Attika mit „Aufbauen“", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: "Länder und Landesteile" }).click();
  await expect(page.getByRole("heading", { name: "Länder und Landesteile" })).toBeVisible();

  const greece = page.getByRole("list", { name: "Länder" }).getByRole("listitem").filter({ hasText: "Griechenland" });
  const attika = greece.getByRole("row").filter({ hasText: "Attika (E2E)" });
  await expect(attika).toBeHidden();
  await greece.locator("summary").click();
  await expect(attika).toBeVisible();
  await expect(attika.getByRole("button", { name: "Aufbauen: Attika (E2E)" })).toBeVisible();

  await attika.getByRole("link", { name: "Attika (E2E)" }).click();
  await expect(page.getByRole("heading", { name: "Attika (E2E)" })).toBeVisible();
  await expect(page.getByText("GR-E2E").first()).toBeVisible();
});
