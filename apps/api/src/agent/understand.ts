import { describeNow, formatWindow, toLocal, type AgentState } from "@personal-agent/core";
import { wrapOpenAI } from "langsmith/wrappers/openai";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import type { ModelConfig } from "../env.js";
import { usesReasoning, type TokenUsage } from "./models.js";
import type { SearchViewOption } from "../search-view.js";
import type { Catalogue } from "./catalogue.js";
import type { UpcomingOrder } from "./lookups.js";
import { lettersAndDigits } from "./names.js";

/**
 * What one user message means, from a single structured model call.
 *
 * The spec's §4 splits this into four sequential calls (route, category,
 * slots, time). Measured at ~2.5s for even a tiny call, four would take 10s+
 * against the spec's ~3s target, and each needs the whole conversation anyway.
 * One call returns them together — and they can't contradict each other.
 * Everything after it (validating the window, resolving a named business,
 * choosing the question, searching, booking) is code.
 *
 * Structured outputs need every field present, so "not stated" is null.
 */
export const Understanding = z.object({
  intent: z.enum(["request", "select_option", "manage_booking", "stop", "other"]),
  starts_new_request: z.boolean(),
  category_id: z.string().nullable(),
  category_candidates: z.array(z.string()),
  service_id: z.string().nullable(),
  business_name: z.string().nullable(),
  choice_number: z.number().int().nullable(),
  time_window: z.object({ start: z.string(), end: z.string() }).nullable(),
  location: z.enum(["at_business", "at_customer"]).nullable(),
  address: z.string().nullable(),
  budget_max_aed: z.number().nullable(),
  notes: z.string().nullable(),
  details: z.array(z.object({ key: z.string(), value: z.string() })),
  option_number: z.number().int().nullable(),
  option_time: z.string().nullable(),
  order_number: z.number().int().nullable(),
  booking_action: z.enum(["cancel", "reschedule"]).nullable(),
  reply: z.string().nullable(),
});

export type Understanding = z.infer<typeof Understanding>;

/** Everything the model sees besides the catalogue. */
export type UnderstandContext = {
  now: Date;
  timeZone: string;
  state: AgentState;
  options: SearchViewOption[];
  orders: UpcomingOrder[];
  history: { role: string; content: string }[];
  message: string;
};

let client: OpenAI | undefined;

/** Traced by LangSmith: each call shows up with its model, prompt and token usage. */
function openai(env: ModelConfig) {
  client ??= wrapOpenAI(new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: 20_000, maxRetries: 1 }));
  return client;
}

/** The stable part of the prompt, first, so the provider can cache it across messages. */
function instructions(catalogue: Catalogue): string {
  const categories = catalogue.categories.flatMap((category) => [
    `- ${category.id} (${category.name})${category.agentHints ? `: ${category.agentHints}` : ""}`,
    `  services: ${category.services
      .map((service) => `${service.id} = ${service.name}${service.aliases.length ? ` [${service.aliases.join(", ")}]` : ""}`)
      .join("; ")}`,
    ...(category.optional.filter((key) => key !== "budget_max" && key !== "notes").length
      ? [`  optional details: ${category.optional.filter((key) => key !== "budget_max" && key !== "notes").join(", ")}`]
      : []),
  ]);

  return `You read one message in a chat where a user books local services in the UAE, and return what it means as structured data. You never write what the user sees, except "reply" for intent "other".

Intents:
- request: the user asks for a service, answers the assistant's question — including picking one of its numbered choices — or changes something about the current request. "Actually make it 4pm" changes the current request's time; it is not a new request.
- select_option: the user picks one of the options on screen, e.g. "book the second one at 2:30". Not for the assistant's numbered choices.
- manage_booking: the user wants to cancel or reschedule a booking listed under upcoming bookings. "Cancel my AC service" or "cancel Friday's appointment" is manage_booking when such a booking exists.
- stop: the user drops a request that hasn't been booked, e.g. "never mind".
- other: anything else. Put a reply of one or two sentences in "reply" and steer back to booking; you are not a general assistant.

Rules:
- Fill only what the latest message states or changes. Leave every other field JSON null (never the text "null") or empty: the current request keeps its values.
- starts_new_request is true only when the user wants a different job from the current request. A new time, place or budget for the same job is not new.
- category_id and service_id must be ids from the catalogue. Match the user's words against service names and aliases. Set service_id only when the user says which service.
- If the job could belong to more than one category and the message doesn't settle it — a leak could need a plumber or a handyman — leave category_id null and put the likely ids in category_candidates. Never guess between them.
- If the request is too vague to tell ("fix something at my place"), list every category that could fit in category_candidates.
- Only when nothing in the catalogue could fit (a flight, a lawyer), leave category_id null and category_candidates empty.
- business_name: only when the user names a specific business.
- choice_number: when the assistant's last message offered numbered choices and the user picks one, by number or by describing it ("the Al Barsha one"). Then leave business_name and category_id null.
- location: "at_customer" when the user wants the work done at their place, "at_business" when they'll go to the business, null when unsaid. address: only an address the user states.
- budget_max_aed: the most the user said they'll pay, in AED. notes: any other instruction for the business, e.g. "call when you're outside" or "the building has no parking".
- details: answers to the category's optional details, as key/value pairs.
- option_number and option_time: the option's number and the chosen offered time, copied exactly from the options on screen.
- order_number: the upcoming booking's number, when it's clear which one.

Time windows are always a range, in the user's local time, formatted YYYY-MM-DDTHH:MM. Work dates out from the current date and weekday you're given:
- a specific time ("3pm tomorrow"): 15 minutes either side, 14:45 to 15:15
- "morning": 08:00–12:00. "afternoon": 12:00–17:00. "evening": 17:00–21:00. "tonight": 18:00–23:59
- a day with no time ("Saturday"): 00:00–23:59 that day
- "this week sometime": now until Sunday 23:59
- "asap" or "now": now until four hours from now
- no time mentioned: null

Catalogue:
${categories.join("\n")}`;
}

