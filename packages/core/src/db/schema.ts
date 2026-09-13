/**
 * The 18 tables from App_design_spec.md §3, plus `admins`.
 *
 * Column names, types, defaults and CHECK constraints follow the spec exactly.
 * Two additions to `bookings` (`buffer_min`, `ends_at`) exist so the
 * no_double_booking exclusion constraint can enforce the buffer — see
 * migrations/0001_booking_guard.sql for why it cannot be expressed inline.
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
} from "drizzle-orm/pg-core";

/** timestamptz, as the spec uses everywhere for absolute times. */
const tstz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

/** numeric(9,6) — the spec's precision for a lat/lng pair. */
const coord = (name: string) => numeric(name, { precision: 9, scale: 6 });

/** numeric(10,2) — AED money. */
const money = (name: string) => numeric(name, { precision: 10, scale: 2 });

const createdAt = () => tstz("created_at").notNull().defaultNow();
const updatedAt = () => tstz("updated_at").notNull().defaultNow();

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
export const canonicalServices = pgTable("canonical_services", {
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
  typicalDurationMin: integer("typical_duration_min").notNull().default(30),
  active: boolean("active").notNull().default(true),
});

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

/** What one business offers and charges. No active row here = never found. */
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
    priceAed: money("price_aed").notNull(),
    durationMin: integer("duration_min").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    unique("business_services_business_service_key").on(
      t.businessId,
      t.canonicalServiceId,
    ),
    // The §5 Step 1 JOIN pivots on this.
    index("business_services_canonical_idx").on(t.canonicalServiceId),
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
    priceAed: money("price_aed").notNull(),
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
// Bookings
// ---------------------------------------------------------------------------

/** A confirmed appointment. */
export const bookings = pgTable(
  "bookings",
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
    // Which chair or bay. Capacity 3 uses 0, 1, 2 — this is what lets three
    // people book 3pm without clashing.
    resourceIndex: integer("resource_index").notNull().default(0),
    scheduledAt: tstz("scheduled_at").notNull(),
    durationMin: integer("duration_min").notNull(),

    // Copied from the business at booking time, like price_aed below: a
    // business widening its buffer tomorrow must not retroactively invalidate
    // bookings already made. The exclusion constraint reads it.
    bufferMin: integer("buffer_min").notNull().default(0),

    // Derived, and owned entirely by the bookings_ends_at trigger — never set
    // this from application code. The default only exists so inserts need not
    // mention it; the BEFORE trigger overwrites it on every insert and update.
    // See migrations/0001_booking_guard.sql.
    endsAt: tstz("ends_at").notNull().defaultNow(),

    // Copied rather than read from business_services, so a later price rise
    // leaves this booking showing what was agreed.
    priceAed: money("price_aed").notNull(),
    status: text("status").notNull().default("confirmed"),
    cancelledReason: text("cancelled_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "bookings_status_check",
      sql`${t.status} IN ('confirmed','completed','cancelled_by_user','cancelled_by_business','no_show')`,
    ),
    // The §5 Step 2 batch fetch scans by business over a time window.
    index("bookings_business_scheduled_idx").on(t.businessId, t.scheduledAt),
    index("bookings_user_scheduled_idx").on(t.userId, t.scheduledAt),
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
