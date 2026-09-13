# Application Design Document

**Scope:** Web only, English only, Dubai, no payments. LangSmith for tracing and evals.

Every table, endpoint and query below has a plain description of what it does.

## Contents

**Part I — Overview**
1. What the app is
2. Architecture

**Part II — Data**
3. Database

**Part III — Agent and Search Logic**
4. The agent
5. Finding options
6. Booking
7. Edge cases

**Part IV — Interfaces**
8. API
9. Background jobs
10. Frontend routes

**Part V — Quality and Delivery**
11. Evals and tracing
12. Deployment
13. Build order
14. Decisions to confirm

---
---

# Part I — Overview

---

## 1. What the app is

A user opens a chat and types what they need. "Haircut tomorrow afternoon." The agent works out what they mean, finds businesses that can do it, and shows real available times with real prices. The user picks one and it's booked.

Businesses sign up separately, list what they offer, set their hours and how many people they can serve at once, and manage bookings in a calendar.

Because businesses run their bookings here, we know when they're actually free. That's what lets the agent show real times instead of guessing.

**It does not:** take payments, sync with other booking systems, show businesses that haven't signed up, or book anything without the user picking.

---

## 2. Architecture

Two programs.

**The website** (Next.js on Vercel) is everything a person sees, plus all the API endpoints. The agent runs inside it. Booking happens here too, start to finish, in about three seconds.

**The worker** (a plain Node process on Railway) runs scheduled jobs. Reminders an hour before an appointment, marking bookings complete, the nightly scan for recurring services. Vercel kills functions after a few seconds so it can't run these, which is why the worker is separate.

They share a Postgres database. When the website needs the worker to do something later, it drops a job into Redis and the worker picks it up.

```
Website (Vercel) ──→ Postgres ←── Worker (Railway)
        │                             ↑
        └────────→ Redis ─────────────┘
```

---
---

# Part II — Data

---

## 3. Database

17 tables.

### users

Everyone who signs up. Clerk handles the actual login, so this table just holds our own copy plus fields Clerk doesn't store, like their home address.

```sql
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id   text UNIQUE NOT NULL,     -- links to the Clerk account
  phone           text UNIQUE,
  name            text,
  email           text,
  home_lat        numeric(9,6),             -- default starting point for distance
  home_lng        numeric(9,6),
  home_address    text,
  timezone        text NOT NULL DEFAULT 'Asia/Dubai',   -- used to read "tomorrow"
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

### business_members

Says which people work at which business. If someone has no row here, they only see the customer side of the app.

```sql
CREATE TABLE business_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner','staff')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);
```

Owners can change prices and hours. Staff can only manage bookings.

### categories

The list of business types the app supports. Barber, dentist, AC repair, and so on. You fill this table yourself, users never add to it.

Two columns hold JSON that controls behaviour elsewhere, so adding a new category needs no code changes.

```sql
CREATE TABLE categories (
  id                     text PRIMARY KEY,     -- 'barber', 'ac_maintenance'
  name                   text NOT NULL,
  group_name             text NOT NULL,        -- 'Personal care', for grouping in menus
  onboarding_schema      jsonb NOT NULL,       -- extra questions on the signup form
  request_schema         jsonb NOT NULL,       -- what the agent must find out
  agent_hints            text,                 -- helps the agent recognise this category
  default_duration_min   int NOT NULL DEFAULT 30,
  default_radius_km      int NOT NULL DEFAULT 10,   -- how far people will travel
  recurring_default_days int,                   -- e.g. 120 for AC. NULL if not recurring
  active                 boolean NOT NULL DEFAULT true
);
```

**`onboarding_schema`** lists extra fields to show on the business signup form. A barber gets asked about walk-ins, an AC company gets asked about callout fees.

```json
{ "fields": [
  { "key": "walk_ins", "type": "bool", "label": "Accept walk-ins", "required": true }
]}
```

**`request_schema`** lists what the agent must know before it can search. Different per category.

```json
{ "required": ["service", "time_window"],
  "optional": ["gender_preference", "budget_max"] }
