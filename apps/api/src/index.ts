/**
 * Express 5 server — all endpoints from App_design_spec.md §8.
 *
 * Stage 0 placeholder: the workspace wiring and env loading are proven here.
 * Stage 2 replaces this with the real app (routers, Clerk, error middleware).
 */

import { loadEnv } from "@personal-agent/core";

const env = loadEnv();

console.log(
  `[api] stage 0 placeholder — env ok (NODE_ENV=${env.NODE_ENV}, PORT=${env.PORT})`,
);
