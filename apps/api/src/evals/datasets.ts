/**
 * The four §11 datasets. The labelled examples live in ./datasets as JSON
 * Lines, one example per line, reviewed in git like code. LangSmith gets a copy
 * named by content hash, so a run always says which labels it was scored on.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

import type { Catalogue } from "../agent/catalogue.js";
import type { Understanding } from "../agent/understand.js";
import {
  CategoryExpected,
  categoryOutcome,
  expectedCategoryLabel,
  FixtureBusiness,
  LocalWindow,
  NameExpected,
  resolveName,
  scoreCategory,
  scoreName,
  scoreSlots,
  scoreTime,
  searchedWindow,
  SlotExpected,
  TimeExpected,
  topConfusions,
  wantedWindows,
} from "./scoring.js";

const DIR = new URL("./datasets/", import.meta.url);

export const DATASET_KEYS = ["category", "slots", "time", "names"] as const;
export type DatasetKey = (typeof DATASET_KEYS)[number];

export type Example = { id: string; message: string; expected: unknown; note?: string };

/** One scored example, for a dataset's summary lines. */
export type Scored = { example: Example; understanding: Understanding };

export type Dataset = {
  key: DatasetKey;
  title: string;
  /** §11's size. */
  size: number;
  /** Score keys, each 0 or 1 per example; the gate compares every one. */
  scoreKeys: string[];
  /** Problems with the labels themselves — unknown ids, windows the agent would reject. */
  check(expected: unknown): string[];
  score(understanding: Understanding, expected: unknown): Record<string, boolean>;
  /** Extra lines under the scores, e.g. the confusion pairs. */
  summary(rows: Scored[]): string[];
};

const ExampleLine = z
  .object({ id: z.string().min(1), message: z.string().min(1), expected: z.unknown(), note: z.string().optional() })
  .strict();

export function readDirectory(): FixtureBusiness[] {
  return z.array(FixtureBusiness).parse(JSON.parse(readFileSync(new URL("businesses.json", DIR), "utf8")));
}

function windowProblems(window: z.infer<typeof LocalWindow>): string[] {
  return searchedWindow(window) ? [] : [`window ${window.start}–${window.end} would be rejected at the eval's now`];
}

