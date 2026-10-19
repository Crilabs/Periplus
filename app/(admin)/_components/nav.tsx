import Link from "next/link";
import { Suspense } from "react";
import { getDb } from "@/lib/db/client";
import { reviewCounts } from "@/lib/domain/review-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { logout } from "../actions";

const ITEMS = [
  { href: "/", label: "Übersicht" },
  { href: "/review", label: "Prüfen" },
  { href: "/map", label: "Karte" },
  { href: "/sources", label: "Quellen" },
  { href: "/compare/converters", label: "Konverter" },
  { href: "/runs", label: "Läufe" },
  { href: "/jobs", label: "Jobs" },
  { href: "/costs", label: "Kosten" },
  { href: "/quality", label: "Qualität" },
  { href: "/settings", label: "Einstellungen" },
] as const;

/** Number of open review tasks; dynamic, so it streams in behind its own Suspense boundary. */
async function OpenReviewCount() {
  await requireAdmin();
  const counts = await reviewCounts(getDb());
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <span title="Offene Prüfungen" className="ml-1 rounded bg-neutral-200 px-1.5 text-xs tabular-nums">
      {total}
    </span>
  );
}

export function Nav() {
  return (
    <nav aria-label="Hauptnavigation" className="flex items-center gap-4 border-b border-neutral-300 px-6 py-3 text-sm">
      <span className="font-semibold">Periplus</span>
      <ul className="flex flex-1 gap-4">
        {ITEMS.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="hover:underline">
              {item.label}
            </Link>
            {item.href === "/review" && (
              <Suspense fallback={null}>
                <OpenReviewCount />
              </Suspense>
            )}
          </li>
        ))}
      </ul>
      <form action={logout}>
        <button type="submit" className="hover:underline">
          Abmelden
        </button>
      </form>
    </nav>
  );
}
