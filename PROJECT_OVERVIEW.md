# Pink.TT — Complete Project Overview

**A women-only rideshare platform for Trinidad & Tobago.**
Owner: Elliot Maillard · Live: https://pinktt.onrender.com · Repo: `maillardelliot25-max/Pink.tt`

This document explains what the app is, how it is built, what every feature does, and
what is left before a public launch. It is written to be read cold — by the owner, by
another developer, or by another AI assistant picking the project up.

---

## 1. What the product is

Pink.TT connects **women riders with verified women drivers** across Trinidad & Tobago.
The premise is safety: every driver is identity-checked and manually approved, every ride
can be tracked live by someone the rider trusts, and an SOS button reaches the platform's
safety team and the rider's emergency contact with the rider's real GPS position attached.

It runs as a **Progressive Web App** — it works in any mobile browser and can be installed
to the home screen like a native app. There is no App Store / Play Store presence, which
is deliberate: publishing to either store requires paid developer accounts, and this
project has been built end-to-end under a hard constraint of **no paid services at all**.

Three user roles share one codebase:

| Role | What they do |
|---|---|
| **Rider** | Books rides now or for later, sets up recurring commutes, tracks the driver live, shares trips, earns Pink Points, redeems promos, triggers SOS |
| **Driver** | Goes online, receives nearby ride requests, accepts and drives them, tracks earnings and tier status, triggers SOS |
| **Admin** | Approves/rejects driver applications, monitors SOS events, manages the marketplace listings, sees platform stats, wipes test data |

---

## 2. Technology stack (and why it looks unusual)

This is **not** a typical React/Next.js app. It is deliberately minimal:

| Layer | Technology |
|---|---|
| Frontend | **One file** — `public/index.html`. Vanilla JavaScript, no framework, no build step, no bundler, no TypeScript |
| Backend | **Node.js + Express** (`server.js`), single file |
| Realtime | **WebSockets** (`ws`) for live ride status, driver pings, SOS alerts |
| Database | **Abstraction layer** that runs on Postgres (Supabase), Turso, or local SQLite — whichever is configured |
| Hosting | **Render** free tier |
| Maps | **Leaflet** (self-hosted), OpenStreetMap tiles |
| Geocoding | **Nominatim** (OpenStreetMap) — free, no API key |
| Routing | **OSRM** public demo server — free, no API key |
| ID verification | **Google Gemini** vision API (`gemini-3.6-flash`) |
| Email | **Nodemailer** via Gmail |
| SMS | **TextBelt** free tier |

**Why single-file, no framework?** Every dependency is a thing that can break, cost money,
or need a build pipeline. The whole app ships as static HTML plus one Node process. It
deploys by pushing to git. There is nothing to compile.

**Important for anyone extending it:** requests to add React components (`.tsx`), Tailwind
classes, or Supabase Edge Functions cannot be dropped in as-is — none of those exist in
this project. Features must be written as vanilla JS in `public/index.html` and Express
handlers in `server.js`, or the app has to be rewritten first.

### The database abstraction

`dbGet` / `dbAll` / `dbRun` / `dbInit` wrap whichever backend is configured. Schema is
declared once in SQLite syntax and auto-translated for Postgres (`?` → `$1`,
`datetime('now')` → `now()`, `COLLATE NOCASE` stripped).

This has a real consequence: **Postgres-only types cannot be used.** PostGIS
`geography(POINT, 4326)` would break SQLite and Turso, so all coordinates are stored as
plain `lat`/`lng` REAL columns and distances computed with a haversine helper in
application code. This is a deliberate trade-off, not an oversight.

Schema changes are additive-only, applied through a `MIGRATIONS_SQL` array of
`ALTER TABLE ... ADD COLUMN` statements that run safely against already-deployed
databases.

**Tables:** `users`, `driver_profiles`, `rides`, `payments`, `sos_events`,
`notifications`, `settings`, `audit_log`, `businesses`, `driver_tiers`,
`recurring_schedules`, `scheduled_ride_legs`.

---

## 3. Features in detail

### 3.1 Booking a ride