export function datasets(catalogue: Catalogue, directory = readDirectory()): Dataset[] {
  const unknownService = (id: string | null) => (id && !catalogue.service(id) ? [`unknown service ${id}`] : []);
  const unknownCategory = (id: string) => (catalogue.category(id) ? [] : [`unknown category ${id}`]);
  const percent = (part: number, whole: number) => `${Math.round((part / Math.max(whole, 1)) * 100)}%`;

  const category: Dataset = {
    key: "category",
    title: "Category detection",
    size: 200,
    scoreKeys: ["correct"],
    check(value) {
      const expected = CategoryExpected.parse(value);
      if ("category" in expected) return unknownCategory(expected.category);
      if ("ask" in expected) return expected.ask.flatMap(unknownCategory);
      return [];
    },
    score: (u, value) => ({ correct: scoreCategory(u, CategoryExpected.parse(value), catalogue) }),
    summary(rows) {
      const pairs = rows.map(({ example, understanding }) => ({
        expected: expectedCategoryLabel(CategoryExpected.parse(example.expected)),
        got: categoryOutcome(understanding, catalogue),
      }));
      const confusions = topConfusions(pairs, 8);
      return confusions.length === 0
        ? ["No confusions."]
        : ["Most confused (expected → got):", ...confusions.map(({ pair, count }) => `  ${pair} ×${count}`)];
    },
  };

  const slots: Dataset = {
    key: "slots",
    title: "Slot extraction",
    size: 150,
    scoreKeys: ["service", "window", "location", "address", "budget", "notes", "details"],
    check(value) {
      const expected = SlotExpected.parse(value);
      const service = catalogue.service(expected.service_id);
      const optional = service ? catalogue.category(service.categoryId)!.optional : [];
      return [
        ...unknownService(expected.service_id),
        ...(expected.window ? windowProblems(expected.window) : []),
        ...Object.keys(expected.details).flatMap((key) =>
          optional.includes(key) ? [] : [`detail ${key} isn't an optional detail of the service's category`],
        ),
      ];
    },
    score: (u, value) => scoreSlots(u, SlotExpected.parse(value)),
    summary: () => [],
  };

  const time: Dataset = {
    key: "time",
    title: "Time parsing",
    size: 100,
    scoreKeys: ["exact", "near"],
    check(value) {
      return (wantedWindows(TimeExpected.parse(value)) ?? []).flatMap(windowProblems);
    },
    score: (u, value) => scoreTime(u, TimeExpected.parse(value)),
    summary(rows) {
      const missed = rows.filter(({ example, understanding }) => !scoreTime(understanding, TimeExpected.parse(example.expected)).near);
      return missed.length === 0
        ? ["No windows off by more than an hour."]
        : [
            "Off by more than an hour:",
            ...missed.slice(0, 10).map(({ example, understanding }) => {
              const got = understanding.time_window;
              return `  ${example.id} "${example.message}" → ${got ? `${got.start}–${got.end}` : "none"}`;
            }),
          ];
    },
  };

  const names: Dataset = {
    key: "names",
    title: "Direct name resolution",
    size: 60,
    scoreKeys: ["outcome", "named"],
    check(value) {
      const expected = NameExpected.parse(value);
      return expected.business && !directory.some((business) => business.id === expected.business)
        ? [`unknown fixture business ${expected.business}`]
        : [];
    },
    score: (u, value) => scoreName(u, NameExpected.parse(value), catalogue, directory),
    summary(rows) {
      const byOutcome = new Map<string, { right: number; total: number }>();
      const wrong: string[] = [];
      for (const { example, understanding } of rows) {
        const expected = NameExpected.parse(example.expected);
        const tally = byOutcome.get(expected.outcome) ?? { right: 0, total: 0 };
        const right = scoreName(understanding, expected, catalogue, directory).outcome;
        byOutcome.set(expected.outcome, { right: tally.right + (right ? 1 : 0), total: tally.total + 1 });
        if (!right) {
          const got = resolveName(understanding, catalogue, directory);
          wrong.push(`  ${example.id} expected ${expected.outcome}${expected.business ? ` ${expected.business}` : ""}, got ${got.outcome}${got.business ? ` ${got.business}` : ""}`);
        }
      }
      return [
        "By outcome:",
        ...[...byOutcome.entries()].map(([outcome, { right, total }]) => `  ${outcome}: ${right}/${total} (${percent(right, total)})`),
        ...(wrong.length ? ["Wrong:", ...wrong.slice(0, 10)] : []),
      ];
    },
  };

  return [category, slots, time, names];
}

export type LoadedExamples = { examples: Example[]; hash: string; problems: string[] };

/** Reads a dataset's file, checking every line; problems are returned, not thrown, so all show at once. */
export function loadExamples(dataset: Dataset): LoadedExamples {
  const text = readFileSync(new URL(`${dataset.key}.jsonl`, DIR), "utf8");
  // The fixture directory is part of what the name labels mean.
  const hashed = dataset.key === "names" ? text + readFileSync(new URL("businesses.json", DIR), "utf8") : text;

  const examples: Example[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const where = `${dataset.key}.jsonl:${i + 1}`;
    try {
      const example: Example = ExampleLine.parse(JSON.parse(line)) as Example;
      if (ids.has(example.id)) problems.push(`${where} duplicate id ${example.id}`);
      ids.add(example.id);
      problems.push(...dataset.check(example.expected).map((problem) => `${where} ${problem}`));
      examples.push(example);
    } catch (error) {
      const message = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") : String(error);
      problems.push(`${where} ${message}`);
    }
  });

  return { examples, hash: createHash("sha256").update(hashed).digest("hex").slice(0, 12), problems };
}
