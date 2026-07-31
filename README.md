# 🌸 Pink.TT — Production Server

Women-only rideshare platform for Trinidad & Tobago.
Real backend · Real accounts · Real-time ride matching · Live GPS tracking

---

## Quick Start

```bash
# 1. Install dependencies (first time only)
npm install

# 2. Start the server
node server.js

# 3. Open in browser
# Local:   http://localhost:3000
# Network: http://YOUR_LOCAL_IP:3000  ← share this with others
```

The server prints the network URL on startup. Anyone on your WiFi who opens that URL
can sign up, book rides, and interact with real drivers in real time.

---

## How It Works

- **Database** — checked in this order: Postgres (e.g. Supabase) if `DATABASE_URL` is set, else Turso (libSQL) if `TURSO_DATABASE_URL` is set, else local SQLite (`pinktt.db`) for dev
- **WebSocket** — riders and drivers communicate in real time (no refresh needed)
- **JWT auth** — secure tokens, 30-day sessions (set `JWT_SECRET` in production)
- **Live map** — CARTO/OpenStreetMap tiles, Leaflet.js, animated GPS tracking
- **ID verification** — riders and drivers upload a photo after registering; `POST /api/verify-id` calls the Anthropic API server-side (key never reaches the browser) to confirm the account is eligible for this women-only platform. Without `ANTHROPIC_API_KEY` set, this runs in **demo mode** (auto-approves, logs a warning) so local dev doesn't require a key.
- **Rate limiting** — `/api/register`, `/api/login` (20 req/15min), `/api/mutation` (60 req/min), `/api/verify-id` (10 req/15min)

## Environment Variables

See `.env.example`. Notable ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (e.g. Supabase) — takes priority over Turso if both are set |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Hosted Turso DB — used if `DATABASE_URL` isn't set |
| `JWT_SECRET` | Signs auth tokens — **set a long random value in production**, otherwise an insecure default is used (with a startup warning) |
| `ANTHROPIC_API_KEY` | Powers `/api/verify-id`. Without it, verification auto-approves in demo mode |
| `SHOW_DEMO_ACCOUNTS` | `true`/`false`. Controls the tap-to-fill demo accounts panel on the login screen. Defaults to visible outside production, hidden when `NODE_ENV=production` |
| `NODE_ENV` | Set to `production` on your host |

---

## Accounts

