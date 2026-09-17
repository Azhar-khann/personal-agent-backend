import { clerkMiddleware } from "@clerk/express";
import cors from "cors";
import express from "express";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";

import { requireUser } from "./auth.js";
import type { ApiEnv } from "./env.js";
import { errorHandler, notFound } from "./http.js";
import { adminRouter } from "./routes/admin.js";
import { businessRouter } from "./routes/business.js";
import { categoriesRouter } from "./routes/categories.js";
import { chatRouter } from "./routes/chat.js";
import { meRouter } from "./routes/me.js";
import { ordersRouter } from "./routes/orders.js";
import { searchesRouter } from "./routes/searches.js";

export function createApp(env: ApiEnv, logger: Logger) {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    pinoHttp({
      logger,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    }),
  );
  app.use(cors({ origin: env.CORS_ORIGINS }));
  app.use(express.json({ limit: "100kb" }));
  // Reads the Clerk session token if present. Rejects nothing by itself.
  app.use(clerkMiddleware());

  // Public
  app.use("/api/categories", categoriesRouter);

  // User app
  app.use("/api/me", requireUser, meRouter);
  app.use("/api/chat", requireUser, chatRouter(env));
  app.use("/api/searches", requireUser, searchesRouter);
  app.use("/api/orders", requireUser, ordersRouter);

  // Business app
  app.use("/api/business", requireUser, businessRouter);

  // Admin
  app.use("/api/admin", requireUser, adminRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