The rider enters pickup and destination. Addresses autocomplete from live Nominatim
search rather than a fixed list of place names. If the geocoder returns only a broad area
(a suburb rather than a street), the app **flags it as imprecise and disables the Book
button until the rider confirms the pin on the map** — a wrong pickup point in a safety
app is a serious failure, not a cosmetic one.

The rider can also **tap the map to open a fullscreen pin picker**, pan to an exact spot,
and have it reverse-geocoded — for locations that simply are not in OpenStreetMap.

Fares are calculated server-side:

```
per-km:  first 20km at TTD $1.75/km, beyond 20km at $3.00/km
per-min: $1.10/min
minimum: TTD $28
```

Routing uses real road distance from OSRM, falling back to straight-line haversine if the
routing service is unreachable, so a booking never fails because of a third-party outage.

### 3.2 Dispatch

When a ride is booked, the server finds every **approved, online** driver within
**34 km** of the pickup point and pushes a targeted WebSocket alert to each. If nobody
accepts, a sweep re-pings every 30 seconds, and the rider can manually re-ping with a
20-second cooldown. A driver who was mid-ride or not looking when the request first went
out will therefore still hear about it.

### 3.3 Scheduled rides

A rider can book for a future time (15 minutes to 30 days ahead). The ride sits as
`scheduled` with no driver notified. A server sweep promotes it to a live dispatch the
moment its time arrives, and pushes the rider straight into the tracking view.

### 3.4 Recurring commutes

For repeating trips — "Mon–Fri, 07:30, home to work":

1. The rider defines the pattern once (route, time, days).
2. The server **matches a primary and backup driver** from the pool of drivers whose tier
   permits recurring work, ranked by distance to pickup with rating breaking ties.
   Matching deliberately **ignores who is currently online** — a commute three mornings
   away should not be limited to whoever happens to be driving right now.
3. The server **materialises 14 days of individual legs** in advance, so both rider and
   driver can see exactly what is coming. Generation is duplicate-safe and re-runnable.
4. A **dispatcher runs every 15 minutes**: any leg due within the next 30 minutes becomes
   a real ride, is pushed at its assigned driver, **and** broadcast to the normal nearby
   pool (the assigned driver may be offline, and a commute must not silently go unserved).
   It then tops the 14-day horizon back up so schedules never run dry.

Cancelling frees the driver's reserved slot and removes only future queued legs —
already-dispatched and completed legs remain as history.

### 3.5 Safety features

- **SOS** — available to riders *and* drivers. Sends the user's real GPS position (not a
  hardcoded city centre), logs an event, alerts the admin console in real time, and emails
  the safety team. Admin can resolve alerts, and resolution persists server-side.
- **Live trip sharing** — a public link showing the trip in progress, for someone the
  rider trusts.
- **Report driver** — in-app incident reporting.
- **Emergency contact** — captured at signup, alerted on SOS.

### 3.6 Identity verification

New drivers upload a licence photo. It is sent to **Google Gemini's vision model**, which
checks that the document is a plausible ID and extracts details for the admin to review.
Admin makes the final approve/reject call — the AI assists, it does not decide.

### 3.7 Driver tiers

Drivers earn a better commission split by sustaining quality:

| Tier | Platform takes | Driver keeps | Requires | Recurring work |
|---|---|---|---|---|
| Standard | 20% | **80%** | — | No |
| Preferred | 15% | **85%** | 4.6★ · 50 trips | Yes |
| VIP | 10% | **90%** | 4.85★ · 200 trips | Yes |

Thresholds and rates live in a **database table, not constants**, so they can be tuned
without a redeploy. A driver's tier is resolved live from their current rating and trip
count on every load, so the badge can never drift stale. Points discounts never reduce the
driver's payout — earnings are computed from the pre-discount fare.

### 3.8 Pink Points (rider loyalty)

- Earn **1 point per TTD $1** actually paid, multiplied by rider tier
  (Bronze ×1.0 · Silver ×1.25 at 500 lifetime · Gold ×1.5 at 2,000 lifetime)
- Redeem at **20 points = TTD $1**
- Capped at **50% of any single fare**

### 3.9 Marketplace ("Discover")

