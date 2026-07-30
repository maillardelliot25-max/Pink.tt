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

- **Database** — Turso (libSQL) in production when `TURSO_DATABASE_URL` is set, falling back automatically to local SQLite (`pinktt.db`) for dev
- **WebSocket** — riders and drivers communicate in real time (no refresh needed)
- **JWT auth** — secure tokens, 30-day sessions (set `JWT_SECRET` in production)
- **Live map** — CARTO/OpenStreetMap tiles, Leaflet.js, animated GPS tracking
- **ID verification** — riders and drivers upload a photo after registering; `POST /api/verify-id` calls the Anthropic API server-side (key never reaches the browser) to confirm the account is eligible for this women-only platform. Without `ANTHROPIC_API_KEY` set, this runs in **demo mode** (auto-approves, logs a warning) so local dev doesn't require a key.
- **Rate limiting** — `/api/register`, `/api/login` (20 req/15min), `/api/mutation` (60 req/min), `/api/verify-id` (10 req/15min)

## Environment Variables

See `.env.example`. Notable ones:

| Variable | Purpose |
|---|---|
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Hosted Turso DB — omit both for local SQLite |
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

## Deploy to Production (Koyeb — free, no card required)

Koyeb's free Hobby instance doesn't require a credit card for most signups (it may ask for card-based human verification in some cases — if that happens, stop and confirm with the project owner before proceeding on a paid tier). Tradeoffs to know going in: the free instance **scales to zero after 1 hour idle** (cold start on the next request) and only runs in Frankfurt or Washington D.C.

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. At [koyeb.com](https://www.koyeb.com), create an account and click **Create App → GitHub** and select this repo/branch.
3. Build settings: Koyeb auto-detects Node.js via `package.json`/`Procfile` — no Dockerfile needed. Run command: `node server.js`.
4. Set the port to `3000` (or leave `PORT` unset — the app reads `process.env.PORT`).
5. Add environment variables in the Koyeb dashboard:
   - `NODE_ENV=production`
   - `JWT_SECRET=<a long random string>`
   - `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` (see below — without these, data won't persist across redeploys)
   - `ANTHROPIC_API_KEY` (for real ID verification — omit to run verification in demo mode)
   - `SHOW_DEMO_ACCOUNTS=false`
6. Deploy. Koyeb gives you a `*.koyeb.app` URL with HTTPS automatically (needed for camera/GPS access on mobile).
7. Enable auto-deploy on push so future commits to this branch redeploy automatically.

### Setting up Turso (persistent database)

Local SQLite doesn't survive redeploys on most hosts. Run `node turso-setup.js` with a `TURSO_API_TOKEN` (get one free at [turso.tech](https://turso.tech), no card required) to provision a database and print the `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` to set on your host.

### Alternative: Bonto

[Bonto](https://bonto.dev) also requires no card, but its free tier is capped at ~75 compute hours/month — it will run out mid-month for an always-on server unless the app sleeps between use. Workable for testing/demoing, not for a live always-on backend.
