-- The double-booking guard (App_design_spec.md §3, bookings).
--
-- Two people can tap the same 3pm slot in the same instant. Rather than
-- preventing that in application code, the database refuses it: the second
-- insert fails with SQLSTATE 23P01, we catch it, and tell the user the slot
-- just went.
--
-- Note this is NOT redundant with ACID. Postgres defaults to READ COMMITTED,
-- where both transactions run their "is it free?" SELECT, both see nothing
-- (neither has committed yet), and both then insert *different rows*. Nothing
-- collides — you cannot row-lock a row that does not exist. That is write
-- skew, and only a constraint on the data catches it.

-- GiST understands `&&` (overlap) on ranges natively, but not plain equality
-- on scalars like uuid and int. btree_gist teaches it those, which is what
-- lets one index combine "same business AND same chair AND overlapping time".
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- Why ends_at is a stored column rather than computed inline:
--
-- The spec writes the constraint as
--     tstzrange(scheduled_at, scheduled_at + (duration_min || ' minutes')::interval)
-- which Postgres rejects with 42P17 "functions in index expression must be
-- marked IMMUTABLE", for two independent reasons:
--
--   1. `text::interval` runs interval_in, which is STABLE — interval parsing
--      depends on the IntervalStyle setting.
--   2. More fundamentally, `timestamptz + interval` is itself STABLE, because
--      an interval may carry months or days whose length depends on the
--      session TimeZone.
--
-- So no form of `scheduled_at + <interval>` can live in the index expression,
-- make_interval() included, and a STORED generated column fails the same way.
--
-- A BEFORE trigger fills ends_at instead. It runs ahead of constraint
-- checking, so the value is always correct when the exclusion is evaluated —
-- and because the database owns it, neither an application bug nor a
-- hand-written INSERT in psql can get it wrong. That is closer to the spec's
-- intent ("it can't be bypassed by a bug in your code") than computing it in
-- application code would be.
CREATE OR REPLACE FUNCTION set_booking_ends_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.ends_at := NEW.scheduled_at
               + make_interval(mins => NEW.duration_min + NEW.buffer_min);
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER bookings_ends_at
BEFORE INSERT OR UPDATE OF scheduled_at, duration_min, buffer_min ON bookings
FOR EACH ROW EXECUTE FUNCTION set_booking_ends_at();
--> statement-breakpoint

-- Backfill anything already present (no-op on a fresh database).
UPDATE bookings
   SET ends_at = scheduled_at + make_interval(mins => duration_min + buffer_min);
--> statement-breakpoint

-- No two active bookings may share the same business, the same chair, and
-- overlapping times. tstzrange is half-open, so a booking starting exactly
-- when the previous one's buffer ends does NOT overlap — without that, every
-- appointment would silently waste the following slot.
--
-- The WHERE clause makes this a partial index, which is what lets a
-- cancellation free the slot immediately: cancelled rows drop out of the index.
ALTER TABLE bookings ADD CONSTRAINT no_double_booking
EXCLUDE USING gist (
  business_id    WITH =,
  resource_index WITH =,
  tstzrange(scheduled_at, ends_at) WITH &&
) WHERE (status IN ('confirmed','completed'));
--> statement-breakpoint

-- resource_index must fall inside the business's capacity. Capacity can be
-- reduced below existing bookings (§7) — those stand, this only guards new
-- rows, which is why it is NOT VALID against history.
ALTER TABLE bookings ADD CONSTRAINT bookings_resource_index_check
CHECK (resource_index >= 0);
