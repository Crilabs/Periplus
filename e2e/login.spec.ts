import { expect, test } from "@playwright/test";

const E2E_EMAIL = process.env.E2E_EMAIL!;
const E2E_PASSWORD = process.env.E2E_PASSWORD!;

async function signIn(page: import("@playwright/test").Page, password = E2E_PASSWORD) {
  await page.getByLabel("E-Mail").fill(E2E_EMAIL);
  await page.getByLabel("Passwort").fill(password);
  await page.getByRole("button", { name: "Anmelden" }).click();
}

test("admin logs in, sees the overview, logs out", async ({ page }) => {
  await page.goto("/runs");
  await expect(page).toHaveURL(/\/login\?next=%2Fruns/);
  await signIn(page);
  await expect(page).toHaveURL(/\/runs$/);
  await expect(page.getByRole("heading", { name: "Läufe" })).toBeVisible();
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/runs");
  await expect(page).toHaveURL(/\/login\?next=%2Fruns/);
});

test("open redirect via next is ignored", async ({ page }) => {
  await page.goto("/login?next=//evil.example");
  await signIn(page);
  await expect(page).toHaveURL(/localhost:\d+\/$/);
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();
});

test("wrong password shows the generic error", async ({ page }) => {
  await page.goto("/login");
  await signIn(page, "definitely-wrong-password");
  await expect(page.getByText("E-Mail oder Passwort falsch.")).toBeVisible();
});

test("health endpoints are public", async ({ request }) => {
  expect((await request.get("/healthz")).status()).toBe(200);
  expect(await (await request.get("/readyz")).json()).toEqual({ status: "ok" });
});
