"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The version slider of the timeline tab: a range 1…`max`; releasing it replaces the URL with `baseHref` plus `v=<n>`
 * (`baseHref` already carries `?tab=timeline`), so the server renders that version.
 */
export function VersionSlider({ baseHref, current, max }: { baseHref: string; current: number; max: number }) {
  const router = useRouter();
  const [value, setValue] = useState(current);
  const go = (v: number) => {
    if (v !== current) router.replace(`${baseHref}&v=${v}`, { scroll: false });
  };
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium">Version</span>
      <span className="flex h-9 items-center gap-3">
        <input
          type="range"
          min={1}
          max={max}
          step={1}
          value={value}
          aria-valuetext={`Version ${value} von ${max}`}
          onChange={(e) => setValue(Number(e.target.value))}
          onPointerUp={(e) => go(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => go(Number((e.target as HTMLInputElement).value))}
          className="w-56 accent-accent sm:w-72"
        />
        <span className="min-w-12 text-right tabular-nums text-muted">
          {value} / {max}
        </span>
      </span>
    </label>
  );
}
