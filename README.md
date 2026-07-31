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

## Deploy to Production (Bonto — free, no card required)

Bonto ([bonto.dev](https://bonto.dev)) is the current pick: no card required and account creation is stable. The tradeoff — free tier is capped at **~75 compute hours/month**, which runs out mid-month for an always-on server unless the app sleeps between use. Fine for demoing/testing now; revisit for a paid always-on tier before a real public launch.

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. At [bonto.dev](https://bonto.dev), create an account and create a new app, connecting it to this GitHub repo/branch (Git push-to-deploy).
3. Bonto auto-detects Node.js via `package.json` — no Dockerfile needed. It runs `npm install` then the `start` script (`node server.js`), and auto-assigns `PORT` (the app already reads `process.env.PORT`, no changes needed).
4. In the app's environment variables settings, add:
   - `NODE_ENV=production`
   - `JWT_SECRET=<a long random string>`
   - `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (see below — without these, data won't persist across redeploys)
   - `ANTHROPIC_API_KEY` (for real ID verification — omit to run verification in demo mode)
   - `SHOW_DEMO_ACCOUNTS=false`
5. Deploy. Bonto gives you a live `*.bonto.run` URL with HTTPS (needed for camera/GPS access on mobile).
6. Push-to-deploy means future commits to this branch redeploy automatically — confirm that's on in the app settings.

### Setting up a persistent database

Local SQLite doesn't survive redeploys on most hosts — pick one of these.

**Supabase (Postgres)** — if you already have a Supabase project:
1. Dashboard → Project Settings → Database → Connection string → copy the URI (either "Session pooler" or direct connection both work with this app).
2. Fill in your database password (set at project creation, or reset it from that same page).
3. Set that full string as `DATABASE_URL` on your host. No separate setup script needed — the app creates its own tables on first boot.

**Turso (libSQL)** — alternative if you'd rather not use Postgres:
Run `node turso-setup.js` with a `TURSO_API_TOKEN` (get one free at [turso.tech](https://turso.tech), no card required) to provision a database and print the `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` to set on your host.

### Alternative: Koyeb

[Koyeb](https://www.koyeb.com) was the original pick — free Hobby instance, no card for most signups, scales to zero after 1hr idle (cold start), Frankfurt/Washington D.C. only. As of this writing Koyeb is in the process of being acquired by Mistral AI, and account creation (email verification) was unreliable during testing — worth retrying later if Bonto's hour cap becomes a problem, but not the current recommendation.
