import Link from "next/link";
import { logout } from "../actions";

const ITEMS = [
  { href: "/", label: "Übersicht" },
  { href: "/map", label: "Karte" },
  { href: "/runs", label: "Läufe" },
  { href: "/jobs", label: "Jobs" },
  { href: "/costs", label: "Kosten" },
  { href: "/settings", label: "Einstellungen" },
] as const;

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
