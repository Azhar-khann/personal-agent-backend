ALTER TABLE "orders" DROP CONSTRAINT "orders_status_check";--> statement-breakpoint
ALTER TABLE "search_options" ADD COLUMN "later_slots" jsonb;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "location_mode" text DEFAULT 'at_business' NOT NULL;--> statement-breakpoint
-- Until now the mode was read off the address: a search with one was at_customer.
UPDATE "searches" SET "location_mode" = 'at_customer' WHERE "address" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK ("orders"."status" IN ('requested', 'quoted', 'confirmed', 'in_progress', 'completed', 'declined', 'cancelled_by_user', 'cancelled_by_business', 'no_show', 'expired'));--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_location_mode_check" CHECK ("searches"."location_mode" IN ('at_business', 'at_customer', 'pickup_delivery'));