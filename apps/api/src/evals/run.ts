/**
 * Runs the agent's evals in LangSmith (§11).
 *
 *   pnpm evals                              all four datasets, compared with the latest CI run on main
 *   pnpm evals --dataset time --limit 10    the first 10 time examples, compared over the same 10
 *   pnpm evals --models a,b,c               the quality-against-cost table; never compared
 *
 * Exits 1 when a score drops more than 3 points, when too many calls error,
 * or when a label is invalid.
 */

import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { emptyState, loadDotenvFile } from "@personal-agent/core";
import { Client, type Example as LangSmithExample } from "langsmith";
import { evaluate, type EvaluationResult } from "langsmith/evaluation";
import { z } from "zod";

import { catalogueFromSeed } from "../agent/catalogue.js";
import { costUsd, usesReasoning } from "../agent/models.js";
import { understand, type Understanding, type UnderstandResult } from "../agent/understand.js";
import { modelEnvSchema, type ModelConfig } from "../env.js";
import { DATASET_KEYS, datasets, loadExamples, type Dataset, type Example, type LoadedExamples, type Scored } from "./datasets.js";
import { belowMinimum, gateReport, sweepTable, tooManyErrors, type Baseline, type DatasetRun } from "./report.js";
import { EVAL_NOW, EVAL_TIME_ZONE } from "./scoring.js";

const { values: args } = parseArgs({
  options: {
    dataset: { type: "string" },
    limit: { type: "string" },
    models: { type: "string" },
    concurrency: { type: "string", default: "8" },
  },
});

loadDotenvFile();
// evaluate() records each example as a traced run.
process.env["LANGSMITH_TRACING"] = "true";
const env = modelEnvSchema
  .extend({
    LANGSMITH_API_KEY: z.string().min(1),
    LANGSMITH_ENDPOINT: z.string().url().default("https://api.smith.langchain.com"),
    LANGSMITH_PROJECT: z.string().min(1).optional(),
  })
  .parse(process.env);

const limit = args.limit === undefined ? null : z.coerce.number().int().positive().parse(args.limit);
const concurrency = z.coerce.number().int().positive().parse(args.concurrency);
const models = args.models?.split(",").map((model) => model.trim()).filter(Boolean) ?? null;
const keys = args.dataset?.split(",").map((key) => z.enum(DATASET_KEYS).parse(key.trim())) ?? DATASET_KEYS;

const catalogue = catalogueFromSeed();
const client = new Client();

function git() {
  const run = (command: string) => {
    try {
      return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null;
    }
  };
  const dirty = !process.env["CI"] && Boolean(run("git status --porcelain"));
  const commit = process.env["GITHUB_SHA"] ?? run("git rev-parse HEAD");
  return {
    // A pull request's own branch, else the pushed branch.
    branch: process.env["GITHUB_HEAD_REF"] || process.env["GITHUB_REF_NAME"] || run("git rev-parse --abbrev-ref HEAD"),
    commit: commit && dirty ? `${commit}-dirty` : commit,
    source: process.env["CI"] ? "ci" : "local",
  };
}