```

### canonical_services

A shared list of service names, one set per category. Every business picks from this list.

The point is that one barber writes "Men's Cut" and another writes "Gents Haircut", but both map to the same row here. Without it, finding every business that does haircuts would mean comparing text.

```sql
CREATE TABLE canonical_services (
  id                   text PRIMARY KEY,      -- 'mens_haircut'
  category_id          text NOT NULL REFERENCES categories(id),
  name                 text NOT NULL,         -- "Men's Haircut"
  aliases              text[] NOT NULL DEFAULT '{}',  -- other words users might say
  typical_duration_min int NOT NULL DEFAULT 30,
  active               boolean NOT NULL DEFAULT true
);
```

`aliases` gets fed to the agent so it recognises "trim" or "hair cut" as the same service.

### businesses

One row per business. Where they are, how to reach them, and the rules for how they can be booked.

```sql
CREATE TABLE businesses (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  category_id        text NOT NULL REFERENCES categories(id),
  lat                numeric(9,6) NOT NULL,   -- geocoded once at signup
  lng                numeric(9,6) NOT NULL,
  address            text NOT NULL,
  city               text NOT NULL,
  phone              text NOT NULL,
  email              text,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','active','suspended')),
  attributes         jsonb NOT NULL DEFAULT '{}',  -- answers to onboarding_schema
  radius_km          int,                     -- how far they serve. NULL = category default
  capacity           int NOT NULL DEFAULT 1,
  slot_interval_min  int NOT NULL DEFAULT 30,
  buffer_min         int NOT NULL DEFAULT 0,
  lead_time_min      int NOT NULL DEFAULT 60,
  max_advance_days   int NOT NULL DEFAULT 60,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
```

The five scheduling columns:

**`capacity`** — how many people they can serve at the same time. A barbershop with three chairs is 3.

**`slot_interval_min`** — the spacing of bookable times. 30 means appointments start on the hour and half hour only.

**`buffer_min`** — gap forced after every appointment, for cleanup or travel.

**`lead_time_min`** — how far in advance you must book. 60 stops someone booking a slot ten minutes from now.

**`max_advance_days`** — how far ahead you can book. Stops someone booking next year.

**`status`** — new signups start as `pending` and you approve them. `suspended` hides them from search but keeps their existing bookings.

### business_services

What one business offers and what they charge. A barber with three services has three rows.

```sql
CREATE TABLE business_services (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  canonical_service_id  text NOT NULL REFERENCES canonical_services(id),
  display_name          text NOT NULL,     -- what they call it on their own menu
  price_aed             numeric(10,2) NOT NULL,
  duration_min          int NOT NULL,      -- how long it takes at this business
  active                boolean NOT NULL DEFAULT true,
  UNIQUE (business_id, canonical_service_id)
);
```

A business with no active rows here will never appear in any search.

### business_hours

Normal opening hours. One row per day of the week they're open.

```sql
CREATE TABLE business_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day_of_week  smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0 = Sunday
  opens_at     time NOT NULL,
  closes_at    time NOT NULL,
  UNIQUE (business_id, day_of_week)
);
```

No row for a day means they're closed that day.

### business_closures

One-off periods when they're shut even though their normal hours say open. Eid, holidays, or the owner blocking out Thursday afternoon.

```sql
CREATE TABLE business_closures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  reason       text
);
```

Kept separate from hours so a two-week holiday doesn't mean editing the weekly schedule and putting it back afterwards.

### business_stats

Running counters, updated as things happen. Used to decide who ranks first in search results.

```sql
CREATE TABLE business_stats (
  business_id               uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  times_shown               int NOT NULL DEFAULT 0,   -- appeared in someone's options list
  times_selected            int NOT NULL DEFAULT 0,   -- the user picked them
  bookings_total            int NOT NULL DEFAULT 0,
  bookings_completed        int NOT NULL DEFAULT 0,
  cancellations_by_business int NOT NULL DEFAULT 0,
  no_shows                  int NOT NULL DEFAULT 0,
  updated_at                timestamptz NOT NULL DEFAULT now()
);
```

`times_shown` against `times_selected` gives you a selection rate, which is the main signal for whether users like a business.

### business_push_subscriptions

Browser push notification details. One row per browser per staff member, so a business with two people on two laptops has four rows.

```sql
CREATE TABLE business_push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE,     -- the browser's push URL
  p256dh_key    text NOT NULL,            -- encryption keys the browser gives you
  auth_key      text NOT NULL,
  failed_count  int NOT NULL DEFAULT 0,   -- delete the row after repeated failures
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
```

### conversations

A chat thread between one user and the agent.

```sql
CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

