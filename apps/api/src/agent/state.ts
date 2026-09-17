import { getDb, schema } from "@personal-agent/core";
import { eq } from "drizzle-orm";
import { z } from "zod";

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
  notes: z.string().nullable(),
  /** Answers to the category's other request_schema fields. */
  details: z.record(z.string()),
  /** Stops the agent asking the same question twice. */
  askedAbout: z.array(z.string()),
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
    notes: null,
    details: {},
    askedAbout: [],
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

export async function saveState(conversationId: string, state: AgentState, now: Date): Promise<void> {
  await getDb()
    .insert(schema.agentState)
    .values({ conversationId, state, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.agentState.conversationId,
      set: { state, updatedAt: now },
    });
}
