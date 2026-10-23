import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "@/lib/config";

/*
 * The radius preview page (spec 18, Admin-UI) without a database: home marinas, cached list and preview replaced, so
 * a failing preview and the configured trip range can be checked on the rendered markup.
 */

// a plain function, not `vi.fn`: a spy's own handling of a rejected promise surfaces as a test error
let preview: () => Promise<unknown> = async () => null;

vi.mock("@/lib/security/require-admin", () => ({ requireAdmin: async () => ({ email: "admin@example.invalid" }) }));
vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/domain/delivery/archive", () => ({ deliveryArchive: () => ({}) }));
vi.mock("@/lib/domain/delivery/radius/home-marinas", () => ({ listHomeMarinas: async () => [] }));
vi.mock("@/lib/domain/delivery/radius/view", () => ({
  RADIUS_PACKAGES_PAGE_SIZE: 50,
  listRadiusPackages: async () => [],
  previewRadius: () => preview(),
  radiusMapFeatures: async () => ({ type: "FeatureCollection", features: [] }),
}));

import Page from "../deliveries/radius/page";

async function render(searchParams: Record<string, string>): Promise<string> {
  const tree = await Page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as PageProps<"/deliveries/radius">);
  return renderToStaticMarkup(tree);
}

beforeEach(() => {
  preview = async () => null;
});

describe("/deliveries/radius page", () => {
  it("a failing preview shows its error in a notice instead of failing the page", async () => {
    preview = async () => {
      throw new Error("radius package abc: references outside the package: x → y");
    };
    const html = await render({ marina: "sp_01J9ZD00000000000000000002", days: "7" });
    expect(html).toContain("Die Vorschau ist fehlgeschlagen");
    expect(html).toContain("references outside the package: x → y");
    expect(html).toContain("Noch kein Umkreis-Paket");
  });

  it("reads the trip range and the radius rule from the config", async () => {
    const { minDays, maxDays, nmPerDay, returnFactor } = getConfig().delivery.radius;
    preview = async () => "invalid_days";
    const html = await render({ marina: "sp_01J9ZD00000000000000000002", days: "99" });
    expect(html).toContain(`min="${minDays}"`);
    expect(html).toContain(`max="${maxDays}"`);
    expect(html).toContain(`${minDays} bis ${maxDays}`);
    expect(html).toContain(`Tage müssen eine ganze Zahl von ${minDays} bis ${maxDays} sein.`);
    expect(html).toContain(`Radius = ${nmPerDay} sm × Tage × ${String(returnFactor).replace(".", ",")}`);
  });
});
