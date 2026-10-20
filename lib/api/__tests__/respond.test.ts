import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiBody, apiError, etagOf } from "@/lib/api/respond";

const META = { schemaVersion: "1.0", dataVersion: 3, maxAgeSeconds: 60 };
const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/v1/x", { headers });

describe("apiError", () => {
  it("answers { error: { code, message } } with no-store and extra headers", async () => {
    const res = apiError(429, "rate_limited", "Rate limit exceeded.", { "Retry-After": "2" });
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toEqual({ error: { code: "rate_limited", message: "Rate limit exceeded." } });
  });
});

describe("apiBody", () => {
  it("serves bytes unchanged with ETag, private cache, schema and data version", async () => {
    const bytes = new TextEncoder().encode('{ "a": 1 }\n');
    const res = apiBody(req(), bytes, { ...META, contentType: "application/geo+json" });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(res.headers.get("etag")).toBe(`"${hash.slice(0, 32)}"`);
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    expect(res.headers.get("periplus-schema-version")).toBe("1.0");
    expect(res.headers.get("periplus-data-version")).toBe("3");
    expect(res.headers.get("content-type")).toBe("application/geo+json");
  });

  it("serializes an object like a package file and omits a null data version", async () => {
    const res = apiBody(req(), { schemaVersion: "1.0", areas: [] }, { ...META, dataVersion: null });
    expect(await res.text()).toBe('{\n  "schemaVersion": "1.0",\n  "areas": []\n}\n');
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.has("periplus-data-version")).toBe(false);
  });

  it("If-None-Match with the tag, a weak tag in a list or * returns 304 without body", async () => {
    const bytes = new TextEncoder().encode("{}\n");
    const etag = etagOf(bytes);
    for (const header of [etag, `"other", W/${etag}`, "*"]) {
      const res = apiBody(req({ "if-none-match": header }), bytes, META);
      expect(res.status, header).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    }
    expect(apiBody(req({ "if-none-match": '"other"' }), bytes, META).status).toBe(200);
  });
});
