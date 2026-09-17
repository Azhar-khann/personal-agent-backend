/**
 * One chat message in, one reply out (§4). The model works out what the
 * message means (understand.ts); this decides what to do: ask one question,
 * search, book, or point at an existing booking.
 */

import {
  bookOption,
  getDb,
  OrderError,
  runSearch,
  schema,
  type LocationMode,
} from "@personal-agent/core";
import { and, eq, inArray } from "drizzle-orm";
import { getCurrentRunTree, traceable } from "langsmith/traceable";

import type { User } from "../auth.js";
import type { ApiEnv } from "../env.js";
import { HttpError } from "../http.js";
import { searchView, type SearchView } from "../search-view.js";
import { loadCatalogue, type Catalogue } from "./catalogue.js";
import {
  businessById,
  businessesNamed,
  recentMessages,
  serviceLocationModes,
  upcomingOrders,
  type UpcomingOrder,
} from "./lookups.js";
import * as say from "./replies.js";
import { emptyState, loadState, saveState, type AgentState } from "@personal-agent/core";
import { checkWindow, fromLocal, type WindowProblem } from "@personal-agent/core";
import { choiceFromLabel, understand, type Understanding } from "./understand.js";

const { conversations, messages, searches } = schema;

/** Searches still being worked on: a new request abandons one of these. */
const OPEN_SEARCH_STATUSES = ["gathering", "presenting", "no_results"];

type ReplyKind =
  | "question"
  | "options"
  | "no_results"
  | "no_availability"
  | "booked"
  | "booking"
  | "needs_location"
  | "unsupported"
  | "text";

type Outcome = {
  kind: ReplyKind;
  content: string;
  state: AgentState;
  searchId?: string;
  orderId?: string;
  bookingAction?: "cancel" | "reschedule" | null;
};

type Turn = {
  user: User;
  conversationId: string;
  now: Date;
  timeZone: string;
  catalogue: Catalogue;
  state: AgentState;
  /** The browser's location, when it shares one. */
  location: { lat: number; lng: number } | null;
  /** The request's search, if it's still open. */
  open: SearchView | null;
  orders: UpcomingOrder[];
};

const question = (content: string, state: AgentState): Outcome => ({ kind: "question", content, state });

// ---------------------------------------------------------------------------

