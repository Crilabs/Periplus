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
  await expect(page.getByRole("heading", { name: "Läufe", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/runs");
  await expect(page).toHaveURL(/\/login\?next=%2Fruns/);
});

test("admin starts a ping run and sees it listed; all admin pages render", async ({ page }) => {
  await page.goto("/login");
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Übersicht" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Offene Prüfungen", exact: true })).toBeVisible();
  await page.goto("/runs");
  // every subdivision run, the revisit too, starts only from the "Lauf starten" dialog (ruling M7-G-R4)
  const revisit = page.getByRole("button", { name: "Revisit für Landesteil" });
  await expect(revisit).toBeHidden();
  await page.getByRole("button", { name: "Lauf starten …" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByRole("heading", { name: "Lauf starten" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Revisit für Landesteil" })).toBeVisible();
  await expect(dialog.getByText("Solange er läuft, startet kein Crawl dieser Quellen.", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Schließen" }).click();
  await expect(revisit).toBeHidden();
  const before = await page.locator("tbody tr").count();
  await page.getByRole("button", { name: "Ping-Lauf starten" }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await expect(page.locator("tbody tr")).toHaveCount(Math.min(before + 1, 50));
  await page.locator("tbody tr").first().getByRole("link").click();
  await expect(page.getByRole("heading", { name: /^Lauf / })).toBeVisible();
  for (const [path, heading] of [
    ["/jobs", "Jobs"],
    ["/costs", "Kosten"],
    ["/settings", "Einstellungen"],
    ["/deliveries", "Lieferungen"],
    ["/subdivisions", "Länder und Landesteile"],
    ["/map", "Karte"],
    ["/sources", "Quellen"],
    ["/compare/converters", "Konverter-Vergleich"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
  }
});

test("quality page renders for the first subdivision with tiles", async ({ page }) => {
  await page.goto("/login?next=/quality");
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Qualität", exact: true })).toBeVisible();
  for (const section of ["Kennzahlen", "Messen", "Review-Aufwand", "Verlauf", "Kacheln", "Regression", "Vergleichssatz"]) {
    await expect(page.getByRole("heading", { name: section, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Navily-Abgleich" })).toHaveAttribute("href", /\/quality\/compare\?subdivision=/);
  // an evaluation leaves the rules unchanged unless a version is chosen (ruling M7-E-R2)
  const rules = page.locator('select[name="rulesVersion"]');
  await expect(rules).toHaveValue("");
  await expect(rules.locator("option:checked")).toHaveText("unverändert");
  // the e2e delivery subdivision has tiles: the page shows it, without the "not found" hint
  await expect(page.getByTestId("subdivision-missing")).toHaveCount(0);
  await expect(page.getByTestId("comparison-count")).toBeVisible();
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

test("redirect Location is relative and ignores a spoofed Host header", async ({ baseURL }) => {
  const { request } = await import("node:http");
  const url = new URL("/runs", baseURL);
  const location = await new Promise<string | undefined>((resolve, reject) => {
    request(url, { headers: { host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.headers.location);
    })
      .on("error", reject)
      .end();
  });
  expect(location).toBe("/login?next=%2Fruns");
});
