"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";

type Props = { href: string; children: ReactNode };

function Item({ href, children, current }: Props & { current: boolean }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={
        "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors " +
        (current ? "bg-rail-active font-medium text-white" : "text-rail-ink hover:bg-white/5 hover:text-white")
      }
    >
      {children}
    </Link>
  );
}

function ActiveItem({ href, children }: Props) {
  const path = usePathname();
  const current = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
  return (
    <Item href={href} current={current}>
      {children}
    </Item>
  );
}

/**
 * Sidebar link that marks itself current when the path is it or below it. With cacheComponents, `usePathname` suspends
 * on routes with unknown dynamic params, so the unmarked link is the prerendered fallback.
 */
export function NavLink({ href, children }: Props) {
  return (
    <Suspense
      fallback={
        <Item href={href} current={false}>
          {children}
        </Item>
      }
    >
      <ActiveItem href={href}>{children}</ActiveItem>
    </Suspense>
  );
}