### messages

Every message in a conversation, from both the user and the agent.

```sql
CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user','assistant','system')),
  content          text NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}',   -- langsmith run id, model, cost
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

`metadata` is where you stash the LangSmith run ID so you can jump from a message to its trace.

### agent_state

What the agent has worked out so far in this conversation. One row per conversation, overwritten each turn.

```sql
CREATE TABLE agent_state (
  conversation_id  uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  state            jsonb NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
```

It's in the database rather than memory so a server restart doesn't lose someone's half-finished request.

```json
{
  "category_id": "barber",
  "mode": "search",
  "slots": { "service": "mens_haircut", "time_window": { "start": "...", "end": "..." } },
  "asked_about": ["service"]
}
```

`asked_about` stops the agent asking the same question twice.

### searches

One thing a user wants booked. Created once the agent has enough information.

```sql
CREATE TABLE searches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id),
  conversation_id       uuid NOT NULL REFERENCES conversations(id),
  category_id           text NOT NULL REFERENCES categories(id),
  canonical_service_id  text REFERENCES canonical_services(id),
  mode                  text NOT NULL DEFAULT 'search'
                        CHECK (mode IN ('search','direct','reminder')),
  named_business_id     uuid REFERENCES businesses(id),
  window_start          timestamptz NOT NULL,
  window_end            timestamptz NOT NULL,
  lat                   numeric(9,6) NOT NULL,
  lng                   numeric(9,6) NOT NULL,
  constraints           jsonb NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'gathering'
                        CHECK (status IN ('gathering','presenting','booked',
                                          'no_results','abandoned')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start)
);
```

**`mode`** — how the search started. `search` is normal. `direct` is when the user named a business. `reminder` is when the agent nudged them first.

**`window_start` / `window_end`** — the time range the user is happy with. "Tomorrow afternoon" becomes 12:00 to 17:00. Always a range, never a single time.

**`lat` / `lng`** — where they want it. Copied from their home address unless they said otherwise.

**`constraints`** — the optional stuff: `{ "budget_max": 80, "notes": "no clippers" }`

**`status`** — `gathering` while the agent is still asking questions, `presenting` once options are on screen, then one of the three endings.

### search_options

The businesses we showed for a search, and which one the user picked.

```sql
CREATE TABLE search_options (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id            uuid NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  business_id          uuid NOT NULL REFERENCES businesses(id),
  business_service_id  uuid NOT NULL REFERENCES business_services(id),
  rank                 int NOT NULL,              -- 1 to 5, position we showed them in
  rank_score           numeric(6,4) NOT NULL,     -- the score that produced that position
  price_aed            numeric(10,2) NOT NULL,
  distance_km          numeric(6,2) NOT NULL,
  offered_slots        timestamptz[] NOT NULL,    -- up to 3 free times
  presented_at         timestamptz NOT NULL DEFAULT now(),
  selected_at          timestamptz,               -- filled in if the user chose this one
  UNIQUE (search_id, business_id)
);
```

Keeping `rank` and `selected_at` means you can later ask "when we put someone first, how often did people pick them?" That's how you tell whether your ranking is any good, without labelling anything by hand.

### bookings

A confirmed appointment.

```sql
CREATE TABLE bookings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id            uuid REFERENCES searches(id),
  business_id          uuid NOT NULL REFERENCES businesses(id),
  user_id              uuid NOT NULL REFERENCES users(id),
  business_service_id  uuid NOT NULL REFERENCES business_services(id),
  resource_index       int NOT NULL DEFAULT 0,
  scheduled_at         timestamptz NOT NULL,
  duration_min         int NOT NULL,
  price_aed            numeric(10,2) NOT NULL,
  status               text NOT NULL DEFAULT 'confirmed'
                       CHECK (status IN ('confirmed','completed','cancelled_by_user',
                                         'cancelled_by_business','no_show')),
  cancelled_reason     text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
