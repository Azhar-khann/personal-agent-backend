import { z } from "zod";

import { HttpError } from "./http.js";

const OnboardingSchema = z.object({
  fields: z.array(
    z.object({
      key: z.string(),
      type: z.enum(["bool", "text", "number", "select"]),
      label: z.string(),
      required: z.boolean(),
      options: z.array(z.string()).optional(),
    }),
  ),
});

/**
 * Checks a business's answers against its category's onboarding_schema (§3)
 * and returns the answers to store in businesses.attributes. Throws a 400
 * listing every problem. Keys the category doesn't ask about are rejected.
 */
export function assertValidAttributes(
  onboardingSchema: unknown,
  input: Record<string, unknown>,
): Record<string, unknown> {
  // Seed data we control; a parse failure here is our bug, so it surfaces as a 500.
  const { fields } = OnboardingSchema.parse(onboardingSchema);

  const problems: { path: string; message: string }[] = [];
  const answers: Record<string, unknown> = {};
  const problem = (key: string, message: string) =>
    problems.push({ path: `attributes.${key}`, message });

  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) problem(key, "not a question for this category");
  }

  for (const field of fields) {
    const answer = input[field.key];

    if (answer === undefined || answer === null || answer === "") {
      if (field.required) problem(field.key, "required");
      continue;
    }

    const valid =
      field.type === "bool"
        ? typeof answer === "boolean"
        : field.type === "number"
          ? typeof answer === "number" && Number.isFinite(answer)
          : field.type === "text"
            ? typeof answer === "string" && answer.length <= 500
            : typeof answer === "string" && (field.options ?? []).includes(answer);

    if (!valid) {
      problem(
        field.key,
        field.type === "bool"
          ? "must be true or false"
          : field.type === "number"
            ? "must be a number"
            : field.type === "text"
              ? "must be text of at most 500 characters"
              : `must be one of: ${(field.options ?? []).join(", ")}`,
      );
      continue;
    }

    answers[field.key] = answer;
  }

  if (problems.length > 0) {
    throw new HttpError(400, "invalid_request", "Request validation failed", problems);
  }
  return answers;
}
