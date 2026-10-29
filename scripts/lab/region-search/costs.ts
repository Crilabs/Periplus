import { readJson, writeJson } from "./store";

/** The pilot's spend, kept in `costs.json` so the cap holds across stages and restarts (spec, section 9). */
export type CostEntry = { stage: string; service: string; units: number; costEur: number; at?: string };

export class CostCapReached extends Error {
  constructor(totalEur: number, costEur: number, capEur: number) {
    super(`cost cap reached: ${totalEur.toFixed(2)} EUR spent, next call ${costEur.toFixed(4)} EUR, cap ${capEur} EUR`);
    this.name = "CostCapReached";
  }
}

const FILE = "costs.json";

export class CostLedger {
  private constructor(
    private readonly dir: string,
    readonly capEur: number,
    private entries: CostEntry[],
  ) {}

  /** The cap: 40 € by spec section 10, raised to 50 € by Christian on 29.10. after the assessment overrun (`PILOT_CAP_EUR`). */
  static async open(dir: string, capEur = Number(process.env.PILOT_CAP_EUR ?? 40)): Promise<CostLedger> {
    const entries = (await readJson<CostEntry[]>(dir, FILE)) ?? [];
    return new CostLedger(dir, capEur, entries);
  }

  get totalEur(): number {
    return this.entries.reduce((sum, e) => sum + e.costEur, 0);
  }

  /** Throws before a call that would take the spend past the cap. */
  assertRoom(costEur: number): void {
    if (this.totalEur + costEur > this.capEur) throw new CostCapReached(this.totalEur, costEur, this.capEur);
  }

  async add(entry: CostEntry): Promise<void> {
    this.entries.push({ ...entry, at: entry.at ?? new Date().toISOString() });
    await writeJson(this.dir, FILE, this.entries);
  }

  /** Spend per stage, for the report. */
  byStage(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries) out[e.stage] = (out[e.stage] ?? 0) + e.costEur;
    return out;
  }
}