```

**`resource_index`** — which chair or bay this booking uses. A shop with capacity 3 uses 0, 1 and 2. It's what lets three people book 3pm without clashing.

**`price_aed`** — copied here rather than read from `business_services`. If the business raises prices tomorrow, this booking still shows what was agreed.

**The double-booking guard.** Two people could tap the same 3pm slot at the same moment. Rather than trying to prevent that in code, the database refuses it:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings ADD CONSTRAINT no_double_booking
EXCLUDE USING gist (
  business_id    WITH =,
  resource_index WITH =,
  tstzrange(scheduled_at, scheduled_at + (duration_min || ' minutes')::interval) WITH &&
) WHERE (status IN ('confirmed','completed'));
```

In plain terms: no two active bookings can share the same business, the same chair, and overlapping times. The second insert fails, you catch the error, and tell the user the slot just went.

Cancelled bookings are excluded by the `WHERE`, so cancelling frees the slot immediately.

### recurring_reminders

Things that need doing every few months. AC servicing, car registration, water tank cleaning.

```sql
CREATE TABLE recurring_reminders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id           text NOT NULL REFERENCES categories(id),
  canonical_service_id  text REFERENCES canonical_services(id),
  label                 text NOT NULL,        -- "Living room AC"
  last_done_at          date,
  interval_days         int NOT NULL,         -- 120 for AC
  next_due_at           date NOT NULL,        -- last_done_at + interval_days
  lead_days             int NOT NULL DEFAULT 14,   -- nudge this many days early
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','snoozed','cancelled')),
  last_nudged_at        timestamptz,          -- stops it nagging daily
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
```

The user says "AC was serviced in March." The agent reads a date out of that, looks up 120 days from the category, and stores it. A nightly job finds anything due soon and messages them.

---
---

# Part III — Agent and Search Logic

---

## 4. The agent

Runs inside the chat endpoint. It is not a general chatbot. Its only job is to work out what the user wants, then hand off to search.

Four model calls per message.

**1 · Route.** Works out what kind of message this is: a new request, more detail on the current one, picking an option, cancelling, rescheduling, or a question. Uses a cheap fast model.

If this is wrong the whole turn feels broken. "Actually make it 4pm" answered as a brand new request is the failure people notice most.

**2 · Detect category and mode.** Maps the message to a row in `categories`. Also spots whether the user named a specific business, which sets `mode` to `direct`.

If it isn't confident, it asks rather than guessing between plumber and handyman.

**3 · Extract slots.** Looks up `request_schema` for that category and pulls out whatever the user has said. Service names are matched against `canonical_services.aliases`.

**4 · Parse the time window.** Turns loose phrasing into a start and end time, using the user's timezone.

```
"3pm tomorrow"        → 14:45 to 15:15 tomorrow
"tomorrow afternoon"  → 12:00 to 17:00 tomorrow
"this week sometime"  → now to Sunday 23:59
"asap"                → now + lead time, to now + 4 hours
```

Check the result in code afterwards: reject anything in the past, anything more than two weeks long, or an end before a start.

**Then either ask or search.**

```
missing = required slots that are still empty

if missing:
    ask about ONE of them, note it in asked_about, stop
else:
    create the search row
    find options (section 5)
    show them
```

One question per message. Three questions gets you one answer.

### Direct mode

When the user names a business, resolve the name first. Four outcomes, each needing a different reply:

| Outcome | What to say |
|---|---|
| Found, active, offers the service | Show that business's free times |
| Two branches with the same name | Ask which one, show addresses |
| Not signed up with us | Say so plainly, offer nearby alternatives |
| Signed up but doesn't do that service | Say so, offer alternatives |

---

## 5. Finding options

Three steps. No model calls. All inside the same request.

### Step 1 — Filter

Finds businesses that could possibly do this job. Checks they're active, in the right category, actually offer the service, are close enough, and open on at least one day the user asked about.

```sql
SELECT b.id, b.lat, b.lng, b.capacity, b.slot_interval_min, b.buffer_min,
       b.lead_time_min, b.max_advance_days, b.radius_km,
       bs.id AS business_service_id, bs.price_aed, bs.duration_min,
       COALESCE(st.times_shown, 0)    AS shown,
       COALESCE(st.times_selected, 0) AS selected,
       6371 * acos(
         cos(radians($user_lat)) * cos(radians(b.lat)) *
         cos(radians(b.lng) - radians($user_lng)) +
         sin(radians($user_lat)) * sin(radians(b.lat))
       ) AS distance_km
FROM businesses b
JOIN business_services bs
  ON bs.business_id = b.id
 AND bs.canonical_service_id = $service_id
 AND bs.active
LEFT JOIN business_stats st ON st.business_id = b.id
WHERE b.status = 'active'
  AND b.category_id = $category_id
  AND ($named_business_id IS NULL OR b.id = $named_business_id)
  AND EXISTS (
    SELECT 1 FROM business_hours h
     WHERE h.business_id = b.id
       AND h.day_of_week = ANY($days_in_window)
  )
ORDER BY distance_km
LIMIT 30;
```

