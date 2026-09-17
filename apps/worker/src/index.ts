/**
 * The worker (§2, §9): runs background jobs from Redis. Scheduled jobs are
 * registered here on start; order.event jobs are added by the API and core as
 * orders change.
 */

import {
  BUSINESS_TIME_ZONE,
  closeDb,
  closeQueue,
  completeFinishedOrders,
  createRedis,
  enqueueOrderEvents,
  getDb,
  getQueue,
  JOBS,
  nudgeDueReminders,
  QUEUE_NAME,
  recomputeStats,
  remindUpcomingAppointments,
  staleUndeliveredEventIds,
  type JobName,
} from "@personal-agent/core";
import { Worker, type Job, type RepeatOptions } from "bullmq";
import { pino } from "pino";

import { deliverEvent } from "./deliver-event.js";
import { loadWorkerEnv } from "./env.js";
import { createPushSender, prunePushSubscriptions } from "./push.js";

const env = loadWorkerEnv();
const logger = pino({ level: env.LOG_LEVEL });
const sendPush = createPushSender(env, logger);

const SCHEDULES: { name: JobName; repeat: Omit<RepeatOptions, "key"> }[] = [
  { name: JOBS.appointmentsSweep, repeat: { every: 60_000 } },
  { name: JOBS.eventsSweep, repeat: { every: 60_000 } },
  // Morning rather than overnight, so a nudge arrives when people are up.
  { name: JOBS.remindersScan, repeat: { pattern: "0 9 * * *", tz: BUSINESS_TIME_ZONE } },
  { name: JOBS.statsRecompute, repeat: { pattern: "30 3 * * *", tz: BUSINESS_TIME_ZONE } },
  { name: JOBS.pushPrune, repeat: { pattern: "0 4 * * 0", tz: BUSINESS_TIME_ZONE } },
];

async function run(job: Job): Promise<unknown> {
  switch (job.name as JobName) {
    case JOBS.deliverEvent:
      return deliverEvent((job.data as { eventId: string }).eventId, sendPush);
    case JOBS.appointmentsSweep:
      return { reminded: await remindUpcomingAppointments(), completed: await completeFinishedOrders() };
    case JOBS.eventsSweep: {
      const stale = await staleUndeliveredEventIds();
      await enqueueOrderEvents(stale);
      return { requeued: stale.length };
    }
    case JOBS.remindersScan:
      return { nudged: await nudgeDueReminders() };
    case JOBS.statsRecompute:
      return { businesses: await recomputeStats(getDb()) };
    case JOBS.pushPrune:
      return { deleted: await prunePushSubscriptions() };
    default:
      throw new Error(`unknown job ${job.name}`);
  }
}

/** A job result worth logging at info: anything that did something. */
function didSomething(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return Object.values(result).some((value) => (typeof value === "number" ? value > 0 : value !== null));
}

async function main() {
  const queue = getQueue();
  await queue.waitUntilReady();
  for (const { name, repeat } of SCHEDULES) {
    await queue.upsertJobScheduler(name, repeat, { name, opts: { removeOnComplete: true, removeOnFail: 100 } });
  }

  const worker = new Worker(QUEUE_NAME, run, { connection: createRedis("worker"), concurrency: 5 });
  worker.on("completed", (job, result) => {
    const level = job.name === JOBS.deliverEvent || didSomething(result) ? "info" : "debug";
    logger[level]({ job: job.name, id: job.id, result }, "job completed");
  });
  worker.on("failed", (job, error) => logger.error({ job: job?.name, id: job?.id, err: error }, "job failed"));
  worker.on("error", (error) => logger.error({ err: error }, "worker error"));
  logger.info({ schedules: SCHEDULES.map((s) => s.name) }, "worker started");

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, "shutting down");
    await worker.close();
    await closeQueue();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  logger.error({ err: error }, "worker failed to start");
  process.exit(1);
});
