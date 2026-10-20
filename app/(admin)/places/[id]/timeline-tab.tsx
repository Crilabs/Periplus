import Link from "next/link";
import type { ChangeSeverity } from "@/lib/db/schema/profiles";
import { formatProfileValue, profileAttributeLabel } from "@/lib/domain/consolidation/format";
import type { VersionDiff, VersionNote, TimelineEvent, TimelineVersion } from "@/lib/domain/profile-timeline";
import type { AttributeFactsView, ProfileView } from "@/lib/domain/profile-view";
import { CHANGE_TYPE_LABELS, CONFIDENCE_CLASS_LABELS, SEVERITY_LABELS, VERSION_DIFF_LABELS, VERSION_NOTE_LABELS } from "../../_components/labels";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  inputClass,
  Mono,
  Notice,
  numClass,
  Panel,
  Table,
  tdClass,
  thClass,
  trClass,
  type Tone,
} from "../../_components/ui";
import { ProfileTab, type ProfileLinks } from "./profile-tab";
import { VersionSlider } from "./version-slider";

const SEVERITY_TONES: Record<ChangeSeverity, Tone> = { info: "neutral", notable: "warn", safety: "danger" };

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
    <div className="space-y-6">
      {max === 0 ? (
        <Panel>
          <EmptyState title="Noch kein Profil.">
            Die Zeitachse zeigt jede Version des Profils, sobald ein Konsolidierungslauf das erste erzeugt hat.
          </EmptyState>
        </Panel>
      ) : (
        <Panel
          title="Stand wählen"
          description="Der Regler blättert durch die Profilversionen; ein Datum zeigt die Version, die an diesem Tag galt."
        >
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
            {view && <VersionSlider key={view.snapshot.version} baseHref={baseHref} current={view.snapshot.version} max={max} />}
            <form method="get" action={`/places/${placeId}`} className="flex items-end gap-2">
              <input type="hidden" name="tab" value="timeline" />
              <Field label="Stand zum">
                <input type="date" name="asOf" defaultValue={asOf ?? ""} required className={inputClass} />
              </Field>
              <Button>Anzeigen</Button>
            </form>
          </div>
        </Panel>
      )}
      {asOfInvalid && <Notice tone="danger">Ungültiges Datum. Bitte ein gültiges Datum wählen.</Notice>}
      {max > 0 && !view && asOf && (
        <Notice tone="neutral">
          Kein Profil zum {asOf}: die erste Version gilt ab {versions[0]!.validFrom}.
        </Notice>
      )}

      {view && (
        <>
          <Panel title="Änderungen zur Vorversion" flush={diff !== null && diff.length > 0}>
            {diff === null ? (
              <p className="text-sm text-muted">Erste Version.</p>
            ) : diff.length === 0 ? (
              <p className="text-sm text-muted">
                Keine Wert- oder Klassenänderungen.
                {diffNotes.map((n) => ` ${VERSION_NOTE_LABELS[n]}`).join("")}
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={thClass}>Attribut</th>
                    <th className={thClass}>Art</th>
                    <th className={thClass}>vorher</th>
                    <th className={thClass}>nachher</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.map((d) => (
                    <tr key={d.attribute} className={trClass}>
                      <td className={tdClass}>{profileAttributeLabel(d.attribute)}</td>
                      <td className={tdClass}>
                        <Badge tone={d.kind === "removed" ? "danger" : d.kind === "added" ? "ok" : "accent"}>{VERSION_DIFF_LABELS[d.kind]}</Badge>
                      </td>
                      <td className={tdClass}>
                        {d.kind === "added" ? "–" : formatProfileValue(d.attribute, d.before)}
                        {d.classBefore && ` (${CONFIDENCE_CLASS_LABELS[d.classBefore]})`}
                      </td>
                      <td className={tdClass}>
                        {d.kind === "removed" ? "–" : formatProfileValue(d.attribute, d.after)}
                        {d.classAfter && ` (${CONFIDENCE_CLASS_LABELS[d.classAfter]})`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
          <ProfileTab view={view} selected={selected} links={links} />
        </>
      )}

      <Panel
        title="Ereignisse"
        description="Änderungsereignisse des Profils, neueste zuerst. Die Versionsnummer zeigt das Profil dieses Stands."
        flush
      >
        {events.length === 0 ? (
          <EmptyState title="Keine Ereignisse.">Für dieses Profil ist noch keine Änderung erfasst.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th className={thClass} title="Laufende Nummer im Änderungs-Feed">Nr.</th>
                <th className={thClass}>Schwere</th>
                <th className={thClass}>Typ</th>
                <th className={thClass}>Attribut</th>
                <th className={thClass}>alt → neu</th>
                <th className={`${thClass} text-right`}>Version</th>
                <th className={thClass}>Zeit</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.seq} className={trClass}>
                  <td className={tdClass}>
                    <Mono>{e.seq}</Mono>
                  </td>
                  <td className={tdClass}>
                    <Badge tone={SEVERITY_TONES[e.severity]}>{SEVERITY_LABELS[e.severity]}</Badge>
                  </td>
                  <td className={tdClass}>{CHANGE_TYPE_LABELS[e.type]}</td>
                  <td className={tdClass}>{e.attribute ? profileAttributeLabel(e.attribute) : "–"}</td>
                  <td className={tdClass}>
                    {e.attribute ? `${formatProfileValue(e.attribute, e.oldValue)} → ${formatProfileValue(e.attribute, e.newValue)}` : "–"}
                  </td>
                  <td className={`${tdClass} ${numClass}`}>
                    {e.profileVersion === null ? (
                      "–"
                    ) : (
                      <Link href={`${baseHref}&v=${e.profileVersion}`} className="text-accent hover:underline">
                        {e.profileVersion}
                      </Link>
                    )}
                  </td>
                  <td className={`${tdClass} whitespace-nowrap text-xs text-muted`}>{time(e.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