Reading it piece by piece:

- The `JOIN` on `business_services` enforces "they actually do haircuts". A business in the barber category with no haircut row won't appear.
- The `acos` block is the distance formula. It returns kilometres between two lat/lng points.
- The `EXISTS` just checks they open on at least one relevant day. Exact opening times get handled properly in step 2.
- `LEFT JOIN` on stats, not `JOIN`, because a brand new business has no stats row yet and shouldn't be excluded for it.
- `$named_business_id IS NULL OR ...` makes this one query serve both normal search and direct mode.

Afterwards, drop any row where `distance_km` is greater than that business's radius.

### Step 2 — Work out free times

For each surviving business, find the times that are actually open in the window the user asked for.

```
for each day in the window:
    look up their hours for that weekday
    start at the first slot on the grid after opening
    for each slot until closing:
        skip it if it overlaps a closure
        count how many bookings already overlap it
        if that count is less than capacity, it's free
        move forward by slot_interval_min
```

Points worth knowing:

- A slot only counts if the whole appointment fits before closing time, not just the start.
- `buffer_min` is added to the appointment length when checking overlaps, so the gap is protected.
- Anything earlier than now plus `lead_time_min` is skipped.
- If a business has no free slots in the window, it's dropped from the results entirely.

Fetch all the bookings and closures for all 30 candidates in **two queries**, then do the rest in memory. Don't query per business per slot.

```sql
-- all existing bookings that could clash, for every candidate at once
SELECT business_id, resource_index, scheduled_at, duration_min
FROM bookings
WHERE business_id = ANY($candidate_ids)
  AND status IN ('confirmed','completed')
  AND scheduled_at < $window_end
  AND scheduled_at + (duration_min || ' minutes')::interval > $window_start;
```

### Step 3 — Rank

Puts the most suitable first. Plain arithmetic on the businesses that have free slots.

```
proximity   = 1 − (distance / radius)                    closer is better
selection   = (times_selected + 2) / (times_shown + 6)   do users pick them
reliability = 1 − (cancellations / bookings)             do they cancel on people
price_fit   = how well the price fits a stated budget, 0.5 if none given
affinity    = 1 if this user has been here before, else 0
exploration = 0.5 if shown fewer than 10 times, else 0

score = 0.25·proximity + 0.25·selection + 0.15·reliability
      + 0.10·price_fit + 0.15·affinity + 0.10·exploration
```

Two of these need explaining:

**The `+2` and `+6` in selection.** A brand new business has been shown zero times and picked zero times, which is a divide by zero. And one shown once and picked once would look perfect. The extra numbers start everyone around 0.33 and fade as real numbers build up.

**Exploration.** Without it, whoever you sign up first appears in every list forever and everyone signed up later gets nothing. The small bonus for businesses under ten impressions keeps that from happening.

Take the top five. Give each up to three free times, spread across the window rather than three in a row.

---

## 6. Booking

### The endpoint

`POST /api/searches/:id/book` with `{ option_id, slot_at }`.

```
BEGIN
  find the option row, check slot_at is one we actually offered
  work out availability again from scratch
  if nothing free → 409, tell the user the slot went
  insert the booking
  mark the search as booked
  mark the option as selected
  bump the business's counters
COMMIT

schedule the reminder job for 1 hour before
schedule the completion job for after the appointment
push a notification to the business
```

**Why recompute.** The options list might be five minutes old. Someone else could have taken that slot. Checking again turns a confusing database error into a clear message.

**Why still keep the constraint.** Two people could book in the same millisecond, after both checks pass. The constraint is the last line of defence and it can't be bypassed by a bug in your code.

**On a 409**, run the search again and show a fresh list. Don't make the user start over.

### After booking

