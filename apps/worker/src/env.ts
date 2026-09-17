import { loadEnv, type Env } from "@personal-agent/core";
import { z } from "zod";

const workerEnvSchema = z.object({
  VAPID_PUBLIC_KEY: z.string().min(1),
  VAPID_PRIVATE_KEY: z.string().min(1),
  // A contact the push services can reach.
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/, "must be a mailto: or https:// URL"),
});

export type WorkerEnv = Env & z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(): WorkerEnv {
  const base = loadEnv();
  const parsed = workerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid worker environment configuration:\n${problems}`);
  }
  return { ...base, ...parsed.data };
}