/** The part that changes every message. */
function situation(context: UnderstandContext, catalogue: Catalogue): string {
  const { state, timeZone } = context;
  const lines: string[] = [`Now: ${describeNow(context.now, timeZone)} (${timeZone})`, ""];

  if (state.categoryId || state.businessName || state.window) {
    const service = catalogue.service(state.serviceId);
    const window = state.window
      ? formatWindow(new Date(state.window.start), new Date(state.window.end), timeZone)
      : "not given";
    lines.push(
      "Current request:",
      `  category: ${state.categoryId ?? "unknown"}, service: ${service?.id ?? "unknown"}, when: ${window}`,
      `  business named: ${state.businessName ?? "none"}, location: ${state.locationMode ?? "unsaid"}, budget: ${state.budgetMaxAed ?? "none"}`,
      "",
    );
  } else {
    lines.push("Current request: none", "");
  }

  if (state.pendingChoice) {
    lines.push(
      "Numbered choices the assistant just offered:",
      ...state.pendingChoice.labels.map((label, i) => `  ${i + 1}. ${label}`),
      "",
    );
  }

  if (context.options.length > 0) {
    lines.push(
      "Options on screen:",
      ...context.options.map(
        (option) =>
          `  ${option.rank}. ${option.business.name} — ${option.service.displayName} — times: ${option.offeredSlots
            .map((slot) => toLocal(slot, timeZone))
            .join(", ")}`,
      ),
      "",
    );
  }

  if (context.orders.length > 0) {
    lines.push(
      "Upcoming bookings:",
      ...context.orders.map(
        (order, i) =>
          `  ${i + 1}. ${order.business.name} — ${order.service.displayName} — ${toLocal(order.appointments[0]!.scheduledAt, timeZone)}`,
      ),
      "",
    );
  }

  if (context.history.length > 0) {
    lines.push("Conversation so far:", ...context.history.map((m) => `  ${m.role}: ${m.content}`), "");
  }

  lines.push("Latest message:", context.message);
  return lines.join("\n");
}

/**
 * The model occasionally writes a placeholder where it means null — seen in
 * testing as business_name ":null", which read as a business called "null".
 * Anything that is only such a word counts as not given.
 */
function given(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  // Letters only, so ":null", "/null" and "N/A" all reduce to the bare word.
  const bare = trimmed.toLowerCase().replace(/[^a-z]/g, "");
  return bare === "" || ["null", "none", "na", "undefined", "unknown"].includes(bare) ? null : trimmed;
}

/**
 * The same for numbers: seen in the evals as budget_max_aed 0 for a message
 * with no budget. No budget is 0 AED, and choices, options and orders are
 * numbered from 1.
 */
const positive = (value: number | null) => (value !== null && value > 0 ? value : null);

export function withoutPlaceholders(u: Understanding): Understanding {
  return {
    ...u,
    budget_max_aed: positive(u.budget_max_aed),
    choice_number: positive(u.choice_number),
    option_number: positive(u.option_number),
    order_number: positive(u.order_number),
    category_id: given(u.category_id),
    category_candidates: u.category_candidates.flatMap((id) => given(id) ?? []),
    service_id: given(u.service_id),
    business_name: given(u.business_name),
    address: given(u.address),
    notes: given(u.notes),
    details: u.details.flatMap(({ key, value }) => (given(key) && given(value) ? [{ key, value: value.trim() }] : [])),
    option_time: given(u.option_time),
    reply: given(u.reply),
  };
}

/**
 * Which numbered choice the model meant when it copied a choice's label
 * instead of giving its number — seen in testing: "the Al Barsha one" came
 * back as business_name "Kings Barbers — Al Barsha 1". An exact label, or text
 * found in exactly one label, counts. Anything matching several ("Kings
 * Barbers") doesn't, so the question is asked again.
 */
export function choiceFromLabel(labels: string[], u: Understanding): number | null {
  const typed = [u.business_name, u.category_id].flatMap((value) => (value ? [lettersAndDigits(value)] : []));
  const normalized = labels.map(lettersAndDigits);

  const exact = normalized.findIndex((label) => typed.includes(label));
  if (exact >= 0) return exact + 1;

  const containing = normalized.flatMap((label, i) =>
    typed.some((text) => text.length >= 3 && label.includes(text)) ? [i] : [],
  );
  return containing.length === 1 ? containing[0]! + 1 : null;
}

export type UnderstandResult = {
  understanding: Understanding;
  model: string;
  usage: TokenUsage | null;
};

export async function understand(
  env: ModelConfig,
  catalogue: Catalogue,
  context: UnderstandContext,
): Promise<UnderstandResult> {
  const response = await openai(env).responses.parse({
    model: env.AGENT_MODEL,
    ...(usesReasoning(env.AGENT_MODEL) ? { reasoning: { effort: env.AGENT_REASONING_EFFORT } } : {}),
    input: [
      { role: "system", content: instructions(catalogue) },
      { role: "user", content: situation(context, catalogue) },
    ],
    text: { format: zodTextFormat(Understanding, "understanding") },
  });

  if (!response.output_parsed) {
    throw new Error(`model returned no structured output (status ${response.status})`);
  }
  return {
    understanding: withoutPlaceholders(response.output_parsed),
    model: response.model,
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          cachedInputTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: response.usage.output_tokens,
        }
      : null,
  };
}