/** LangSmith's REST API, for the resource tags the SDK can't read or add. */
function langsmith(method: "GET" | "POST", path: string, body?: unknown) {
  return fetch(`${env.LANGSMITH_ENDPOINT.replace(/\/$/, "")}/api${path}`, {
    method,
    headers: { "x-api-key": env.LANGSMITH_API_KEY, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * The resource tags on the app's tracing project (LANGSMITH_PROJECT), e.g.
 * Application "personal agent". LangSmith's UI can be scoped to a tag, so the
 * evals carry the same tags to show up next to the app's traces.
 */
let appTags: Promise<string[]> | undefined;
function appTagValueIds(): Promise<string[]> {
  appTags ??= (async () => {
    if (!env.LANGSMITH_PROJECT || !(await client.hasProject({ projectName: env.LANGSMITH_PROJECT }))) return [];
    const project = await client.readProject({ projectName: env.LANGSMITH_PROJECT });
    const response = await langsmith("GET", `/v1/workspaces/current/tags/resource?resource_type=project&resource_id=${project.id}`);
    if (!response.ok) throw new Error(`LangSmith tags: ${response.status} ${await response.text()}`);
    const keys = (await response.json()) as { values: { id: string }[] }[];
    return keys.flatMap((key) => key.values.map((value) => value.id));
  })();
  return appTags;
}

async function tag(resourceType: "dataset" | "experiment", resourceId: string) {
  for (const tagValueId of await appTagValueIds()) {
    const response = await langsmith("POST", "/v1/workspaces/current/taggings", {
      tag_value_id: tagValueId,
      resource_type: resourceType,
      resource_id: resourceId,
    });
    // Tagging something already tagged succeeds and changes nothing.
    if (!response.ok) {
      throw new Error(`LangSmith tagging: ${response.status} ${await response.text()}`);
    }
  }
}

/** LangSmith's copy of a dataset file, named by content hash so labels never change under a run. */
async function syncDataset(dataset: Dataset, loaded: LoadedExamples): Promise<string> {
  const name = `personal-agent ${dataset.key} ${loaded.hash}`;
  if (await client.hasDataset({ datasetName: name })) {
    let count = 0;
    for await (const _ of client.listExamples({ datasetName: name })) count += 1;
    if (count === loaded.examples.length) {
      await tag("dataset", (await client.readDataset({ datasetName: name })).id);
      return name;
    }
    // An upload that stopped halfway.
    await client.deleteDataset({ datasetName: name });
  }

  const created = await client.createDataset(name, {
    description: `${dataset.title} (§11), from apps/api/src/evals/datasets/${dataset.key}.jsonl`,
    tagValueIds: await appTagValueIds(),
  });
  for (let i = 0; i < loaded.examples.length; i += 100) {
    await client.createExamples(
      loaded.examples.slice(i, i + 100).map((example) => ({
        dataset_id: created.id,
        inputs: { message: example.message },
        outputs: { expected: example.expected },
        metadata: { id: example.id, ...(example.note ? { note: example.note } : {}) },
      })),
    );
  }
  return name;
}

/** The first `limit` examples in file order, so a limited run always covers the same ones. */
async function examplesFor(datasetName: string, loaded: LoadedExamples): Promise<LangSmithExample[]> {
  const order = new Map(loaded.examples.map((example, i) => [example.id, i]));
  const all: LangSmithExample[] = [];
  for await (const example of client.listExamples({ datasetName })) all.push(example);
  all.sort((a, b) => order.get(String(a.metadata?.["id"]))! - order.get(String(b.metadata?.["id"]))!);
  return limit === null ? all : all.slice(0, limit);
}

type TargetOutput = UnderstandResult & { latency_ms: number };

async function runDataset(dataset: Dataset, loaded: LoadedExamples, model: string, kind: "gate" | "sweep"): Promise<DatasetRun> {
  const datasetName = await syncDataset(dataset, loaded);
  const config: ModelConfig = { ...env, AGENT_MODEL: model };

  const target = async (inputs: { message: string }): Promise<TargetOutput> => {
    const started = performance.now();
    const result = await understand(config, catalogue, {
      now: EVAL_NOW,
      timeZone: EVAL_TIME_ZONE,
      state: emptyState(),
      options: [],
      orders: [],
      history: [],
      message: inputs.message,
    });
    return { ...result, latency_ms: Math.round(performance.now() - started) };
  };

  const evaluator = ({ outputs, referenceOutputs }: { outputs: Record<string, any>; referenceOutputs?: Record<string, any> }): EvaluationResult[] => {
    // A call that failed (a rate limit, say) has no outputs; it's counted as an error, not scored.
    const understanding = (outputs as Partial<TargetOutput> | undefined)?.understanding;
    if (!understanding) return [];
    return Object.entries(dataset.score(understanding, referenceOutputs?.["expected"])).map(([key, right]) => ({
      key,
      score: right ? 1 : 0,
    }));
  };

  const results = await evaluate(target, {
    data: await examplesFor(datasetName, loaded),
    evaluators: [evaluator],
    experimentPrefix: `${dataset.key}-${model}`,
    maxConcurrency: concurrency,
    client,
    metadata: {
      ...git(),
      kind,
      model,
      reasoning_effort: usesReasoning(model) ? env.AGENT_REASONING_EFFORT : null,
      dataset: dataset.key,
      limit,
    },
  });

  const scored: Scored[] = [];
  const totals = new Map<string, number>();
  let cost: number | null = 0;
  let served = model;
  const latenciesMs: number[] = [];

  for (const { run, example } of results.results) {
    const output = run.outputs as Partial<TargetOutput> | undefined;
    if (run.error || !output?.understanding) continue;

    const ours: Example = {
      id: String(example.metadata?.["id"]),
      message: String(example.inputs["message"]),
      expected: example.outputs?.["expected"],
    };
    scored.push({ example: ours, understanding: output.understanding as Understanding });
    for (const [key, right] of Object.entries(dataset.score(output.understanding, ours.expected))) {
      totals.set(key, (totals.get(key) ?? 0) + (right ? 1 : 0));
    }

    served = output.model ?? served;
    latenciesMs.push(output.latency_ms ?? 0);
    if (output.usage) {
      const callCost = costUsd(served, output.usage);
      cost = cost === null || callCost === null ? null : cost + callCost;
    }
  }

  const scores = Object.fromEntries([...totals].map(([key, total]) => [key, total / Math.max(scored.length, 1)]));
  // Kept on the experiment, where a later run finds its baseline. LangSmith's
  // own feedback_stats came back empty when listing experiments.
  await addMetadata(results.experimentName, { scores });
  await tag("experiment", (await client.readProject({ projectName: results.experimentName })).id);

  return {
    title: dataset.title,
    scoreKeys: Object.keys(dataset.minimums),
    minimums: dataset.minimums,
    experiment: results.experimentName,
    model,
    scored: scored.length,
    errors: results.results.length - scored.length,
    scores,
    costUsd: cost,
    latenciesMs,
    summary: dataset.summary(scored),
  };
}

/** Adds to an experiment's metadata, keeping what's there. */
async function addMetadata(experiment: string, fields: Record<string, unknown>) {
  const project = await client.readProject({ projectName: experiment });
  await client.updateProject(project.id, {
    projectExtra: { ...project.extra, metadata: { ...project.extra?.["metadata"], ...fields } },
  });
}

/**
 * The latest CI run on main over the same examples — same dataset version,
 * same limit — whose build passed, shown for reference next to this run's
 * scores. A failed build isn't shown as main: it never became main's state.
 */
async function mainBaseline(datasetName: string, current: string): Promise<Baseline | null> {
  const wanted = { kind: "gate", source: "ci", branch: "main", limit };
  let latest: (Baseline & { started: number }) | null = null;

  for await (const project of client.listProjects({ referenceDatasetName: datasetName, metadata: wanted })) {
    const metadata = (project.extra?.["metadata"] ?? {}) as Record<string, unknown>;
    const matches = Object.entries(wanted).every(([key, value]) => (metadata[key] ?? null) === value);
    const scores = z.record(z.number()).safeParse(metadata["scores"]);
    // A run still going, or one that errored, has no scores or verdict yet.
    if (!matches || project.name === current || !scores.success || metadata["passed"] !== true) continue;

    const started = new Date(project.start_time).getTime();
    if (!latest || started > latest.started) {
      latest = { experiment: project.name!, commit: typeof metadata["commit"] === "string" ? metadata["commit"] : null, scores: scores.data, started };
    }
  }
  return latest && { experiment: latest.experiment, commit: latest.commit, scores: latest.scores };
}

function publish(markdown: string) {
  console.log(`\n${markdown}\n`);
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryFile) appendFileSync(summaryFile, `${markdown}\n\n`);
}

async function main(): Promise<number> {
  const chosen = datasets(catalogue).filter((dataset) => keys.includes(dataset.key));
  const loaded = new Map(chosen.map((dataset) => [dataset, loadExamples(dataset)]));

  const problems = [...loaded.values()].flatMap((l) => l.problems);
  if (problems.length > 0) {
    console.error(`Fix these labels first:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    return 1;
  }

  if (models) {
    const byModel = new Map<string, DatasetRun[]>();
    for (const model of models) {
      const runs: DatasetRun[] = [];
      for (const dataset of chosen) runs.push(await runDataset(dataset, loaded.get(dataset)!, model, "sweep"));
      byModel.set(model, runs);
    }
    publish(sweepTable(byModel));
    const failed = [...byModel.values()].flat().filter(tooManyErrors);
    for (const run of failed) console.error(`${run.model} · ${run.title}: ${run.errors} errors — scores unreliable.`);
    return failed.length > 0 ? 1 : 0;
  }

  const runs: DatasetRun[] = [];
  for (const dataset of chosen) {
    const run = await runDataset(dataset, loaded.get(dataset)!, env.AGENT_MODEL, "gate");
    run.baseline = await mainBaseline(`personal-agent ${dataset.key} ${loaded.get(dataset)!.hash}`, run.experiment);
    runs.push(run);
  }

  const { branch, commit } = git();
  publish(
    gateReport(
      runs,
      `Evals: ${env.AGENT_MODEL}${usesReasoning(env.AGENT_MODEL) ? ` (${env.AGENT_REASONING_EFFORT})` : ""} on ${branch} @ ${commit?.slice(0, 7)}${limit ? ` · first ${limit} of each` : ""}`,
    ),
  );

  let failed = false;
  for (const run of runs) {
    if (tooManyErrors(run)) {
      console.error(`${run.title}: ${run.errors} of ${run.scored + run.errors} calls errored — too many to judge.`);
      failed = true;
    }
    for (const { key, score, minimum } of belowMinimum(run.scores, run.minimums)) {
      console.error(`${run.title} · ${key} is ${(score * 100).toFixed(1)}%, below its minimum of ${(minimum * 100).toFixed(1)}%.`);
      failed = true;
    }
  }
  // The build's verdict, on every experiment in it: only a passing build is shown as main.
  for (const run of runs) await addMetadata(run.experiment, { passed: !failed });
  return failed ? 1 : 0;
}

main().then(
  async (code) => {
    await client.awaitPendingTraceBatches();
    process.exit(code);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
