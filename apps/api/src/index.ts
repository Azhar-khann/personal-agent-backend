import { closeDb } from "@personal-agent/core";
import { pino } from "pino";

import { createApp } from "./app.js";
import { loadApiEnv } from "./env.js";

const env = loadApiEnv();
const logger = pino({ level: env.LOG_LEVEL });
const app = createApp(env, logger);

const server = app.listen(env.PORT, (error) => {
  if (error) throw error;
  logger.info({ port: env.PORT }, "api listening");
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void closeDb().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