A directory of women-owned businesses — salons, spas, wellness. Fully admin-managed
(add/remove/feature/activate), backed by a real table. It started as hardcoded placeholder
data and was rebuilt as genuine CRUD.

### 3.10 Admin console

Driver approvals with licence photo review, live SOS monitoring, marketplace management,
promo codes, platform statistics, staff account creation, audit logging, and a
**password-verified** destructive "wipe all ride and payment data" action (verified
server-side against the admin's real password hash — not just a confirm dialog).

---

## 4. Design language

The app uses an **Apple "Liquid Glass"-inspired** interface: translucent frosted panels
over a full-screen looping pink topographic video backdrop, with layered shadows giving
every card a raised, three-dimensional feel.

Two design principles were learned the hard way during development and are worth
preserving:

1. **Legibility outranks the effect.** Blur strength and panel opacity are tuned so the
   backdrop reads as soft diffuse colour behind text, never as sharp competing detail.
   Any element that sits directly on the backdrop — empty states, section headings — is
   given its own bubble rather than left as bare text.
2. **Smoothness is a feature.** All depth is `box-shadow`, all motion is
   `transform`/`opacity`. Nothing forces layout recalculation while scrolling.

The landing page opens as a full-viewport cover showing only the logo over the wallpaper;
the pitch and calls to action are one scroll below.

---

## 5. Testing

`scripts/regression.js` is a Playwright suite of **23 checks** covering login for all four
demo accounts, every rider tab with narrow-screen overflow checks, the backdrop video, the
full onboarding carousel including returning-visitor behaviour, `/api/db` payload scoping
(each role only ever sees its own data), and the admin dashboard. Run it against a fresh
local database before every push: `rm -f pinktt.db*; node server.js &` then
`node scripts/regression.js` (set `PW_CHROMIUM_PATH` to pin a specific browser binary if
Playwright can't find one on its own).

The same suite now also runs in CI (`.github/workflows/regression.yml`) on every push and
pull request, against a freshly seeded local SQLite database — no secrets required.

A mutation cross-check verifies that **every client-side action has a matching server
handler** — this catches a specific recurring bug class in this codebase where UI existed
and appeared functional but only ever mutated local state without reaching the server.

---

## 6. Known gaps before public launch

| # | Gap | Blocked by |
|---|---|---|
| 1 | ~~Cold starts~~ — **resolved**: `.github/workflows/keepalive.yml` pings the live app every 10 min via GitHub Actions (free, no external signup needed) | Done |
| 2 | **Demo accounts still enabled** (`SHOW_DEMO_ACCOUNTS=true`) | One env var change — **must** be off before real customers |
| 3 | **Domain** — still `pinktt.onrender.com`, not `pink.tt` | Registration/payment |
| 4 | **Card payments** — cash only today | Requires a paid processor (Stripe et al.) |
| 5 | **Push notifications** when the app is closed | Requires a paid/registered push service |
| 6 | **SMS** limited to TextBelt's free quota | Requires Twilio or equivalent |
| 7 | ~~No automated CI~~ — **resolved**: `.github/workflows/regression.yml` runs the full regression suite on every push/PR | Done |

Items 4–6 are blocked by the no-paid-services constraint rather than by engineering
effort. **Item 2 is the one thing standing between the current build and a real
public launch**, and it is minutes of work.

---

## 7. Notes for an AI assistant picking this up

- **Do not assume a framework.** There is no React, no Tailwind, no TypeScript, no build
  step. Frontend work happens in `public/index.html`.
- **Do not use Postgres-only SQL.** The same schema must create cleanly on SQLite and
  Turso. No PostGIS, no array columns, no `timestamptz`.
- **New server tables must be registered in two places** — exposed in `buildDB()` *and*
  declared in the client's `DB` literal. The client loader only copies keys that already
  exist locally, so a missing declaration silently drops the data with no error.
- **Watch CSS specificity with ID selectors.** Rules like `#container > *` beat class
  rules and have twice broken full-bleed background videos by overriding
  `position: absolute`.
- **Verify before claiming.** This codebase has repeatedly contained UI that looked
  functional but never reached the server. Test the persistence, not the rendering.
