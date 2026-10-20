import Image from "next/image";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { getDb } from "@/lib/db/client";
import { reviewCounts } from "@/lib/domain/review-view";
import { requireAdmin } from "@/lib/security/require-admin";
import { logout } from "../actions";
import logo from "@/app/_brand/logo.png";
import { NavLink } from "./nav-link";

/** 20×20 stroke icons, drawn for this nav only. */
const ICONS: Record<string, ReactNode> = {
  overview: <path d="M3 10.5 10 4l7 6.5M5 9v7h4v-4h2v4h4V9" />,
  review: <path d="M4 10.5 8 14.5 16 6" />,
  map: <path d="M3 5.5 7.5 4l5 1.5L17 4v10.5L12.5 16l-5-1.5L3 16V5.5ZM7.5 4v10.5M12.5 5.5V16" />,
  sources: <path d="M5 3.5h7l3 3V16.5H5v-13ZM12 3.5v3h3M7.5 10h5M7.5 13h5" />,
  runs: <path d="M6 4.5v11l9-5.5-9-5.5Z" />,
  deliveries: <path d="M3.5 6.5 10 3.5l6.5 3v7L10 16.5l-6.5-3v-7ZM3.5 6.5 10 9.5l6.5-3M10 9.5v7" />,
  jobs: <path d="M3.5 6h13M3.5 10h13M3.5 14h8" />,
  costs: <path d="M14.5 5.5A5.5 5.5 0 1 0 14.5 14.5M4 8.5h7M4 11.5h7" />,
  quality: <path d="M10 3 4.5 5v4.5c0 3.5 2.4 6 5.5 7.5 3.1-1.5 5.5-4 5.5-7.5V5L10 3ZM7.5 10l2 2 3-3.5" />,
  converters: <path d="M4 7h10l-3-3M16 13H6l3 3" />,
  models: <path d="M10 3.5 16 7v6l-6 3.5L4 13V7l6-3.5ZM10 10l6-3M10 10 4 7M10 10v6.5" />,
  settings: (
    <path d="M10 7.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5ZM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  ),
};

const GROUPS: Array<{ label?: string; items: Array<{ href: string; label: string; icon: string }> }> = [
  {
    items: [
      { href: "/", label: "Übersicht", icon: "overview" },
      { href: "/review", label: "Prüfen", icon: "review" },
      { href: "/map", label: "Karte", icon: "map" },
    ],
  },
  {
    label: "Daten",
    items: [
      { href: "/sources", label: "Quellen", icon: "sources" },
      { href: "/runs", label: "Läufe", icon: "runs" },
      { href: "/quality", label: "Qualität", icon: "quality" },
      { href: "/deliveries", label: "Lieferungen", icon: "deliveries" },
    ],
  },
  {
    label: "Betrieb",
    items: [
      { href: "/jobs", label: "Jobs", icon: "jobs" },
      { href: "/costs", label: "Kosten", icon: "costs" },
      { href: "/settings", label: "Einstellungen", icon: "settings" },
    ],
  },
  {
    label: "Werkstatt",
    items: [
      { href: "/compare/converters", label: "Konverter", icon: "converters" },
      { href: "/compare/models", label: "Modellvergleich", icon: "models" },
    ],
  },
];

function Icon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      className="size-4 shrink-0 opacity-80"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

/** Number of open review tasks; dynamic, so it streams in behind its own Suspense boundary. */
async function OpenReviewCount() {
  await requireAdmin();
  const counts = await reviewCounts(getDb());
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  return (
    <span
      title={`${total} offene Prüfungen`}
      className="ml-auto rounded-full bg-warn px-1.5 text-[11px] font-semibold leading-[18px] text-rail tabular-nums"
    >
      {total}
    </span>
  );
}

/**
 * Sidebar on wide screens, a collapsible top bar below `lg`. One <nav> for both, so tests and screen
 * readers find a single "Hauptnavigation"; the mobile toggle is a CSS-only checkbox.
 */
export function Nav() {
  return (
    <aside className="sticky top-0 z-30 bg-rail text-rail-ink lg:fixed lg:inset-y-0 lg:left-0 lg:w-56">
      <input id="nav-toggle" type="checkbox" className="peer sr-only" />
      <div className="flex h-14 items-center justify-between px-4 lg:h-16">
        <Link href="/" className="rounded-sm">
          <Image src={logo} alt="Periplus" priority className="h-8 w-auto" />
        </Link>
        <label
          htmlFor="nav-toggle"
          className="cursor-pointer rounded-md p-2 text-rail-ink hover:bg-white/10 lg:hidden"
          aria-label="Menü"
        >
          <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <path d="M3.5 6h13M3.5 10h13M3.5 14h13" strokeLinecap="round" />
          </svg>
        </label>
      </div>
      <nav
        aria-label="Hauptnavigation"
        className="hidden max-h-[calc(100vh-3.5rem)] flex-col overflow-y-auto px-3 pb-4 peer-checked:flex lg:flex lg:h-[calc(100vh-4rem)] lg:max-h-none"
      >
        <div className="flex-1 space-y-5 pt-2">
          {GROUPS.map((group, i) => (
            <div key={i}>
              {group.label && <p className="mb-1 px-2.5 text-[11px] font-medium text-rail-ink/55">{group.label}</p>}
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <li key={item.href}>
                    <NavLink href={item.href}>
                      <Icon name={item.icon} />
                      {item.label}
                      {item.href === "/review" && (
                        <Suspense fallback={null}>
                          <OpenReviewCount />
                        </Suspense>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <form action={logout} className="mt-4 border-t border-white/10 pt-3">
          <button
            type="submit"
            className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-rail-ink hover:bg-white/5 hover:text-white"
          >
            <svg viewBox="0 0 20 20" className="size-4 opacity-80" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d="M8 4H4.5v12H8M12 6.5 15.5 10 12 13.5M15.5 10H8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Abmelden
          </button>
        </form>
      </nav>
    </aside>
  );
}
