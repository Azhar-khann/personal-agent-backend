/** The eval gate and the tables it prints. Pure, so the gate's arithmetic is unit-tested. */

/** §11: fail the build if any score drops by more than this many points. */
export const MAX_DROP_POINTS = 3;

/** More errored examples than this and the scores aren't worth comparing. */
export const MAX_ERROR_SHARE = 0.02;

export type Scores = Record<string, number>;

export type Baseline = { experiment: string; commit: string | null; scores: Scores };

export type DatasetRun = {
  title: string;
  scoreKeys: string[];
  experiment: string;
  model: string;
  /** Examples the model answered; errors aren't scored. */
  scored: number;
  errors: number;
  scores: Scores;
  costUsd: number | null;
  latenciesMs: number[];
  summary: string[];
  /** Undefined when not compared; null when there's no run on main to compare with. */
  baseline?: Baseline | null;
};

export function drops(scores: Scores, baseline: Scores): { key: string; points: number }[] {
  return Object.entries(baseline).flatMap(([key, before]) => {
    const now = scores[key];
    if (now === undefined) return [];
    const points = (before - now) * 100;
    // A hair of slack so 3.0000000001 from float division doesn't fail the build.
    return points > MAX_DROP_POINTS + 1e-9 ? [{ key, points }] : [];
  });
}

export const tooManyErrors = (run: Pick<DatasetRun, "scored" | "errors">) =>
  run.errors > (run.scored + run.errors) * MAX_ERROR_SHARE;

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const pct = (value: number | undefined) => (value === undefined ? "—" : `${(value * 100).toFixed(1)}%`);
const signed = (points: number) => `${points > 0 ? "+" : points < 0 ? "−" : "±"}${Math.abs(points).toFixed(1)}`;
const seconds = (ms: number | null) => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);

/** Cost of 1,000 agent messages at the average usage per call. */
export function costPerThousand(runs: DatasetRun[]): number | null {
  if (runs.some((run) => run.costUsd === null)) return null;
  const calls = runs.reduce((sum, run) => sum + run.scored, 0);
  const cost = runs.reduce((sum, run) => sum + run.costUsd!, 0);
  return calls === 0 ? null : (cost / calls) * 1000;
}

export function gateReport(runs: DatasetRun[], heading: string): string {
  const lines = [`## ${heading}`, "", "| Dataset | Score | This run | Main | Change |", "|---|---|---|---|---|"];
  for (const run of runs) {
    for (const key of run.scoreKeys) {
      const before = run.baseline?.scores[key];
      const change = before === undefined || run.scores[key] === undefined ? "—" : signed((run.scores[key]! - before) * 100);
      const failed = run.baseline && drops({ [key]: run.scores[key]! }, { [key]: before! }).length > 0;
      lines.push(`| ${run.title} | ${key} | ${pct(run.scores[key])} | ${pct(before)} | ${change}${failed ? " ❌" : ""} |`);
    }
  }

  for (const run of runs) {
    lines.push("", `### ${run.title}`, "");
    lines.push(`Experiment \`${run.experiment}\` · ${run.scored} scored · ${run.errors} errors`);
    if (run.baseline === null) lines.push("No run on main over these examples yet, so nothing to compare with.");
    if (run.baseline) lines.push(`Compared with \`${run.baseline.experiment}\`${run.baseline.commit ? ` (${run.baseline.commit.slice(0, 7)})` : ""}.`);
    if (run.summary.length) lines.push("", "```", ...run.summary, "```");
  }

  const perThousand = costPerThousand(runs);
  const latencies = runs.flatMap((run) => run.latenciesMs);
  lines.push(
    "",
    `Model \`${runs[0]?.model ?? "?"}\` · p50 ${seconds(percentile(latencies, 50))} · p95 ${seconds(percentile(latencies, 95))} · ` +
      (perThousand === null ? "cost unknown for this model" : `$${perThousand.toFixed(2)} per 1,000 messages`),
  );
  return lines.join("\n");
}

/** §11's quality-against-cost table: one row per model. */
export function sweepTable(byModel: Map<string, DatasetRun[]>): string {
  const lines = [
    "## Models: quality against cost",
    "",
    "| Model | Category | Slots (mean of fields) | Time exact | Time near | Names | p50 latency | $ per 1,000 messages |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const [model, runs] of byModel) {
    const score = (title: string, key?: string) => {
      const run = runs.find((r) => r.title === title);
      if (!run) return undefined;
      const values = (key ? [key] : run.scoreKeys).map((k) => run.scores[k]).filter((v): v is number => v !== undefined);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
    };
    const perThousand = costPerThousand(runs);
    lines.push(
      `| ${model} | ${pct(score("Category detection"))} | ${pct(score("Slot extraction"))} | ${pct(score("Time parsing", "exact"))} | ` +
        `${pct(score("Time parsing", "near"))} | ${pct(score("Direct name resolution", "outcome"))} | ` +
        `${seconds(percentile(runs.flatMap((r) => r.latenciesMs), 50))} | ${perThousand === null ? "—" : `$${perThousand.toFixed(2)}`} |`,
    );
  }
  return lines.join("\n");
}
