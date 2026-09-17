ALTER TABLE "searches" ADD COLUMN "businesses_matched" integer;--> statement-breakpoint
ALTER TABLE "searches" ADD COLUMN "slot_conflicts" integer DEFAULT 0 NOT NULL;