```
confirmed → 1 hour before   → reminder sent to the user
          → after the slot  → marked completed
          → user cancels    → cancelled_by_user
          → business cancels → cancelled_by_business, user told, agent offers to rebook
          → business marks   → no_show
```

---

## 7. Edge cases

| Situation | What happens |
|---|---|
| Slot taken between showing and booking | 409, search again, show a fresh list |
| No business does that service at all | Say so straight away, suggest widening budget or distance |
| Businesses exist but nothing free | Different message: "3 places do this but nothing tomorrow afternoon, try Friday?" |
| Fewer than 5 options | Show what you have, don't pad |
| Named business isn't signed up | Say so plainly, offer nearby alternatives |
| Business cancels a confirmed booking | Count it against them, tell the user, offer to rebook |
| Business raises prices after a booking | Booking keeps the price it was made at |
| Business suspended with future bookings | Existing bookings stand, they stop appearing in new searches |
| Capacity reduced below existing bookings | Existing bookings stand, new slots use the new number |
| User books two overlapping things | Allowed. Warn, don't block. |
| Time window is in the past | Rejected during parsing, agent asks again |

---
---

# Part IV — Interfaces

---

## 8. API

### Public

**`GET /api/categories`** — the list of business types. Used by the signup dropdown and by the agent.

**`GET /api/categories/:id/onboarding-schema`** — the extra questions to show on the signup form for this category.

**`GET /api/categories/:id/services`** — the canonical service list, so a business picks from it rather than typing.

### User app

**`POST /api/chat/messages`** — the main endpoint. Takes a message, runs the four agent steps, then either asks a question or runs the search and returns options. Takes about three seconds.

**`GET /api/chat/conversations/:id/messages`** — message history, paged backwards for scrolling up.

**`GET /api/searches/:id`** — a search and its current options. Used on page load and after a 409.

**`POST /api/searches/:id/book`** — books a chosen slot. Returns 201 with the booking, or 409 with a fresh options list if the slot went.

**`POST /api/searches/:id/abandon`** — the user walked away. Keeps your booking-rate numbers honest.

**`GET /api/bookings`** — their upcoming and past appointments.

**`POST /api/bookings/:id/cancel`** — cancels. Frees the slot immediately.

**`POST /api/bookings/:id/reschedule`** — cancel and rebook at the same business, in one transaction.

**`GET POST PATCH DELETE /api/reminders`** — recurring services. Usually created by the agent from conversation, but the settings screen needs these.

**`GET PATCH /api/me`** — profile, including home address and timezone.

### Business app

**`POST /api/business/signup`** — creates the business as `pending`.

**`GET PATCH /api/business/me`** — profile and the scheduling rules: capacity, slot interval, buffer, lead time, how far ahead.

**`GET POST PATCH DELETE /api/business/services`** — what they offer and charge.

**`GET PUT /api/business/hours`** — weekly opening hours. PUT replaces all of them at once, since the UI is a grid.

**`GET POST DELETE /api/business/closures`** — holidays and blocked periods.

**`GET /api/business/calendar?from=&to=`** — their bookings in a date range. This is the main screen.

**`POST /api/business/bookings/:id/cancel`** — cancel a booking, with a reason.

**`POST /api/business/bookings/:id/no-show`** — the customer didn't turn up.

**`POST /api/business/bookings/:id/complete`** — manual override, since the worker normally does this.

**`GET /api/business/stats`** — how often they were shown, how often picked, bookings, cancellations.

**`POST DELETE /api/business/push/subscribe`** — register or remove a browser for push notifications.

### Admin

**`GET /api/admin/businesses?status=pending`** — the approval queue.

**`PATCH /api/admin/businesses/:id`** — approve or suspend.

### Webhooks

**`POST /api/webhooks/twilio/status`** — delivery receipts for reminder SMS.

---

## 9. Background jobs

Redis and BullMQ. Every job checks state before acting, so running it twice does no harm.

**`booking.reminder`** — messages the user an hour before. Does nothing if the booking was cancelled.

**`booking.complete`** — marks a booking `completed` after the appointment time, if it's still `confirmed`.

**`reminders.scan`** — runs nightly. Finds recurring reminders coming due and messages the user:

```
find reminders where next_due_at minus lead_days is today or earlier
  and we haven't nudged in the last 7 days

for each one:
  add an assistant message: "your AC is due, want me to find someone?"
  set last_nudged_at
  send a push notification
```

