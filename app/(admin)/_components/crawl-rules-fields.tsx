import { crawlRulesSchema, type CrawlRules } from "@/lib/domain/sources/crawl-rules";
import { CONVERTER_LABELS, CRAWL_RULE_LABELS, RENDER_MODE_LABELS } from "./labels";
import { inputClass, textareaClass } from "./ui";

/** Crawl rules entered one entry per line. */
const LIST_FIELDS = ["startUrls", "allow", "deny", "boilerplateSelectors"] as const;
const NUMBER_FIELDS = ["maxDepth", "maxPages", "ratePerMinute"] as const;

const LIST_HINTS: Record<(typeof LIST_FIELDS)[number], string> = {
  startUrls: "eine URL je Zeile",
  allow: "ein regulärer Ausdruck je Zeile, gegen Pfad und Query; leer = alles",
  deny: "ein regulärer Ausdruck je Zeile; schlägt „Erlaubte Pfade“",
  boilerplateSelectors: "ein CSS-Selektor je Zeile",
};

const NUMBER_HINTS: Record<(typeof NUMBER_FIELDS)[number], string> = {
  maxDepth: "Link-Schritte ab den Start-URLs",
  maxPages: "Obergrenze je Crawl-Lauf",
  ratePerMinute: "Obergrenze, schont den Server der Quelle",
};

const NUMBER_LIMITS: Record<(typeof NUMBER_FIELDS)[number], { min: number; max: number }> = {
  maxDepth: { min: 0, max: 10 },
  maxPages: { min: 1, max: 5000 },
  ratePerMinute: { min: 1, max: 120 },
};


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
      <span role="alert" className="text-xs font-medium text-danger">
        {" "}
        – ungültig
      </span>
    ) : null;
  const label = "flex flex-col gap-1.5 text-sm";
  return (
    <fieldset className="grid w-full gap-4">
      <legend className="mb-3 text-sm font-semibold">Crawl-Regeln</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        {LIST_FIELDS.map((f) => (
          <label key={f} className={label}>
            <span className="font-medium">
              {CRAWL_RULE_LABELS[f]}
              {mark(f)}
            </span>
            <textarea
              name={f}
              rows={Math.max(2, defaults[f].length + 1)}
              defaultValue={defaults[f].join("\n")}
              spellCheck={false}
              className={`${textareaClass} min-h-16 font-mono text-xs`}
            />
            <span className="text-xs leading-snug text-muted">{LIST_HINTS[f]}</span>
          </label>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {NUMBER_FIELDS.map((f) => (
          <label key={f} className={label}>
            <span className="font-medium">
              {CRAWL_RULE_LABELS[f]}
              {mark(f)}
            </span>
            <input
              type="number"
              name={f}
              required
              step={f === "ratePerMinute" ? "any" : 1}
              {...NUMBER_LIMITS[f]}
              defaultValue={defaults[f]}
              className={inputClass}
            />
            <span className="text-xs leading-snug text-muted">
              {NUMBER_HINTS[f]} ({NUMBER_LIMITS[f].min}–{NUMBER_LIMITS[f].max})
            </span>
          </label>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3 sm:items-end">
        <label className={label}>
          <span className="font-medium">
            {CRAWL_RULE_LABELS.render}
            {mark("render")}
          </span>
          <select name="render" defaultValue={defaults.render} className={inputClass}>
            {Object.entries(RENDER_MODE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          <span className="font-medium">
            {CRAWL_RULE_LABELS.converter}
            {mark("converter")}
          </span>
          <select name="converter" defaultValue={defaults.converter} className={inputClass}>
            {Object.entries(CONVERTER_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" name="pdf" defaultChecked={defaults.pdf} className="size-4 accent-accent" />
          {CRAWL_RULE_LABELS.pdf}
        </label>
      </div>
    </fieldset>
  );
}
