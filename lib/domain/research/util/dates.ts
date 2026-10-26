const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;
/** Day a month-only observation is placed on. */
const MID_MONTH = 15;

/** The text up to the end of its `n`-th word (words = runs of non-whitespace). */
export function firstWords(md: string, n: number): string {
  if (n <= 0) return "";
  let count = 0;
  for (const m of md.matchAll(/\S+/g)) {
    if (++count === n) return md.slice(0, m.index + m[0].length).trim();
  }
  return md.trim();
}

/** A real calendar date `YYYY-MM-DD`, or `null`. */
function calendarDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * A model date as `YYYY-MM-DD` (a month `YYYY-MM` only when `allowMonth`, placed on day 15, or on the fetch date when
 * that is earlier in the fetch month, ruling M4-D-R3), kept only between `earliest` and the fetch date; anything else
 * is `null`. Also used for the observation dates of extracted facts.
 */
export function plausibleDate(value: string | null, fetchedAt: Date, earliest: string, allowMonth: boolean): string | null {
  if (value === null) return null;
  const v = value.trim();
  const fetched = fetchedAt.toISOString().slice(0, 10);
  const day = DAY.exec(v);
  const month = allowMonth ? MONTH.exec(v) : null;
  let date = day
    ? calendarDate(Number(day[1]), Number(day[2]), Number(day[3]))
    : month
      ? calendarDate(Number(month[1]), Number(month[2]), MID_MONTH)
      : null;
  if (month && date !== null && date > fetched && date.slice(0, 7) === fetched.slice(0, 7)) date = fetched;
  if (date === null || date < earliest || date > fetched) return null;
  return date;
}
