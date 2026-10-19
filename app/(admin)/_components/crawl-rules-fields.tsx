import { crawlRulesSchema, type CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { CONVERTER_LABELS, CRAWL_RULE_LABELS, RENDER_MODE_LABELS } from "./labels";

/** Crawl rules entered one entry per line. */
const LIST_FIELDS = ["startUrls", "allow", "deny", "boilerplateSelectors"] as const;
const NUMBER_FIELDS = ["maxDepth", "maxPages", "ratePerMinute"] as const;

const LIST_HINTS: Record<(typeof LIST_FIELDS)[number], string> = {
  startUrls: "eine URL je Zeile",
  allow: "ein regulärer Ausdruck je Zeile, gegen Pfad und Query; leer = alles",
  deny: "ein regulärer Ausdruck je Zeile; schlägt „Erlaubte Pfade“",
  boilerplateSelectors: "ein CSS-Selektor je Zeile",
};

const NUMBER_LIMITS: Record<(typeof NUMBER_FIELDS)[number], { min: number; max: number }> = {
  maxDepth: { min: 0, max: 10 },
  maxPages: { min: 1, max: 5000 },
  ratePerMinute: { min: 1, max: 120 },
};

const INPUT = "rounded border border-neutral-300 px-1 py-0.5";

const lines = (value: FormDataEntryValue | null): string[] =>
  typeof value === "string"
    ? value
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "")
    : [];

const number = (value: FormDataEntryValue | null): number =>
  typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;

/**
 * Crawl rules from the fields of `CrawlRulesFields`: lists one entry per line (blank lines ignored), numbers,
 * selects and the `pdf` checkbox (absent = false). Throws the `ZodError` of `crawlRulesSchema`, one issue per
 * invalid field (`path[0]` = field name).
 */
export function parseCrawlRulesForm(form: FormData): CrawlRules {
  return crawlRulesSchema.parse({
    ...Object.fromEntries(LIST_FIELDS.map((f) => [f, lines(form.get(f))])),
    ...Object.fromEntries(NUMBER_FIELDS.map((f) => [f, number(form.get(f))])),
    render: form.get("render"),
    converter: form.get("converter"),
    pdf: form.get("pdf") !== null,
  });
}

/**
 * Form fields of the crawl rules, prefilled with `defaults`; read them with `parseCrawlRulesForm`. Fields named in
 * `invalid` are marked.
 */
export function CrawlRulesFields({ defaults, invalid = [] }: { defaults: CrawlRules; invalid?: readonly string[] }) {
  const mark = (field: keyof CrawlRules) =>
    invalid.includes(field) ? (
      <span role="alert" className="text-red-700">
        {" "}
        – ungültig
      </span>
    ) : null;
  return (
    <fieldset className="grid w-full gap-2">
      <legend className="mb-1 font-semibold">Crawl-Regeln</legend>
      {LIST_FIELDS.map((f) => (
        <label key={f} className="grid gap-0.5">
          <span>
            {CRAWL_RULE_LABELS[f]} <span className="text-neutral-500">({LIST_HINTS[f]})</span>
            {mark(f)}
          </span>
          <textarea
            name={f}
            rows={Math.max(2, defaults[f].length + 1)}
            defaultValue={defaults[f].join("\n")}
            spellCheck={false}
            className={`${INPUT} font-mono text-xs`}
          />
        </label>
      ))}
      <div className="flex flex-wrap gap-4">
        {NUMBER_FIELDS.map((f) => (
          <label key={f} className="flex items-center gap-1">
            {CRAWL_RULE_LABELS[f]}
            <input
              type="number"
              name={f}
              required
              step={f === "ratePerMinute" ? "any" : 1}
              {...NUMBER_LIMITS[f]}
              defaultValue={defaults[f]}
              className={`${INPUT} w-20`}
            />
            {mark(f)}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-1">
          {CRAWL_RULE_LABELS.render}
          <select name="render" defaultValue={defaults.render} className={INPUT}>
            {Object.entries(RENDER_MODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {mark("render")}
        </label>
        <label className="flex items-center gap-1">
          {CRAWL_RULE_LABELS.converter}
          <select name="converter" defaultValue={defaults.converter} className={INPUT}>
            {Object.entries(CONVERTER_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {mark("converter")}
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="pdf" defaultChecked={defaults.pdf} />
          {CRAWL_RULE_LABELS.pdf}
        </label>
      </div>
    </fieldset>
  );
}
