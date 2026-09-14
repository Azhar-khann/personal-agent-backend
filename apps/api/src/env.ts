import { loadEnv, type Env } from "@personal-agent/core";
import { z } from "zod";

const apiEnvSchema = z.object({
  // Read by @clerk/express straight from process.env; validated here only so
  // a missing key fails at boot instead of on the first signed-in request.
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),

  // The frontend is a separate deployment, so browsers call this API
  // cross-origin. Comma-separated.
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
});

export type ApiEnv = Env & z.infer<typeof apiEnvSchema>;

let cached: ApiEnv | undefined;

export function loadApiEnv(): ApiEnv {
  if (cached) return cached;

  // Validates the shared variables and loads .env into process.env.
  const base = loadEnv();

  const parsed = apiEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid API environment configuration:\n${problems}`);
  }

  cached = { ...base, ...parsed.data };
  return cached;
}
