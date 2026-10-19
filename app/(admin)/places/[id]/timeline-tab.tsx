import Link from "next/link";
import type { ChangeSeverity } from "@/lib/db/schema/profiles";
import { formatProfileValue, profileAttributeLabel } from "@/lib/domain/consolidation/format";
import type { VersionDiff, VersionNote, TimelineEvent, TimelineVersion } from "@/lib/domain/profile-timeline";
import type { AttributeFactsView, ProfileView } from "@/lib/domain/profile-view";
import { CHANGE_TYPE_LABELS, CONFIDENCE_CLASS_LABELS, SEVERITY_LABELS, VERSION_DIFF_LABELS, VERSION_NOTE_LABELS } from "../../_components/labels";
import { ProfileTab, type ProfileLinks } from "./profile-tab";
import { VersionSlider } from "./version-slider";

const SEVERITY_CLASSES: Record<ChangeSeverity, string> = {
  info: "bg-neutral-100 text-neutral-800",
  notable: "bg-amber-100 text-amber-900",
  safety: "bg-red-100 text-red-900",
};

const time = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");

/**
 * The timeline tab of the place page (`?tab=timeline&v=<n>&asOf=YYYY-MM-DD`): the version slider and the date field
 * „Stand zum“, the profile of the chosen state, the diff to its previous version and the change events.
 */
export function TimelineTab({
  placeId,
  baseHref,
  versions,
  events,
  view,
  selected,
  diff,
  diffNotes = [],
  asOf,
  asOfInvalid,
  links,
}: {
  placeId: string;
  /** The tab's URL with `?tab=timeline`, without `v` and `asOf`. */
  baseHref: string;
  versions: TimelineVersion[];
  events: TimelineEvent[];
  view: ProfileView | null;
  selected: AttributeFactsView | null;
  /** Diff from the previous version to the shown one; null for the first version or without a profile. */
  diff: VersionDiff[] | null;
  /** Why the version exists although `diff` is empty. */
  diffNotes?: VersionNote[];
  asOf: string | null;
  asOfInvalid: boolean;
  links: ProfileLinks;
}) {
  const max = versions.length === 0 ? 0 : Math.max(...versions.map((v) => v.version));
  return (
    <div className="space-y-4">
      {max === 0 ? (
        <p>Noch kein Profil.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          {view && <VersionSlider key={view.snapshot.version} baseHref={baseHref} current={view.snapshot.version} max={max} />}
          <form method="get" action={`/places/${placeId}`} className="flex items-center gap-2">
            <input type="hidden" name="tab" value="timeline" />
            <label className="flex items-center gap-2">
              Stand zum
              <input type="date" name="asOf" defaultValue={asOf ?? ""} required className="rounded border border-neutral-300 px-1" />
            </label>
            <button type="submit" className="rounded border border-neutral-400 px-2 py-0.5 hover:bg-neutral-100">
              Anzeigen
            </button>
          </form>
        </div>
      )}
      {asOfInvalid && (
        <p role="alert" className="rounded bg-red-100 px-3 py-2">
          Ungültiges Datum.
        </p>
      )}
      {max > 0 && !view && asOf && <p>Kein Profil zum {asOf}: die erste Version gilt ab {versions[0]!.validFrom}.</p>}

      {view && (
        <>
          <section>
            <h2 className="mb-1 font-semibold">Änderungen zur Vorversion</h2>
            {diff === null ? (
              <p>Erste Version.</p>
            ) : diff.length === 0 ? (
              <p>
                Keine Wert- oder Klassenänderungen.
                {diffNotes.map((n) => ` ${VERSION_NOTE_LABELS[n]}`).join("")}
              </p>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-neutral-300">
                    <th className="py-1 pr-4">Attribut</th>
                    <th className="pr-4">Art</th>
                    <th className="pr-4">vorher</th>
                    <th>nachher</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.map((d) => (
                    <tr key={d.attribute} className="border-b border-neutral-200 align-top">
                      <td className="py-1 pr-4">{profileAttributeLabel(d.attribute)}</td>
                      <td className="pr-4">{VERSION_DIFF_LABELS[d.kind]}</td>
                      <td className="pr-4">
                        {d.kind === "added" ? "–" : formatProfileValue(d.attribute, d.before)}
                        {d.classBefore && ` (${CONFIDENCE_CLASS_LABELS[d.classBefore]})`}
                      </td>
                      <td>
                        {d.kind === "removed" ? "–" : formatProfileValue(d.attribute, d.after)}
                        {d.classAfter && ` (${CONFIDENCE_CLASS_LABELS[d.classAfter]})`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <ProfileTab view={view} selected={selected} links={links} />
        </>
      )}

      <section>
        <h2 className="mb-1 font-semibold">Ereignisse</h2>
        {events.length === 0 ? (
          <p>Keine Ereignisse.</p>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-neutral-300">
                <th className="py-1 pr-4">seq</th>
                <th className="pr-4">Schwere</th>
                <th className="pr-4">Typ</th>
                <th className="pr-4">Attribut</th>
                <th className="pr-4">alt → neu</th>
                <th className="pr-4">Version</th>
                <th>Zeit</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.seq} className="border-b border-neutral-200 align-top">
                  <td className="py-1 pr-4 font-mono text-xs">{e.seq}</td>
                  <td className="pr-4">
                    <span className={`rounded px-1 ${SEVERITY_CLASSES[e.severity]}`}>{SEVERITY_LABELS[e.severity]}</span>
                  </td>
                  <td className="pr-4">{CHANGE_TYPE_LABELS[e.type]}</td>
                  <td className="pr-4">{e.attribute ? profileAttributeLabel(e.attribute) : "–"}</td>
                  <td className="pr-4">
                    {e.attribute ? `${formatProfileValue(e.attribute, e.oldValue)} → ${formatProfileValue(e.attribute, e.newValue)}` : "–"}
                  </td>
                  <td className="pr-4">
                    {e.profileVersion === null ? (
                      "–"
                    ) : (
                      <Link href={`${baseHref}&v=${e.profileVersion}`} className="underline">
                        {e.profileVersion}
                      </Link>
                    )}
                  </td>
                  <td>{time(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