async function openSearch(state: AgentState, userId: string): Promise<SearchView | null> {
  if (!state.searchId) return null;
  try {
    const view = await searchView(state.searchId, userId);
    return OPEN_SEARCH_STATUSES.includes(view.search.status) ? view : null;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

async function abandon(searchId: string, now: Date): Promise<void> {
  await getDb()
    .update(searches)
    .set({ status: "abandoned", updatedAt: now })
    .where(and(eq(searches.id, searchId), inArray(searches.status, OPEN_SEARCH_STATUSES)));
}

// --- request: gather what's needed, one question at a time, then search -----

export const isPerUnit = (catalogue: Catalogue, serviceId: string | null) =>
  catalogue.service(serviceId)?.defaultPricingMode === "per_unit";

/**
 * The location modes that fit what the user said. "Come to me" fits a business
 * that comes to the customer or collects from them.
 */
function locationModesFor(said: "at_business" | "at_customer"): LocationMode[] {
  return said === "at_business" ? ["at_business"] : ["at_customer", "pickup_delivery"];
}

/** The mode to search: the service's default when it fits what the user said, else the first that does. */
function resolveLocationMode(said: "at_business" | "at_customer" | null, fallback: LocationMode): LocationMode {
  if (!said) return fallback;
  const fits = locationModesFor(said);
  return fits.includes(fallback) ? fallback : fits[0]!;
}

async function request(turn: Turn, u: Understanding): Promise<Outcome> {
  const { catalogue, now, timeZone, user } = turn;
  const pending = turn.state.pendingChoice;

  const fresh = u.starts_new_request || (turn.state.categoryId === null && pending === null);
  if (fresh && u.starts_new_request && turn.open) await abandon(turn.open.search.id, now);

  const s: AgentState = fresh ? emptyState() : { ...turn.state, pendingChoice: null, details: { ...turn.state.details } };
  // Said before the reply, e.g. "X isn't on the app yet".
  let prefix = "";

  // An answer to the numbered question just asked.
  const choice = pending ? (u.choice_number ?? choiceFromLabel(pending.labels, u)) : null;
  if (pending && choice !== null) {
    const picked = pending.values[choice - 1];
    if (picked && pending.kind === "category") s.categoryId = picked;
    if (picked && pending.kind === "business") {
      const business = await businessById(picked);
      if (business) Object.assign(s, { businessId: business.id, businessName: business.name, categoryId: business.categoryId });
    }
  }

  // A service pins its category; a different category clears what belonged to the old one.
  const service = catalogue.service(u.service_id);
  const category = service ? catalogue.category(service.categoryId) : catalogue.category(u.category_id);
  if (category && category.id !== s.categoryId) {
    if (s.categoryId !== null) Object.assign(s, { serviceId: null, businessId: null, businessName: null, details: {} });
    s.categoryId = category.id;
  }
  if (service) s.serviceId = service.id;

  let windowProblem: WindowProblem | null = null;
  if (u.time_window) {
    const checked = checkWindow(u.time_window.start, u.time_window.end, timeZone, now);
    if (checked.ok) s.window = { start: checked.start.toISOString(), end: checked.end.toISOString() };
    else windowProblem = checked.problem;
  }
  if (u.location) s.locationMode = u.location;
  if (u.address) s.address = u.address;
  if (u.budget_max_aed !== null) s.budgetMaxAed = u.budget_max_aed;
  // Only a per-unit service has a quantity. The model sometimes gives one anyway
  // — a budget, a number of rooms — so it's kept only while it could apply.
  if (u.quantity !== null && (s.serviceId === null || isPerUnit(catalogue, s.serviceId))) s.quantity = u.quantity;
  if (u.notes) s.notes = u.notes;
  for (const { key, value } of u.details) s.details[key] = value;

  // Direct mode: the user named a business (§4) — unless the "name" was just
  // how they picked from the branches offered.
  if (u.business_name && !(pending?.kind === "business" && choice !== null)) {
    const found = await businessesNamed(u.business_name);
    const sameCategory = found.filter((b) => b.categoryId === s.categoryId);
    const candidates = sameCategory.length > 0 ? sameCategory : found;

    if (candidates.length === 0) {
      prefix += say.notOnApp(u.business_name);
      Object.assign(s, { businessId: null, businessName: null });
    } else if (candidates.length === 1) {
      const business = candidates[0]!;
      Object.assign(s, { businessId: business.id, businessName: business.name });
      s.categoryId ??= business.categoryId;
    } else {
      s.pendingChoice = {
        kind: "business",
        values: candidates.map((b) => b.id),
        labels: candidates.map((b) => `${b.name} — ${b.address}`),
      };
      return question(say.askBranch(u.business_name, candidates), s);
    }
  }

  // Which kind of business? Ask rather than guess (§14.2).
  if (s.categoryId === null) {
    const candidates = u.category_candidates.flatMap((id) => catalogue.category(id) ?? []);
    if (candidates.length === 1) {
      s.categoryId = candidates[0]!.id;
    } else if (candidates.length > 1) {
      s.pendingChoice = { kind: "category", values: candidates.map((c) => c.id), labels: candidates.map((c) => c.name) };
      s.askedAbout = [...new Set([...s.askedAbout, "category"])];
      return question(say.askCategory(candidates.map((c) => c.name)), s);
    } else {
      return { kind: "unsupported", content: say.unsupported(catalogue.categories), state: emptyState() };
    }
  }
  const chosenCategory = catalogue.category(s.categoryId)!;

  // One question per message, and not the same one twice while others are open (§4).
  const missing: string[] = [];
  for (const field of chosenCategory.required) {
    if (field === "service" && !s.serviceId) missing.push("service");
    else if (field === "time_window" && (!s.window || windowProblem)) missing.push("time_window");
    else if (field !== "service" && field !== "time_window" && !s.details[field]) missing.push(field);
  }
  const next = windowProblem ? "time_window" : (missing.find((field) => !s.askedAbout.includes(field)) ?? missing[0]);
  if (next) {
    const askedBefore = s.askedAbout.includes(next);
    s.askedAbout = [...new Set([...s.askedAbout, next])];
    if (next === "service") return question(say.askService(chosenCategory, askedBefore), s);
    if (next === "time_window") return question(say.askTime(windowProblem), s);
    return question(say.askDetail(next), s);
  }

  const chosenService = catalogue.service(s.serviceId)!;

  // What the service's settings need, asked once each and never blocking: a
  // rough quantity for per-unit pricing, and what the job is for a quote.
  if (chosenService.defaultPricingMode === "per_unit" && s.quantity === null && !s.askedAbout.includes("quantity")) {
    s.askedAbout = [...s.askedAbout, "quantity"];
    return question(prefix + say.askQuantity(chosenService.defaultUnitLabel ?? "unit"), s);
  }
  if (chosenService.defaultPricingMode === "quote" && !s.notes && !s.askedAbout.includes("description")) {
    s.askedAbout = [...s.askedAbout, "description"];
    return question(prefix + say.askDescription(), s);
  }

  // Where: the user's word, else what the named business offers, else the service's default.
  let locationMode = resolveLocationMode(s.locationMode, chosenService.defaultLocationMode);
  if (s.businessId) {
    const modes = await serviceLocationModes(s.businessId, chosenService.id);
    const acceptable = s.locationMode ? locationModesFor(s.locationMode) : modes;
    const offered = modes.filter((mode) => acceptable.includes(mode));
    if (offered.length === 0) {
      prefix += say.doesNotOffer(s.businessName ?? "That business", chosenService.name, s.locationMode === "at_customer");
      Object.assign(s, { businessId: null, businessName: null });
    } else if (!offered.includes(locationMode)) {
      locationMode = offered[0]!;
    }
  }

  const home = user.homeLat !== null && user.homeLng !== null ? { lat: Number(user.homeLat), lng: Number(user.homeLng) } : null;
  const coords = turn.location ?? home;
  if (!coords) return { kind: "needs_location", content: prefix + say.needsLocation(), state: s };

  const address = locationMode === "at_business" ? null : (s.address ?? user.homeAddress);
  if (locationMode !== "at_business" && !address) {
    s.askedAbout = [...new Set([...s.askedAbout, "address"])];
    return question(prefix + say.askAddress(), s);
  }

  // Refining a request updates its search, rather than starting another.
  const values = {
    categoryId: chosenCategory.id,
    canonicalServiceId: chosenService.id,
    // §3: 'reminder' when a nudge started it — the spec's reminder-to-booking metric.
    mode: s.reminderId ? "reminder" : s.businessId ? "direct" : "search",
    namedBusinessId: s.businessId,
    windowStart: new Date(s.window!.start),
    windowEnd: new Date(s.window!.end),
    lat: String(coords.lat),
    lng: String(coords.lng),
    locationMode,
    // Where the business comes to, or collects from.
    address,
    constraints: {
      ...s.details,
      ...(s.budgetMaxAed === null ? {} : { budget_max: s.budgetMaxAed }),
      ...(s.quantity === null || !isPerUnit(catalogue, chosenService.id) ? {} : { quantity: s.quantity }),
      ...(s.notes ? { notes: s.notes } : {}),
      // Completing the booking moves this reminder's due date on.
      ...(s.reminderId ? { reminder_id: s.reminderId } : {}),
    },
    updatedAt: now,
  };

  let searchId: string;
  if (turn.open && !fresh) {
    searchId = turn.open.search.id;
    await getDb().update(searches).set(values).where(eq(searches.id, searchId));
  } else {
    const [created] = await getDb()
      .insert(searches)
      .values({ ...values, userId: user.id, conversationId: turn.conversationId })
      .returning({ id: searches.id });
    searchId = created!.id;
  }
  s.searchId = searchId;

  const result = await runSearch(searchId, now);
  const view = await searchView(searchId, user.id);

  if (view.options.length > 0) {
    return { kind: "options", content: say.options(view, chosenService.name, timeZone, prefix), state: s, searchId };
  }
  if (result.matched === 0) {
    return { kind: "no_results", content: say.nobodyOffers(chosenService.name, prefix), state: s, searchId };
  }
  return {
    kind: "no_availability",
    content: say.nothingFree(view, result.matched, chosenService.name, s.businessName, timeZone, prefix),
    state: s,
    searchId,
  };
}

// --- picking an option -----------------------------------------------------------

async function selectOption(turn: Turn, u: Understanding): Promise<Outcome> {
  const view = turn.open;
  if (!view || view.options.length === 0) return question(say.nothingToPick(), turn.state);

  const option =
    (u.option_number !== null ? view.options.find((o) => o.rank === u.option_number) : undefined) ??
    (view.options.length === 1 ? view.options[0] : undefined);
  if (!option) return question(say.whichOption(view), turn.state);

  let slot: Date | undefined;
  if (u.option_time) {
    const chosen = fromLocal(u.option_time, turn.timeZone);
    slot = option.offeredSlots.find((offered) => chosen?.getTime() === offered.getTime());
    if (!slot) return question(say.notOffered(option, turn.timeZone), turn.state);
  } else if (option.offeredSlots.length === 1) {
    slot = option.offeredSlots[0];
  } else {
    return question(say.whichTime(option, turn.timeZone), turn.state);
  }

  try {
    const booking = await bookOption({
      userId: turn.user.id,
      searchId: view.search.id,
      optionId: option.id,
      slotAt: slot!,
      now: turn.now,
    });
    const offered = option.offeredSlots.findIndex((time) => time.getTime() === slot!.getTime());
    return {
      kind: "booked",
      content: say.booked(
        option,
        slot!,
        option.laterSlots?.[offered] ?? [],
        booking.status,
        turn.timeZone,
        booking.overlappingOrderIds.length > 0,
      ),
      state: emptyState(),
      searchId: view.search.id,
      orderId: booking.orderId,
    };
  } catch (error) {
    if (error instanceof OrderError && error.code === "slot_unavailable") {
      // §6: search again and show a fresh list — don't make the user start over.
      await runSearch(view.search.id, turn.now);
      const refreshed = await searchView(view.search.id, turn.user.id);
      return {
        kind: refreshed.options.length > 0 ? "options" : "no_availability",
        content: say.slotGone(refreshed, turn.timeZone),
        state: turn.state,
        searchId: view.search.id,
      };
    }
    if (error instanceof OrderError && error.code === "invalid_status") {
      return { kind: "text", content: say.listClosed(), state: emptyState() };
    }
    throw error;
  }
}

// --- existing bookings ----------------------------------------------------------------

function manageBooking(turn: Turn, u: Understanding): Outcome {
  const { orders } = turn;
  if (orders.length === 0) return { kind: "text", content: say.noBookings(), state: turn.state };

  const order =
    (u.order_number !== null ? orders[u.order_number - 1] : undefined) ??
    (orders.length === 1 ? orders[0] : undefined);
  if (!order) return question(say.whichBooking(orders, turn.timeZone), turn.state);

  return {
    kind: "booking",
    content: say.bookingCard(order, u.booking_action, turn.timeZone),
    state: turn.state,
    orderId: order.id,
    bookingAction: u.booking_action,
  };
}

// ---------------------------------------------------------------------------

async function act(turn: Turn, u: Understanding): Promise<Outcome> {
  // While a numbered question is open, an answer to it is part of the request,
  // whatever the model called it — "the Al Barsha one" once came back as
  // select_option. Stopping, managing a booking or chatting still go their way.
  if (turn.state.pendingChoice && (u.intent === "select_option" || u.intent === "request")) {
    return request(turn, u);
  }

  switch (u.intent) {
    case "request":
      return request(turn, u);
    case "select_option":
      return selectOption(turn, u);
    case "manage_booking":
      return manageBooking(turn, u);
    case "stop":
      if (turn.open) await abandon(turn.open.search.id, turn.now);
      return { kind: "text", content: say.stopped(turn.open !== null), state: emptyState() };
    case "other":
      return { kind: "text", content: u.reply ?? say.fallback(), state: turn.state };
  }
}

export type TurnResult = {
  conversationId: string;
  userMessage: typeof messages.$inferSelect;
  reply: typeof messages.$inferSelect;
  searchId: string | null;
  orderId: string | null;
};

export async function runTurn(input: {
  env: ApiEnv;
  user: User;
  conversationId: string | null;
  content: string;
  location: { lat: number; lng: number } | null;
  now?: Date;
}): Promise<TurnResult> {
  const { env, user } = input;
  const now = input.now ?? new Date();
  const db = getDb();

  let conversationId = input.conversationId;
  if (conversationId) {
    const [owned] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));
    if (!owned) throw new HttpError(404, "conversation_not_found", "No such conversation");
  } else {
    const [created] = await db.insert(conversations).values({ userId: user.id }).returning({ id: conversations.id });
    conversationId = created!.id;
  }

  const history = await recentMessages(conversationId, 10);
  const [userMessage] = await db
    .insert(messages)
    .values({ conversationId, role: "user", content: input.content, createdAt: now })
    .returning();

  const state = await loadState(conversationId);
  const [catalogue, orders, open] = await Promise.all([
    loadCatalogue(),
    upcomingOrders(user.id, now),
    openSearch(state, user.id),
  ]);
  const turn: Turn = {
    user,
    conversationId,
    now,
    timeZone: user.timezone,
    catalogue,
    state,
    location: input.location,
    open,
    orders,
  };

  // One trace per message: the model call and the three search steps nest
  // inside it. Only ids and the message are recorded as inputs — never the
  // user's profile or the API keys.
  const traced = traceable(
    async (_inputs: { conversationId: string; message: string }) => {
      let understood;
      try {
        understood = await understand(env, catalogue, {
          now,
          timeZone: turn.timeZone,
          state,
          options: open?.options ?? [],
          orders,
          history,
          message: input.content,
        });
      } catch (error) {
        throw new HttpError(503, "agent_unavailable", "The assistant is unavailable right now. Please try again.", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      const outcome = await act(turn, understood.understanding);
      return { ...understood, outcome, runId: getCurrentRunTree(true)?.id ?? null };
    },
    { name: "chat_turn", metadata: { userId: user.id } },
  );

  const { outcome, model, usage, runId, understanding } = await traced({ conversationId, message: input.content });

  const [reply] = await db
    .insert(messages)
    .values({
      conversationId,
      role: "assistant",
      content: outcome.content,
      // A millisecond later, so the reply always sorts after the user's message.
      createdAt: new Date(now.getTime() + 1),
      metadata: {
        kind: outcome.kind,
        search_id: outcome.searchId ?? null,
        order_id: outcome.orderId ?? null,
        booking_action: outcome.bookingAction ?? null,
        intent: understanding.intent,
        model,
        usage,
        langsmith_run_id: runId,
      },
    })
    .returning();
  await saveState(conversationId, outcome.state, now);
  await db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, conversationId));

  return {
    conversationId,
    userMessage: userMessage!,
    reply: reply!,
    searchId: outcome.searchId ?? null,
    orderId: outcome.orderId ?? null,
  };
}
