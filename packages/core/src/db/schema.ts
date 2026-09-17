/**
 * The tables from App_design_spec.md §3, with the approved departures:
 * `admins` added; `bookings` replaced by `orders`, `appointments`, `quotes`
 * and `order_events`; and the four service settings on `business_services`
 * (defaults on `canonical_services`). 21 tables.
 *
 * Column names, types, defaults and CHECK constraints otherwise follow the
 * spec. The no_double_booking exclusion constraint and the `ends_at` trigger
 * are in migrations/0001_booking_guard.sql (why they look the way they do)
 * and 0002 (where they now live).
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Vocabularies — the value lists behind the CHECK constraints below. They live
// here, with no imports from the rest of the package, because drizzle-kit
// loads this file by itself and can't follow our ESM `.js` imports. The Zod
// schemas in ../service-settings.ts build on these.
// ---------------------------------------------------------------------------

/** How a service is delivered and sold. Read by the engine and agent — never the category id. */
export const LOCATION_MODES = ["at_business", "at_customer", "pickup_delivery"] as const;
export const PRICING_MODES = ["fixed", "from", "per_unit", "quote"] as const;
export const CONFIRMATIONS = ["instant", "request"] as const;
export const STEP_KINDS = ["visit", "pickup", "delivery", "job"] as const;

export type LocationMode = (typeof LOCATION_MODES)[number];
export type PricingMode = (typeof PRICING_MODES)[number];
export type Confirmation = (typeof CONFIRMATIONS)[number];
export type StepKind = (typeof STEP_KINDS)[number];

/** One appointment a service needs. Step N+1 is searched from step N's end plus after_hours. */
export type Step = { kind: StepKind; duration_min: number; after_hours?: number };

/** Phase 1 uses only the instant, single-step path: confirmed → completed, or a cancellation. */
export const ORDER_STATUSES = [
  "requested",
  "quoted",
  "confirmed",
  "in_progress",
  "completed",
  "declined",
  "cancelled_by_user",
  "cancelled_by_business",
  "no_show",
] as const;

/** `held` is a requested order's appointment: it occupies the slot until the business decides. */
export const APPOINTMENT_STATUSES = ["held", "confirmed", "completed", "cancelled", "no_show"] as const;

/** Appointments in these states take part in the no_double_booking constraint. */
export const SLOT_HOLDING_STATUSES = ["held", "confirmed", "completed"] as const;

export const QUOTE_STATUSES = ["sent", "accepted", "declined", "expired"] as const;

