import { SECTOR_CENTER_DEG, SECTORS, type Sector } from "@/lib/domain/facts/schema-types";
import { SECTOR_LABELS } from "./labels";
import { labelPosition, shelterColor, wedgePath } from "./wind-rose-math";

const pct = (v: number) => `${Math.round(v * 100)} %`;

/**
 * Wind rose of eight sector values 0–1 (shelter): one wedge per sector, radius and colour (red 0 → green 1) by
 * value, north up, each sector labelled with its name and value.
 */
export function WindRose({ sectors, size }: { sectors: Record<Sector, number>; size: number }) {
  const c = size / 2;
  const radius = size / 2 - 28;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Windrose Schutz je Sektor">
      <circle cx={c} cy={c} r={radius} fill="none" className="stroke-line-strong" />
      <circle cx={c} cy={c} r={radius / 2} fill="none" strokeDasharray="2 2" className="stroke-line" />
      {SECTORS.map((s) => (
        <path key={s} d={wedgePath(s, sectors[s], radius, c, c)} fill={shelterColor(sectors[s])} fillOpacity={0.8} className="stroke-surface">
          <title>{`${SECTOR_LABELS[s]}: ${pct(sectors[s])}`}</title>
        </path>
      ))}
      {SECTORS.map((s) => {
        const [x, y] = labelPosition(c, c, radius + 14, SECTOR_CENTER_DEG[s]);
        return (
          <text key={s} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize={10} className="fill-ink">
            <tspan x={x} dy="-0.4em" fontWeight={600}>
              {SECTOR_LABELS[s]}
            </tspan>
            <tspan x={x} dy="1.1em" className="fill-muted">
              {pct(sectors[s])}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}
