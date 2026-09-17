/**
 * §11's product numbers, read from the database.
 *
 *   pnpm metrics             the last 30 days
 *   pnpm metrics --days 7
 *
 * Searches count by their latest state: one that found nothing and was then
 * refined into a list counts as presented.
 */

import { parseArgs } from "node:util";

import { closeDb, getSql } from "@personal-agent/core";
import { z } from "zod";

import { costUsd } from "./agent/models.js";

const { values } = parseArgs({ options: { days: { type: "string", default: "30" } } });
const days = z.coerce.number().int().positive().parse(values.days);

const MODE_LABELS: Record<string, string> = {
  search: "the agent searched",
  direct: "the user named a business",
  reminder: "started from a reminder",
};

const share = (part: number, whole: number) => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);
const minutes = (seconds: number | null) => (seconds === null ? "—" : `${(seconds / 60).toFixed(1)} min`);

async function main() {
  const sql = getSql();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const byMode = await sql<{ mode: string; searched: number; booked: number }[]>`
    SELECT mode,
           count(*)::int AS searched,
           count(*) FILTER (WHERE status = 'booked')::int AS booked
    FROM searches
    WHERE created_at >= ${since}::timestamptz AND status <> 'gathering'
    GROUP BY mode ORDER BY mode`;

  const [outcomes] = await sql<{ searched: number; booked: number; no_free_times: number; nobody_nearby: number; conflicts: number }[]>`
    SELECT count(*)::int AS searched,
           count(*) FILTER (WHERE status = 'booked')::int AS booked,
           count(*) FILTER (WHERE status = 'no_results' AND businesses_matched > 0)::int AS no_free_times,
           count(*) FILTER (WHERE status = 'no_results' AND businesses_matched = 0)::int AS nobody_nearby,
           coalesce(sum(slot_conflicts), 0)::int AS conflicts
    FROM searches
    WHERE created_at >= ${since}::timestamptz AND status <> 'gathering'`;

  // From the request's first message: the first user message after the
  // conversation's previous search was last touched.
  const [timing] = await sql<{ bookings: number; median_s: number | null; p90_s: number | null }[]>`
    SELECT count(*)::int AS bookings,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM took)) AS median_s,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM took)) AS p90_s
    FROM (
      SELECT o.created_at - (
               SELECT min(m.created_at) FROM messages m
               WHERE m.conversation_id = s.conversation_id
                 AND m.role = 'user'
                 AND m.created_at > coalesce(
                   (SELECT max(p.updated_at) FROM searches p
                    WHERE p.conversation_id = s.conversation_id AND p.created_at < s.created_at),
                   '-infinity'::timestamptz)
             ) AS took
      FROM orders o
      JOIN searches s ON s.id = o.search_id
      WHERE o.created_at >= ${since}::timestamptz
    ) t
    WHERE took IS NOT NULL`;

  const positions = await sql<{ rank: number; picked: number }[]>`
    SELECT rank, count(*)::int AS picked
    FROM search_options
    WHERE selected_at >= ${since}::timestamptz
    GROUP BY rank ORDER BY rank`;

  const [reminders] = await sql<{ nudges: number; booked: number }[]>`
    SELECT (SELECT count(*)::int FROM messages
            WHERE metadata->>'kind' = 'reminder_nudge' AND created_at >= ${since}::timestamptz) AS nudges,
           (SELECT count(*)::int FROM searches
            WHERE mode = 'reminder' AND status = 'booked' AND created_at >= ${since}::timestamptz) AS booked`;

  const usage = await sql<{ model: string; input_tokens: string; cached_input_tokens: string; output_tokens: string; messages: number }[]>`
    SELECT metadata->>'model' AS model,
           sum((metadata->'usage'->>'inputTokens')::bigint) AS input_tokens,
           -- Messages from before cached tokens were recorded count as uncached.
           sum(coalesce((metadata->'usage'->>'cachedInputTokens')::bigint, 0)) AS cached_input_tokens,
           sum((metadata->'usage'->>'outputTokens')::bigint) AS output_tokens,
           count(*)::int AS messages
    FROM messages
    WHERE role = 'assistant'
      AND jsonb_typeof(metadata->'usage') = 'object'
      AND created_at >= ${since}::timestamptz
    GROUP BY 1`;

  const [orderCount] = await sql<{ orders: number }[]>`
    SELECT count(*)::int AS orders FROM orders WHERE created_at >= ${since}::timestamptz`;

  let cost: number | null = 0;
  for (const row of usage) {
    const rowCost = costUsd(row.model, {
      inputTokens: Number(row.input_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens: Number(row.output_tokens),
    });
    cost = cost === null || rowCost === null ? null : cost + rowCost;
  }
  const agentMessages = usage.reduce((sum, row) => sum + row.messages, 0);
  const picked = positions.reduce((sum, row) => sum + row.picked, 0);
  const o = outcomes!;

  const lines = [
    `## Product numbers: last ${days} days`,
    "",
    "| Measure | Value |",
    "|---|---|",
    `| Booking rate | ${share(o.booked, o.searched)} (${o.booked} of ${o.searched} searches) |`,
    ...byMode.map((row) => `| · ${MODE_LABELS[row.mode] ?? row.mode} | ${share(row.booked, row.searched)} (${row.booked} of ${row.searched}) |`),
    `| First message to booking | median ${minutes(timing!.median_s)}, p90 ${minutes(timing!.p90_s)} (${timing!.bookings} bookings) |`,
    ...positions.map((row) => `| Picked option ${row.rank} | ${share(row.picked, picked)} (${row.picked}) |`),
    `| Businesses found but no free times | ${share(o.no_free_times, o.searched)} (${o.no_free_times}); nobody nearby ${share(o.nobody_nearby, o.searched)} (${o.nobody_nearby}) |`,
    `| Booking attempts that hit a taken time (409) | ${share(o.conflicts, o.conflicts + o.booked)} (${o.conflicts}) |`,
    `| Reminder nudges that became bookings | ${share(reminders!.booked, reminders!.nudges)} (${reminders!.booked} of ${reminders!.nudges}) |`,
    `| Agent cost per booking | ${cost === null ? "unknown model price" : orderCount!.orders === 0 ? "—" : `$${(cost / orderCount!.orders).toFixed(3)}`} ($${cost?.toFixed(2) ?? "?"} over ${agentMessages} messages, ${orderCount!.orders} bookings) |`,
  ];
  console.log(lines.join("\n"));
}

main()
  .then(() => closeDb())
  .catch(async (error) => {
    console.error(error);
    await closeDb();
    process.exit(1);
  });
