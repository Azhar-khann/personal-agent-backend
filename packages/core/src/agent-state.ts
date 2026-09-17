import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, type Executor } from "./db/client.js";
import * as schema from "./db/schema.js";

/**
 * What the agent has worked out so far in a conversation (§3 agent_state):
 * one row per conversation, overwritten each turn, in the database so a
 * restart doesn't lose someone's half-finished request.
 */
const AgentStateSchema = z.object({
  /** The search this request became, once the agent had enough to search. */
  searchId: z.string().uuid().nullable(),
  categoryId: z.string().nullable(),
  serviceId: z.string().nullable(),
  /** Direct mode: the business the user named. */
  businessId: z.string().uuid().nullable(),
  businessName: z.string().nullable(),
  /** ISO instants. */
  window: z.object({ start: z.string(), end: z.string() }).nullable(),
  /** Only when the user said; otherwise the service's default applies. */
  locationMode: z.enum(["at_business", "at_customer"]).nullable(),
  address: z.string().nullable(),
  budgetMaxAed: z.number().nullable(),
  /** How many units, for a service priced per unit. */
  quantity: z.number().nullable().default(null),
  notes: z.string().nullable(),
  /** Answers to the category's other request_schema fields. */
  details: z.record(z.string()),
  /** Stops the agent asking the same question twice. */
  askedAbout: z.array(z.string()),
  /**
   * Set when a recurring reminder's nudge started this request, so its search
   * is marked mode 'reminder' and completing the booking moves the reminder on.
   */
  reminderId: z.string().uuid().nullable().default(null),
  /** Numbered choices the last question offered, so "the second one" can be read. */
  pendingChoice: z
    .object({
      kind: z.enum(["category", "business"]),
      values: z.array(z.string()),
      labels: z.array(z.string()),
    })
    .nullable(),
});

export type AgentState = z.infer<typeof AgentStateSchema>;

export function emptyState(): AgentState {
  return {
    searchId: null,
    categoryId: null,
    serviceId: null,
    businessId: null,
    businessName: null,
    window: null,
    locationMode: null,
    address: null,
    budgetMaxAed: null,
    quantity: null,
    notes: null,
    details: {},
    askedAbout: [],
    reminderId: null,
    pendingChoice: null,
  };
}

export async function loadState(conversationId: string): Promise<AgentState> {
  const [row] = await getDb()
    .select({ state: schema.agentState.state })
    .from(schema.agentState)
    .where(eq(schema.agentState.conversationId, conversationId));
  // A state saved in an older shape starts over rather than failing the turn.
  const parsed = AgentStateSchema.safeParse(row?.state);
  return parsed.success ? parsed.data : emptyState();
}

/** Pass `db` to save inside a transaction, e.g. alongside the conversation it belongs to. */
export async function saveState(
  conversationId: string,
  state: AgentState,
  now: Date,
  db: Executor = getDb(),
): Promise<void> {
  await db
    .insert(schema.agentState)
    .values({ conversationId, state, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.agentState.conversationId,
      set: { state, updatedAt: now },
    });
}
