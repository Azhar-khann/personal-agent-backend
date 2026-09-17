/**
 * Background work (§9): one BullMQ queue on Redis, jobs told apart by name.
 * The API and core add jobs; apps/worker runs them.
 */

import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

import { loadEnv } from "./env.js";

export const QUEUE_NAME = "personal-agent";

export const JOBS = {
  /** Deliver one order_events row: push to the business, message the user. */
  deliverEvent: "order.event",
  /** Every minute: reminders an hour before, completion after the appointment. */
  appointmentsSweep: "appointments.sweep",
  /** Every minute: re-enqueue events whose delivery job was lost. */
  eventsSweep: "events.sweep",
  /** Nightly: nudge users about recurring services coming due. */
  remindersScan: "reminders.scan",
  /** Nightly: rebuild business_stats in case the live counters drifted. */
  statsRecompute: "stats.recompute",
  /** Weekly: delete push subscriptions that keep failing. */
  pushPrune: "push.prune",
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

/** Retried with backoff; removed when done, so a sweep can enqueue the same event again. */
const DELIVERY_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: true,
};

/**
 * Redis clients are built here and handed to BullMQ, rather than giving BullMQ
 * connection options: BullMQ 6 treats ioredis as optional and, running as
 * native ESM (the built apps), can't load it from options.
 *
 * - "producer": for adding jobs. Commands fail fast while Redis is down rather
 *   than piling up in memory — whatever was being enqueued is already
 *   committed, and a sweep picks it up.
 * - "worker": BullMQ requires maxRetriesPerRequest null for its blocking reads.
 */
export function createRedis(role: "producer" | "worker"): Redis {
  const client = new Redis(
    loadEnv().REDIS_URL,
    role === "producer" ? { enableOfflineQueue: false } : { maxRetriesPerRequest: null },
  );
  // Without a listener an 'error' event would crash the process; ioredis keeps
  // reconnecting on its own.
  let reported = false;
  client.on("error", (error) => {
    if (reported) return;
    reported = true;
    console.warn(`redis (${role}): ${error.message} (further errors on this connection are not logged)`);
  });
  client.on("ready", () => {
    reported = false;
  });
  return client;
}

let queue: Queue | undefined;

/** The queue, for adding jobs. */
export function getQueue(): Queue {
  if (queue) return queue;
  queue = new Queue(QUEUE_NAME, { connection: createRedis("producer") });
  queue.on("error", () => {
    // Reported once by the connection's own listener.
  });
  return queue;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Asks the worker to deliver events, right after the transaction that wrote
 * them commits. Never throws: if Redis is unreachable the events stay
 * undelivered in the database, and the worker's events sweep delivers them.
 */
export async function enqueueOrderEvents(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  try {
    const q = getQueue();
    await withTimeout(q.waitUntilReady(), 2_000);
    await q.addBulk(
      eventIds.map((eventId) => ({
        name: JOBS.deliverEvent,
        data: { eventId },
        // BullMQ job ids can't contain ':'.
        opts: { ...DELIVERY_OPTIONS, jobId: `event-${eventId}` },
      })),
    );
  } catch (error) {
    console.warn(
      `could not enqueue order events ${eventIds.join(", ")}; the events sweep will deliver them: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function closeQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = undefined;
  }
}
