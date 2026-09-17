import { loadEnv, type Env } from "@personal-agent/core";
import { z } from "zod";

/** What the agent's model call needs; the evals load only this. */
export const modelEnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  // The agent makes one structured model call per chat message. Overridable,
  // so the evals can compare models.
  AGENT_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  // Ignored for a model that doesn't reason (agent/models.ts).
  AGENT_REASONING_EFFORT: z.enum(["minimal", "low", "medium", "high"]).default("low"),
});

export type ModelConfig = z.infer<typeof modelEnvSchema>;

const apiEnvSchema = modelEnvSchema.extend({
  // Read by @clerk/express straight from process.env; validated here only so
  // a missing key fails at boot instead of on the first signed-in request.
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),

  // Handed to staff browsers so they can subscribe to push; the worker holds the private key.
  VAPID_PUBLIC_KEY: z.string().min(1),

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