If the user says yes, it becomes a normal search with the category and service pre-filled.

**`stats.recompute`** — rebuilds `business_stats` from scratch nightly, in case the live counters drift.

**`push.prune`** — weekly. Deletes push subscriptions that keep failing.

---

## 10. Frontend routes

### User app

| Route | What it is |
|---|---|
| `/` | Landing page. Sends signed-in users to `/chat`. |
| `/chat` | The product. Messages, option cards with time pickers, confirmation. |
| `/chat/[id]` | An older conversation. |
| `/bookings` | Upcoming and past. Cancel, reschedule. |
| `/reminders` | Recurring services, when each is next due. |
| `/settings` | Name, phone, home address with a map picker, timezone. |
| `/onboarding` | First run. Collects phone and address, both needed before booking. |

### Business app

| Route | What it is |
|---|---|
| `/business` | Sends them to signup, the waiting screen, or the calendar. |
| `/business/signup` | Multi-step form: category, address, category-specific questions, services and prices, hours, capacity. |
| `/business/pending` | Waiting for approval. |
| `/business/calendar` | Main screen. Day and week view, split by chair. Block time inline. |
| `/business/bookings/[id]` | One booking. Cancel, no-show, complete. |
| `/business/services` | Services and prices. |
| `/business/hours` | Weekly grid and closures. |
| `/business/stats` | Shown, picked, booked, cancelled. |
| `/business/settings` | Radius, capacity, slot interval, buffer, lead time, staff. |

### Admin

| Route | What it is |
|---|---|
| `/admin/businesses` | Approve, suspend, pending queue. |
| `/admin/categories` | Categories and canonical services. |

---
---

# Part V — Quality and Delivery

---

## 11. Evals and tracing

LangSmith for both.

**Tracing.** Put `@traceable` on each agent step. One trace per chat message, showing all four model calls plus the three search steps, with timings and costs. Everything is synchronous so there's nothing to stitch together across processes.

**Datasets.** Four things worth measuring:

| Dataset | Size | What you label | What you measure |
|---|---|---|---|
| Category detection | 200 | the correct category | accuracy, plus which pairs get confused |
| Slot extraction | 150 | service, window, constraints | how often each field is right |
| Time parsing | 100 | correct start and end | exact matches, and near misses |
| Direct name resolution | 60 | which business, or which failure | accuracy across the four outcomes |

For category detection the confusion pairs matter more than the overall score, because plumber-versus-handyman is the failure that actually hurts.

Time parsing is the one to watch. A wrong window doesn't throw an error, it quietly searches the wrong day.

**Ranking measures itself.** You don't need a labelled dataset for this. Every time a user picks from a list of five, that's a label. If the one you ranked first gets picked 60% of the time your ranking works. If it's 20%, it doesn't.

**In CI.** Any change to a prompt runs the datasets, compares against the last run on main, and fails the build if something drops more than 3 points. Then run the same datasets across a few models and publish the quality-against-cost table.

**Product numbers to watch:** booking rate, time from first message to booking, selection rate by position, how often searches find businesses but no free times, how often the 409 fires, how many reminders turn into bookings, cost per booking.

---

## 12. Deployment

| Piece | Where | Note |
|---|---|---|
| Website | Vercel | UI and API |
| Worker | Railway or Fly | Scheduled jobs only |
| Database | Neon or Supabase | needs the `btree_gist` extension |
| Redis | Upstash | job queue |
| Push | Web Push with VAPID keys | no Firebase needed |
| SMS | Twilio | reminder fallback |
| Auth | Clerk | |
| Tracing and evals | LangSmith | |

Check `btree_gist` is available on your database host in week one, not week five. Without it the double-booking constraint won't work.

---


## 14. Decisions to confirm

1. New businesses are `pending` until you approve them.
2. The agent asks rather than guessing when it isn't confident about the category.
3. Show 5 options, up to 3 times each.
4. `capacity` treats chairs as interchangeable. Booking a specific named stylist would need another table.
5. Ranking weights as listed in section 5.
6. Users can double-book themselves. Warn, don't block.
7. Reminders nudge 14 days early, at most once a week.
9. No ratings or reviews. Selection rate does that job internally.