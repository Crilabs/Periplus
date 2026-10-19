import { afterEach, describe, expect, it } from "vitest";
import { startSiteServer } from "@/test/site-server";

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("startSiteServer", () => {
  it("serves 304 for a matching If-None-Match and 404 for a removed path", async () => {
    const site = await startSiteServer();
    servers.push(site);
    expect(site.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    site.set("/page", { body: "<h1>Hi</h1>", headers: { "content-type": "text/html", etag: '"v1"' } });
    const first = await fetch(`${site.origin}/page`);
    expect(first.status).toBe(200);
    expect(first.headers.get("etag")).toBe('"v1"');
    expect(await first.text()).toBe("<h1>Hi</h1>");

    const cached = await fetch(`${site.origin}/page`, { headers: { "If-None-Match": '"v1"' } });
    expect(cached.status).toBe(304);
    const changed = await fetch(`${site.origin}/page`, { headers: { "If-None-Match": '"v0"' } });
    expect(changed.status).toBe(200);
    await changed.arrayBuffer();

    site.set("/page", null);
    expect((await fetch(`${site.origin}/page`)).status).toBe(404);
    expect((await fetch(`${site.origin}/never`)).status).toBe(404);

    site.set("/doc.pdf", { status: 200, body: new Uint8Array([37, 80, 68, 70]), headers: { "content-type": "application/pdf" } });
    const pdf = await fetch(`${site.origin}/doc.pdf?x=1`);
    expect(Array.from(new Uint8Array(await pdf.arrayBuffer()))).toEqual([37, 80, 68, 70]);

    expect(site.requests.map((r) => r.path)).toEqual(["/page", "/page", "/page", "/page", "/never", "/doc.pdf?x=1"]);
    expect(site.requests[1]!.headers["if-none-match"]).toBe('"v1"');
  });

  it("serves a redirect status with its location header", async () => {
    const site = await startSiteServer();
    servers.push(site);
    site.set("/old", { status: 301, body: "", headers: { location: "/new" } });
    const res = await fetch(`${site.origin}/old`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/new");
  });
});
