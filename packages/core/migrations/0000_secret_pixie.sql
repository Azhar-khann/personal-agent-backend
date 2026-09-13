CREATE TABLE "admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_state" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_id" uuid,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"business_service_id" uuid NOT NULL,
	"resource_index" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_min" integer NOT NULL,
	"buffer_min" integer DEFAULT 0 NOT NULL,
	"ends_at" timestamp with time zone DEFAULT now() NOT NULL,
	"price_aed" numeric(10, 2) NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_status_check" CHECK ("bookings"."status" IN ('confirmed','completed','cancelled_by_user','cancelled_by_business','no_show'))
);
--> statement-breakpoint
CREATE TABLE "business_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	CONSTRAINT "business_closures_range_check" CHECK ("business_closures"."ends_at" > "business_closures"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "business_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"opens_at" time NOT NULL,
	"closes_at" time NOT NULL,
	CONSTRAINT "business_hours_business_day_key" UNIQUE("business_id","day_of_week"),
	CONSTRAINT "business_hours_day_of_week_check" CHECK ("business_hours"."day_of_week" BETWEEN 0 AND 6)
);
--> statement-breakpoint
CREATE TABLE "business_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_members_business_user_key" UNIQUE("business_id","user_id"),
	CONSTRAINT "business_members_role_check" CHECK ("business_members"."role" IN ('owner','staff'))
);
--> statement-breakpoint
CREATE TABLE "business_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh_key" text NOT NULL,
	"auth_key" text NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "business_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"canonical_service_id" text NOT NULL,
	"display_name" text NOT NULL,
	"price_aed" numeric(10, 2) NOT NULL,
	"duration_min" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "business_services_business_service_key" UNIQUE("business_id","canonical_service_id")
);
--> statement-breakpoint
CREATE TABLE "business_stats" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"times_shown" integer DEFAULT 0 NOT NULL,
	"times_selected" integer DEFAULT 0 NOT NULL,
	"bookings_total" integer DEFAULT 0 NOT NULL,
	"bookings_completed" integer DEFAULT 0 NOT NULL,
	"cancellations_by_business" integer DEFAULT 0 NOT NULL,
	"no_shows" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category_id" text NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"lng" numeric(9, 6) NOT NULL,
	"address" text NOT NULL,
	"city" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"radius_km" integer,
	"capacity" integer DEFAULT 1 NOT NULL,
	"slot_interval_min" integer DEFAULT 30 NOT NULL,
	"buffer_min" integer DEFAULT 0 NOT NULL,
	"lead_time_min" integer DEFAULT 60 NOT NULL,
	"max_advance_days" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_status_check" CHECK ("businesses"."status" IN ('pending','active','suspended'))
);
--> statement-breakpoint
CREATE TABLE "canonical_services" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"typical_duration_min" integer DEFAULT 30 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"group_name" text NOT NULL,
	"onboarding_schema" jsonb NOT NULL,
	"request_schema" jsonb NOT NULL,
	"agent_hints" text,
	"default_duration_min" integer DEFAULT 30 NOT NULL,
	"default_radius_km" integer DEFAULT 10 NOT NULL,
	"recurring_default_days" integer,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" IN ('active','closed'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" IN ('user','assistant','system'))
);
--> statement-breakpoint
CREATE TABLE "recurring_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"category_id" text NOT NULL,
	"canonical_service_id" text,
	"label" text NOT NULL,
	"last_done_at" date,
	"interval_days" integer NOT NULL,
	"next_due_at" date NOT NULL,
	"lead_days" integer DEFAULT 14 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_nudged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_reminders_status_check" CHECK ("recurring_reminders"."status" IN ('active','snoozed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "search_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"search_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"business_service_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"rank_score" numeric(6, 4) NOT NULL,
	"price_aed" numeric(10, 2) NOT NULL,
	"distance_km" numeric(6, 2) NOT NULL,
	"offered_slots" timestamp with time zone[] NOT NULL,
	"presented_at" timestamp with time zone DEFAULT now() NOT NULL,
	"selected_at" timestamp with time zone,
	CONSTRAINT "search_options_search_business_key" UNIQUE("search_id","business_id")
);
--> statement-breakpoint
CREATE TABLE "searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"category_id" text NOT NULL,
	"canonical_service_id" text,
	"mode" text DEFAULT 'search' NOT NULL,
	"named_business_id" uuid,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"lat" numeric(9, 6) NOT NULL,
	"lng" numeric(9, 6) NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'gathering' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "searches_mode_check" CHECK ("searches"."mode" IN ('search','direct','reminder')),
	CONSTRAINT "searches_status_check" CHECK ("searches"."status" IN ('gathering','presenting','booked','no_results','abandoned')),
	CONSTRAINT "searches_window_check" CHECK ("searches"."window_end" > "searches"."window_start")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text NOT NULL,
	"phone" text,
	"name" text,
	"email" text,
	"home_lat" numeric(9, 6),
	"home_lng" numeric(9, 6),
	"home_address" text,
	"timezone" text DEFAULT 'Asia/Dubai' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_business_service_id_business_services_id_fk" FOREIGN KEY ("business_service_id") REFERENCES "public"."business_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_closures" ADD CONSTRAINT "business_closures_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_members" ADD CONSTRAINT "business_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_push_subscriptions" ADD CONSTRAINT "business_push_subscriptions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_push_subscriptions" ADD CONSTRAINT "business_push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_services" ADD CONSTRAINT "business_services_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_services" ADD CONSTRAINT "business_services_canonical_service_id_canonical_services_id_fk" FOREIGN KEY ("canonical_service_id") REFERENCES "public"."canonical_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_stats" ADD CONSTRAINT "business_stats_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_services" ADD CONSTRAINT "canonical_services_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_reminders" ADD CONSTRAINT "recurring_reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_reminders" ADD CONSTRAINT "recurring_reminders_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_reminders" ADD CONSTRAINT "recurring_reminders_canonical_service_id_canonical_services_id_fk" FOREIGN KEY ("canonical_service_id") REFERENCES "public"."canonical_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_options" ADD CONSTRAINT "search_options_search_id_searches_id_fk" FOREIGN KEY ("search_id") REFERENCES "public"."searches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_options" ADD CONSTRAINT "search_options_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_options" ADD CONSTRAINT "search_options_business_service_id_business_services_id_fk" FOREIGN KEY ("business_service_id") REFERENCES "public"."business_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_canonical_service_id_canonical_services_id_fk" FOREIGN KEY ("canonical_service_id") REFERENCES "public"."canonical_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_named_business_id_businesses_id_fk" FOREIGN KEY ("named_business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_business_scheduled_idx" ON "bookings" USING btree ("business_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "bookings_user_scheduled_idx" ON "bookings" USING btree ("user_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "business_closures_business_range_idx" ON "business_closures" USING btree ("business_id","starts_at");--> statement-breakpoint
CREATE INDEX "business_services_canonical_idx" ON "business_services" USING btree ("canonical_service_id");--> statement-breakpoint
CREATE INDEX "businesses_category_status_idx" ON "businesses" USING btree ("category_id","status");--> statement-breakpoint
CREATE INDEX "conversations_user_idx" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "recurring_reminders_due_idx" ON "recurring_reminders" USING btree ("next_due_at","status");--> statement-breakpoint
CREATE INDEX "searches_user_idx" ON "searches" USING btree ("user_id");