The admin account always seeds on first boot. The rider/driver demo accounts below only seed when `SHOW_DEMO_ACCOUNTS` is not explicitly `false` (see [Environment Variables](#environment-variables)) — set it to `false` in production to skip creating them and hide the quick-fill panel on the login screen.

| Role          | Email                  | Password         |
|---------------|------------------------|------------------|
| Admin         | admin@pink.tt          | Admin@PinkTT2024 |
| Rider         | sarah@demo.pink.tt     | Rider@2024       |
| Driver ✓ (approved) | aminah@demo.pink.tt | Driver@2024      |
| Driver ⏳ (pending)  | priya@demo.pink.tt  | Driver@2024      |

New users register from the app — no pre-seeding needed beyond the above.

---

## Fare Structure (T&T rates)

| Component    | Rate          |
|-------------|---------------|
| Base fare   | TTD $25.00    |
| Per km      | TTD $3.50     |
| Per minute  | TTD $1.50     |
| Night (10pm–5am) | ×1.25 surcharge |
| Peak (6–9am, 4–7pm) | ×1.20 surcharge |

Example fares:
- POS → Maraval: ~TTD $53
- POS → Airport: ~TTD $172
- POS → San Fernando: ~TTD $337

---

## User Flow

### Rider
1. Sign up → upload govt ID → AI verifies female → account created
2. Book ride → see live map → animated car tracks driver
3. Driver accepts → live status updates via WebSocket
4. Ride completes → earn PinkPoints

### Driver
1. Sign up → upload govt ID + driver's licence → admin reviews
2. Admin approves (in Admin panel) → driver gets notified
3. Go online → see pending ride requests in real time
4. Accept → arriving → in progress → complete → earnings credited (80%)

### Admin
- Approve/reject driver applications
- View all users, rides, earnings, SOS events
- Real-time SOS alerts pushed via WebSocket

---

## SOS
Hitting SOS:
1. Logs event to database
2. Notifies all admin sessions via WebSocket instantly
3. Stores notification in admin's notification queue
4. In production: integrate with TTPS API + Twilio for SMS/calls

---

## File Structure

```
pinktt/
├── server.js          ← Express + SQLite + WebSocket backend
├── pinktt.db          ← SQLite database (auto-created)
├── package.json
├── patch.py           ← Re-generates public/index.html from source
└── public/
    └── index.html     ← Full Pink.TT app (served by Express)
```

---

## Regenerate Frontend

If you need to re-patch the HTML from the original source:
```bash
python3 patch.py
```

---

## Deploy to Production (Render — free, no card required)

Render ([render.com](https://render.com)) is the current pick: no card required, and this repo already has a `render.yaml` Blueprint so setup is mostly automatic. Tradeoff — the free tier **spins down after 15 minutes idle** and takes 30-60s to wake on the next request, which also means an in-flight WebSocket connection drops when the service sleeps (the client reconnects automatically, but expect a cold-start delay after idle periods). Fine for demoing/testing now; move to a paid instance (starts at $7/mo) before a real public launch if that's a problem.

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. At [render.com](https://render.com), create an account (no card needed for the free tier), then **New → Blueprint**, and connect this GitHub repo/branch. Render will detect `render.yaml` automatically and pre-fill the service config (Node runtime, `npm install`, `node server.js`, health check).
3. It'll prompt you for the two secret values marked `sync: false` in the Blueprint:
   - `DATABASE_URL` — your Supabase connection string (see below)
   - `ANTHROPIC_API_KEY` — optional, omit to run ID verification in demo mode
   `JWT_SECRET` is auto-generated by Render, and `NODE_ENV`/`SHOW_DEMO_ACCOUNTS` are already set in the Blueprint.
4. Apply. Render gives you a live `*.onrender.com` URL with HTTPS (needed for camera/GPS access on mobile).
5. Auto-deploy on push to this branch is on by default for Blueprint-created services.

### Setting up a persistent database

Local SQLite doesn't survive redeploys on most hosts — pick one of these.

**Supabase (Postgres)** — if you already have a Supabase project:
1. Dashboard → Project Settings → Database → Connection string → copy the URI (either "Session pooler" or direct connection both work with this app).
2. Fill in your database password (set at project creation, or reset it from that same page).
3. Set that full string as `DATABASE_URL` on your host. No separate setup script needed — the app creates its own tables on first boot.

**Turso (libSQL)** — alternative if you'd rather not use Postgres:
Run `node turso-setup.js` with a `TURSO_API_TOKEN` (get one free at [turso.tech](https://turso.tech), no card required) to provision a database and print the `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` to set on your host.

### Alternatives considered

- **Bonto** ([bonto.dev](https://bonto.dev)) — no card, stable signup, no GitHub-import (Git push-to-deploy or terminal `git clone` instead). Free tier capped at ~75 compute hours/month rather than idle spin-down. Already partially set up in an earlier pass — still usable if Render's cold starts are a problem.
- **Koyeb** ([koyeb.com](https://www.koyeb.com)) — free Hobby instance, scales to zero after 1hr idle. As of this writing Koyeb is being acquired by Mistral AI and account creation (email verification) was unreliable during testing.
- **Vercel/Netlify** — ruled out: both run Node as stateless serverless functions with no persistent process, which conflicts with this app's `app.listen()` + in-memory WebSocket design. Moving to either would require rewriting the server as serverless functions and replacing the WebSocket layer (e.g. with Supabase Realtime) — a substantially bigger job than a hosting swap.
- **Railway / Fly.io** — both now require a credit card to sign up, so they're excluded by the "no card" constraint.
