/**
 * Worker process — the five scheduled jobs from App_design_spec.md §9.
 *
 * Stage 0 placeholder: proves the workspace wiring and env loading.
 * Stage 7 replaces this with the real BullMQ workers.
 */

import { loadEnv } from "@personal-agent/core";

const env = loadEnv();

console.log(
  `[worker] stage 0 placeholder — env ok (NODE_ENV=${env.NODE_ENV}, redis configured)`,
);