export const EVENT_ACTORS = ["user", "business", "system"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export type EventActor = (typeof EVENT_ACTORS)[number];

/** timestamptz, as the spec uses everywhere for absolute times. */
const tstz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

/** numeric(9,6) — the spec's precision for a lat/lng pair. */
const coord = (name: string) => numeric(name, { precision: 9, scale: 6 });

/** numeric(10,2) — AED money. */
const money = (name: string) => numeric(name, { precision: 10, scale: 2 });

const createdAt = () => tstz("created_at").notNull().defaultNow();
const updatedAt = () => tstz("updated_at").notNull().defaultNow();

/** A CHECK that a column holds one of the given values, sharing the list with the Zod enums. */
const oneOf = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * Everyone who signs up. Clerk handles the actual login, so this is our own
 * copy plus the fields Clerk does not store, like their home address.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").unique().notNull(),
  phone: text("phone").unique(),
  name: text("name"),
  email: text("email"),
  homeLat: coord("home_lat"),
  homeLng: coord("home_lng"),
  homeAddress: text("home_address"),
  // Used to read "tomorrow" against the right wall clock.
  timezone: text("timezone").notNull().default("Asia/Dubai"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Not in the spec's 17 tables. §8 defines /api/admin/* endpoints but nothing
 * carries an admin flag; rows here make the grant auditable and revocable
 * without a redeploy.
 */
export const admins = pgTable("admins", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  grantedBy: uuid("granted_by").references(() => users.id),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Catalogue — you fill these; users never add to them
// ---------------------------------------------------------------------------

/**
 * The business types the app supports. `onboarding_schema` and
 * `request_schema` hold JSON that drives behaviour elsewhere, so adding a
 * category needs no code change.
 */
export const categories = pgTable("categories", {
  id: text("id").primaryKey(), // 'barber', 'ac_maintenance'
  name: text("name").notNull(),
  groupName: text("group_name").notNull(),
  onboardingSchema: jsonb("onboarding_schema").notNull(),
  requestSchema: jsonb("request_schema").notNull(),
  agentHints: text("agent_hints"),
  defaultDurationMin: integer("default_duration_min").notNull().default(30),
  defaultRadiusKm: integer("default_radius_km").notNull().default(10),
  recurringDefaultDays: integer("recurring_default_days"),
  active: boolean("active").notNull().default(true),
});

/**
 * A shared service vocabulary, one set per category. One barber writes
 * "Men's Cut" and another "Gents Haircut"; both map to a row here, so finding
 * everyone who does haircuts never means comparing free text.
 */
export const canonicalServices = pgTable(
  "canonical_services",
  {
    id: text("id").primaryKey(), // 'mens_haircut'
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    name: text("name").notNull(),
    // Fed to the agent so it recognises "trim" or "hair cut" as the same thing.
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),

    // Defaults for the four service settings (service-settings.ts). A business
    // accepts them when it adds the service, or overrides them.
    defaultLocationMode: text("default_location_mode").notNull().default("at_business"),
    defaultPricingMode: text("default_pricing_mode").notNull().default("fixed"),
    defaultUnitLabel: text("default_unit_label"),
    defaultConfirmation: text("default_confirmation").notNull().default("instant"),
    // The only place a duration lives: [{ kind, duration_min, after_hours? }].
    defaultSteps: jsonb("default_steps").$type<Step[]>().notNull(),

    active: boolean("active").notNull().default(true),
  },
  (t) => [
    check("canonical_services_location_mode_check", oneOf(t.defaultLocationMode, LOCATION_MODES)),
    check("canonical_services_pricing_mode_check", oneOf(t.defaultPricingMode, PRICING_MODES)),
    check("canonical_services_confirmation_check", oneOf(t.defaultConfirmation, CONFIRMATIONS)),
    check(
      "canonical_services_unit_label_check",
      sql`(${t.defaultPricingMode} = 'per_unit') = (${t.defaultUnitLabel} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------

/** One row per business: where they are, and the rules for booking them. */
export const businesses = pgTable(
  "businesses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    // Taken from navigator.geolocation at signup — no geocoding service.
    lat: coord("lat").notNull(),
    lng: coord("lng").notNull(),
    address: text("address").notNull(),
    city: text("city").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    // New signups start 'pending'; 'suspended' hides them from search but
    // keeps their existing bookings.
    status: text("status").notNull().default("pending"),
    attributes: jsonb("attributes")
      .notNull()
      .default(sql`'{}'::jsonb`),

    // The five scheduling columns (§3).
    radiusKm: integer("radius_km"), // NULL = category default
    capacity: integer("capacity").notNull().default(1),
    slotIntervalMin: integer("slot_interval_min").notNull().default(30),
    bufferMin: integer("buffer_min").notNull().default(0),
    leadTimeMin: integer("lead_time_min").notNull().default(60),
    maxAdvanceDays: integer("max_advance_days").notNull().default(60),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "businesses_status_check",
      sql`${t.status} IN ('pending','active','suspended')`,
    ),
    // The §5 Step 1 filter leads with category + status.
    index("businesses_category_status_idx").on(t.categoryId, t.status),
  ],
);

/** Which people work at which business. No row here = customer side only. */
export const businessMembers = pgTable(
  "business_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Owners change prices and hours; staff only manage bookings.
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("business_members_role_check", sql`${t.role} IN ('owner','staff')`),
    unique("business_members_business_user_key").on(t.businessId, t.userId),
  ],
);

/**
 * What one business offers, how, and at what price. No active row here =
 * never found. The four settings decide how the engine and agent treat the
 * service; the category id is never consulted for that.
 */
export const businessServices = pgTable(
  "business_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    canonicalServiceId: text("canonical_service_id")
      .notNull()
      .references(() => canonicalServices.id),
    displayName: text("display_name").notNull(),

    locationMode: text("location_mode").notNull().default("at_business"),
    pricingMode: text("pricing_mode").notNull().default("fixed"),
    // Only for per_unit: 'kg', 'item', ...
    unitLabel: text("unit_label"),
    confirmation: text("confirmation").notNull().default("instant"),
    // The only place a duration lives; single-step = one element.
    steps: jsonb("steps").$type<Step[]>().notNull(),

    // fixed: the price. from: the minimum. per_unit: per unit_label.
    // quote: NULL, or a visit fee.
    priceAed: money("price_aed"),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    // The same service can be offered at the shop and at home as two rows.
    unique("business_services_business_service_location_key").on(
      t.businessId,
      t.canonicalServiceId,
      t.locationMode,
    ),
    // The §5 Step 1 JOIN pivots on this.
    index("business_services_canonical_idx").on(t.canonicalServiceId),
    check("business_services_location_mode_check", oneOf(t.locationMode, LOCATION_MODES)),
    check("business_services_pricing_mode_check", oneOf(t.pricingMode, PRICING_MODES)),
    check("business_services_confirmation_check", oneOf(t.confirmation, CONFIRMATIONS)),
    check(
      "business_services_price_check",
      sql`${t.priceAed} IS NOT NULL OR ${t.pricingMode} = 'quote'`,
    ),
    check(
      "business_services_unit_label_check",
      sql`(${t.pricingMode} = 'per_unit') = (${t.unitLabel} IS NOT NULL)`,
    ),
  ],
);

/** Normal opening hours. No row for a day means closed that day. */
export const businessHours = pgTable(
  "business_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    dayOfWeek: smallint("day_of_week").notNull(), // 0 = Sunday
    opensAt: time("opens_at").notNull(),
    closesAt: time("closes_at").notNull(),
  },
  (t) => [
    check(
      "business_hours_day_of_week_check",
      sql`${t.dayOfWeek} BETWEEN 0 AND 6`,
    ),
    unique("business_hours_business_day_key").on(t.businessId, t.dayOfWeek),
  ],
);

/**
 * One-off shut periods. Kept apart from hours so a two-week holiday doesn't
 * mean editing the weekly schedule and putting it back afterwards.
 */
export const businessClosures = pgTable(
  "business_closures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    startsAt: tstz("starts_at").notNull(),
    endsAt: tstz("ends_at").notNull(),
    reason: text("reason"),
  },
  (t) => [
    check("business_closures_range_check", sql`${t.endsAt} > ${t.startsAt}`),
    index("business_closures_business_range_idx").on(t.businessId, t.startsAt),
  ],
);

/** Running counters. times_shown against times_selected is the ranking signal. */
export const businessStats = pgTable("business_stats", {
  businessId: uuid("business_id")
    .primaryKey()
    .references(() => businesses.id, { onDelete: "cascade" }),
  timesShown: integer("times_shown").notNull().default(0),
  timesSelected: integer("times_selected").notNull().default(0),
  bookingsTotal: integer("bookings_total").notNull().default(0),
  bookingsCompleted: integer("bookings_completed").notNull().default(0),
  cancellationsByBusiness: integer("cancellations_by_business")
    .notNull()
    .default(0),
  noShows: integer("no_shows").notNull().default(0),
  updatedAt: updatedAt(),
});

/** One row per browser per staff member. */
export const businessPushSubscriptions = pgTable(
  "business_push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dhKey: text("p256dh_key").notNull(),
    authKey: text("auth_key").notNull(),
    // push.prune deletes the row after repeated failures.
    failedCount: integer("failed_count").notNull().default(0),
    lastSeenAt: tstz("last_seen_at").notNull().defaultNow(),
  },
);

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("conversations_status_check", sql`${t.status} IN ('active','closed')`),
    index("conversations_user_idx").on(t.userId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    // Where the LangSmith run ID lives, so a message links to its trace.
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "messages_role_check",
      sql`${t.role} IN ('user','assistant','system')`,
    ),
    // History is paged backwards for scrolling up.
    index("messages_conversation_created_idx").on(
      t.conversationId,
      t.createdAt,
    ),
  ],
);

/**
 * What the agent has worked out so far, one row per conversation, overwritten
 * each turn. In the database rather than memory so a restart doesn't lose
 * someone's half-finished request.
 */
export const agentState = pgTable("agent_state", {
  conversationId: uuid("conversation_id")
    .primaryKey()
    .references(() => conversations.id, { onDelete: "cascade" }),
  state: jsonb("state").notNull(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** One thing a user wants booked, created once the agent has enough detail. */
export const searches = pgTable(
  "searches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    canonicalServiceId: text("canonical_service_id").references(
      () => canonicalServices.id,
    ),
    // 'search' normal, 'direct' user named a business, 'reminder' agent nudged.
    mode: text("mode").notNull().default("search"),
    namedBusinessId: uuid("named_business_id").references(() => businesses.id),
    // Always a range, never a single time.
    windowStart: tstz("window_start").notNull(),
    windowEnd: tstz("window_end").notNull(),
    lat: coord("lat").notNull(),
    lng: coord("lng").notNull(),
    // Where the work happens, for an at_customer service; copied onto the
    // order at booking. The agent defaults it to the user's home address.
    address: text("address"),
    constraints: jsonb("constraints")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("gathering"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("searches_mode_check", sql`${t.mode} IN ('search','direct','reminder')`),
    check(
      "searches_status_check",
      sql`${t.status} IN ('gathering','presenting','booked','no_results','abandoned')`,
    ),
    check("searches_window_check", sql`${t.windowEnd} > ${t.windowStart}`),
    index("searches_user_idx").on(t.userId),
  ],
);

/**
 * The businesses shown for a search, and which one was picked. Keeping rank
 * alongside selected_at is what lets you ask "when we put someone first, how
 * often did people pick them?" without labelling anything by hand.
 */
export const searchOptions = pgTable(
  "search_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    searchId: uuid("search_id")
      .notNull()
      .references(() => searches.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    businessServiceId: uuid("business_service_id")
      .notNull()
      .references(() => businessServices.id),
    rank: integer("rank").notNull(), // 1..5, the position we showed
    rankScore: numeric("rank_score", { precision: 6, scale: 4 }).notNull(),
    // NULL for a quote-priced service.
    priceAed: money("price_aed"),
    distanceKm: numeric("distance_km", { precision: 6, scale: 2 }).notNull(),
    // Up to 3 free times, spread across the window.
    offeredSlots: timestamp("offered_slots", {
      withTimezone: true,
      mode: "date",
    })
      .array()
      .notNull(),
    presentedAt: tstz("presented_at").notNull().defaultNow(),
    selectedAt: tstz("selected_at"),
  },
  (t) => [unique("search_options_search_business_key").on(t.searchId, t.businessId)],
);

// ---------------------------------------------------------------------------
// Orders — what and who; appointments — when
// ---------------------------------------------------------------------------

/** One job a user has asked a business for. */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    searchId: uuid("search_id").references(() => searches.id),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    businessServiceId: uuid("business_service_id")
      .notNull()
      .references(() => businessServices.id),
    // Set explicitly by the code that creates the order: 'confirmed' for an
    // instant service, 'requested' for one the business must approve.
    status: text("status").notNull(),

    // Where the work happens, when it isn't at the business.
    serviceAddress: text("service_address"),
    serviceLat: coord("service_lat"),
    serviceLng: coord("service_lng"),
    // For per_unit pricing: how many unit_labels.
    quantity: numeric("quantity", { precision: 10, scale: 2 }),
    // Whatever the agent collected that has no column: notes, a description
    // for a quote, the user's answers to optional request_schema fields.
    details: jsonb("details")
      .notNull()
      .default(sql`'{}'::jsonb`),

    // Copied at booking rather than read from business_services, so a later
    // price rise leaves this order showing what was agreed. NULL until a
    // quote is accepted; for per_unit it's the estimate.
    priceAed: money("price_aed"),
    // What was actually charged, set when the job is done.
    finalPriceAed: money("final_price_aed"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("orders_status_check", oneOf(t.status, ORDER_STATUSES)),
    check(
      "orders_service_location_check",
      sql`(${t.serviceLat} IS NULL) = (${t.serviceLng} IS NULL)`,
    ),
    index("orders_business_created_idx").on(t.businessId, t.createdAt),
    index("orders_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/**
 * A block of a business's time. A single-step order has one; a laundry order
 * has a pickup and a delivery. The no_double_booking exclusion constraint and
 * the ends_at trigger live here (migration 0002).
 */
export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    // Copied from the order: the exclusion constraint can only reference this
    // table's own columns, and the calendar and availability queries go by it.
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    // 'job' for a plain service; 'visit' for a quote's site visit.
    kind: text("kind").notNull(),
    // Which of the business's interchangeable resources this appointment uses:
    // whatever its capacity counts — a chair, a treatment room, a service bay,
    // a technician or crew. Capacity 3 uses 0, 1 and 2; this is what lets three
    // appointments share a time without clashing.
    resourceIndex: integer("resource_index").notNull().default(0),
    scheduledAt: tstz("scheduled_at").notNull(),
    durationMin: integer("duration_min").notNull(),

    // Copied from the business at booking time, like price_aed on the order: a
    // business widening its buffer tomorrow must not retroactively invalidate
    // appointments already made. The exclusion constraint reads it.
    bufferMin: integer("buffer_min").notNull().default(0),

    // Derived, and owned entirely by the appointments_ends_at trigger — never
    // set this from application code. The default only exists so inserts need
    // not mention it; the BEFORE trigger overwrites it on every insert and
    // update. See migrations/0001_booking_guard.sql for why.
    endsAt: tstz("ends_at").notNull().defaultNow(),

    // 'held' while the order is still 'requested'; it occupies the slot.
    status: text("status").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("appointments_kind_check", oneOf(t.kind, STEP_KINDS)),
    check("appointments_status_check", oneOf(t.status, APPOINTMENT_STATUSES)),
    check("appointments_resource_index_check", sql`${t.resourceIndex} >= 0`),
    // The §5 Step 2 batch fetch and the calendar scan by business over a window.
    index("appointments_business_scheduled_idx").on(t.businessId, t.scheduledAt),
    index("appointments_order_idx").on(t.orderId),
  ],
);

/** A business's price for a quote-mode order, after the site visit. */
export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    amountAed: money("amount_aed").notNull(),
    // How long the job will take, so its appointment can be booked.
    estDurationMin: integer("est_duration_min").notNull(),
    lineItems: jsonb("line_items")
      .notNull()
      .default(sql`'[]'::jsonb`),
    validUntil: tstz("valid_until").notNull(),
    status: text("status").notNull().default("sent"),
    createdAt: createdAt(),
  },
  (t) => [
    check("quotes_status_check", oneOf(t.status, QUOTE_STATUSES)),
    index("quotes_order_idx").on(t.orderId),
  ],
);

/**
 * Everything that happened to an order, and the only source of notifications:
 * the worker delivers each event (push to the business, assistant message to
 * the user) and sets delivered_at.
 */
export const orderEvents = pgTable(
  "order_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    // 'order.confirmed', 'order.cancelled_by_business', ...
    type: text("type").notNull(),
    // e.g. { reason } for a cancellation.
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    deliveredAt: tstz("delivered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    check("order_events_actor_check", oneOf(t.actor, EVENT_ACTORS)),
    index("order_events_order_created_idx").on(t.orderId, t.createdAt),
    // The worker's safety-net sweep for anything a lost job left undelivered.
    index("order_events_undelivered_idx")
      .on(t.createdAt)
      .where(sql`${t.deliveredAt} IS NULL`),
  ],
);

/** Things that need doing every few months: AC servicing, tank cleaning. */
export const recurringReminders = pgTable(
  "recurring_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    canonicalServiceId: text("canonical_service_id").references(
      () => canonicalServices.id,
    ),
    label: text("label").notNull(), // "Living room AC"
    lastDoneAt: date("last_done_at"),
    intervalDays: integer("interval_days").notNull(),
    nextDueAt: date("next_due_at").notNull(),
    leadDays: integer("lead_days").notNull().default(14),
    status: text("status").notNull().default("active"),
    // Stops it nagging daily.
    lastNudgedAt: tstz("last_nudged_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "recurring_reminders_status_check",
      sql`${t.status} IN ('active','snoozed','cancelled')`,
    ),
    // reminders.scan sweeps by due date nightly.
    index("recurring_reminders_due_idx").on(t.nextDueAt, t.status),
  ],
);
