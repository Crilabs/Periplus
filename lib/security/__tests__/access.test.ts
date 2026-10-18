import { describe, expect, it } from "vitest";
import { decideAccess } from "../access";
import type { SessionClaims } from "../session";

const claims: SessionClaims = {
  sub: "00000000-0000-7000-8000-000000000001",
  email: "a@test.invalid",
  iat: 1_800_000_000,
  exp: 1_800_043_200,
  abs: 1_800_604_800,
};

describe("decideAccess", () => {
  it.each(["/runs", "/runs/abc", "/", "/map", "/map-data/places", "/jobs", "/costs", "/settings"])(
    "redirects %s to login without session",
    (p) => {
      expect(decideAccess({ pathname: p, session: null, hasBearer: false })).toEqual({
        action: "redirect",
        to: `/login?next=${encodeURIComponent(p)}`,
      });
    },
  );

  it("allows /healthz, /readyz and /login without session", () => {
    for (const p of ["/healthz", "/readyz", "/login"]) {
      expect(decideAccess({ pathname: p, session: null, hasBearer: false })).toEqual({ action: "allow" });
    }
  });

  it("allows admin pages with a session", () => {
    for (const p of ["/", "/runs", "/runs/abc", "/settings"]) {
      expect(decideAccess({ pathname: p, session: claims, hasBearer: false })).toEqual({ action: "allow" });
    }
  });

  it("redirects unknown pages without session and lets them fall through with a session", () => {
    expect(decideAccess({ pathname: "/nope", session: null, hasBearer: false })).toEqual({
      action: "redirect",
      to: "/login?next=%2Fnope",
    });
    expect(decideAccess({ pathname: "/nope", session: claims, hasBearer: false })).toEqual({ action: "allow" });
  });

  it("denies /api/v1/ping without bearer with 401 and unknown api route with 404", () => {
    expect(decideAccess({ pathname: "/api/v1/ping", session: null, hasBearer: false })).toEqual({
      action: "deny",
      status: 401,
    });
    expect(decideAccess({ pathname: "/api/v1/ping", session: null, hasBearer: true })).toEqual({ action: "allow" });
    expect(decideAccess({ pathname: "/api/v1/unknown", session: null, hasBearer: true })).toEqual({
      action: "deny",
      status: 404,
    });
    expect(decideAccess({ pathname: "/api/v1/unknown", session: null, hasBearer: false })).toEqual({
      action: "deny",
      status: 401,
    });
  });

  it("decideAccess normalizes path variants", () => {
    expect(decideAccess({ pathname: "/runs/", session: null, hasBearer: false })).toMatchObject({ action: "redirect" });
    expect(decideAccess({ pathname: "/api/v1//ping", session: null, hasBearer: true })).toEqual({
      action: "deny",
      status: 404,
    });
    expect(decideAccess({ pathname: "/runs%2F..%2Fhealthz", session: null, hasBearer: false })).toEqual({
      action: "deny",
      status: 404,
    });
    expect(decideAccess({ pathname: "/Healthz", session: null, hasBearer: false })).toMatchObject({
      action: "redirect",
    });
  });

  it("never treats a session as API credentials", () => {
    expect(decideAccess({ pathname: "/api/v1/ping", session: claims, hasBearer: false })).toEqual({
      action: "deny",
      status: 401,
    });
  });
});
