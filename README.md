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
- **ID verification** — riders and drivers upload a photo after registering; `POST /api/verify-id` calls a vision AI server-side (key never reaches the browser) to confirm the account is eligible for this women-only platform. Tries `ANTHROPIC_API_KEY` first, falls back to `GEMINI_API_KEY` if that's unset or the Anthropic call fails (e.g. no credit balance). Without either set, this runs in **demo mode** (auto-approves, logs a warning) so local dev doesn't require a key.
- **Rate limiting** — `/api/register`, `/api/login` (20 req/15min), `/api/mutation` (60 req/min), `/api/verify-id` (10 req/15min); plus a per-account login lockout (5 failed attempts = 15 min lock) independent of the per-IP limiter
- **SOS safety alert** — logs the event, notifies the admin panel, and — if Twilio env vars + a safety-team phone number (set in-app under Admin → Settings) are configured — places an automated call and SMS to that number. **This never contacts real police directly** — a human on the safety team decides whether to call the Trinidad & Tobago Police Service. No formal TTPS dispatch integration exists; see `/terms.html` and `/privacy.html` for the exact wording shown to users.
- **Admin panel → Settings tab** — editable safety/support contact numbers, staff/admin account management (create, promote, demote, cannot remove the last admin), and an audit log of sensitive admin actions
- **New-signup notifications** — every new rider/driver registration notifies all active admins in the dashboard (🔔 bell icon, top right of the admin panel) and, if `GMAIL_USER`/`GMAIL_APP_PASSWORD` are set, by email
- **Real pickup location** — the booking screen asks for the browser's GPS location and uses those exact coordinates for pickup, instead of a fixed placeholder. Falls back to address-based lookup only if location access is denied
- **Destination geocoding** — typed destinations are resolved via a small hardcoded list of T&T neighborhoods first, then real geocoding (OpenStreetMap Nominatim, free, no API key) for anything else, so fares reflect actual distance instead of a random nearby guess. Rate-limited (60 req/min) since it's public/unauthenticated by necessity
- **Driver identity verification** — beyond the AI selfie check above, a driver application requires a national ID card photo, a *live* portrait captured via the device camera (not a file upload — proves the applicant is physically present), and acceptance of the Code of Conduct (linked from the driver agreement). Enforced server-side independent of the UI; the admin driver-review panel shows all of it plus the acceptance timestamp
- **Driver tiers** — Standard/Preferred/VIP, gated by rating + completed trip count, each with its own commission rate; only Preferred/VIP tiers are eligible to be matched to recurring commutes
- **Recurring commutes** — a rider can set up a repeating pickup/dropoff pattern (e.g. weekday work commute); the system matches a primary + backup eligible driver, generates each day's ride "leg" ahead of time, and drivers see their matched commutes in a dedicated Recurring tab. A small peek drawer on the driver's other tabs previews nearby available one-off rides without leaving whatever tab they're on
- **Forgot Password** — self-service reset via `/reset-password.html`: request a link by email (sent via the same Gmail SMTP as admin notifications), click through, set a new password. Never reveals whether an email is registered (no account enumeration). Falls back to showing the link directly on the page if no email is configured, so the flow is testable without real delivery
- **Phone push notifications** — real OS-level push (works even with the app closed/backgrounded), for riders, drivers, *and* admins alike: a driver gets pushed on a new nearby ride request, a rider on driver acceptance, an admin on new signups/complaints/SOS. Uses the free, standard Web Push/VAPID protocol — no third-party push service account or per-message cost. Silently disabled until `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are set (see below)
- **Admin-managed app branding** — Admin → Settings → App Branding: upload a custom app icon and background video; every background upload joins a history gallery so the admin can switch back to an earlier one without re-uploading, or delete ones no longer wanted. The active background is consistent everywhere it's shown — main app, boot/loading screen, and the offline page all pick it up
- **Never-stuck backdrop video** — the looping background video fades to a plain tinted background the instant it stalls from a slow/unstable connection (rather than visibly freezing on the last frame), and fades back in the moment playback resumes; on a connection already known to be too slow (Save-Data on, or 2G), it isn't attempted at all
- **Security hardening** — basic response headers (clickjacking/MIME-sniffing protection), server-side email format validation on signup, Postgres Row Level Security enabled on every table (defense in depth — this app talks to Postgres directly, not through Supabase's client API, so RLS isn't the primary access control, but it closes off the anon/PostgREST path entirely)
- **Free-tier uptime** — `GET /healthz` (cheap, no DB touch) exists so a free external cron pinger (`.github/workflows/keepalive.yml`, or a service like cron-job.org) can hit it every 5-10 minutes and keep a free-tier host from spinning the app down after 15 minutes idle

## Environment Variables

See `.env.example`. Notable ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (e.g. Supabase) — takes priority over Turso if both are set |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Hosted Turso DB — used if `DATABASE_URL` isn't set |
| `JWT_SECRET` | Signs auth tokens — **set a long random value in production**, otherwise an insecure default is used (with a startup warning) |
| `ANTHROPIC_API_KEY` | Primary provider for `/api/verify-id`. Requires billing set up on console.anthropic.com — no free tier for API usage |
| `GEMINI_API_KEY` | Fallback provider for `/api/verify-id`, used if Anthropic is unset or fails. Genuinely free, no credit card required — get one at aistudio.google.com |
| `GEMINI_MODEL` | Optional, defaults to `gemini-3.6-flash` |
| `SHOW_DEMO_ACCOUNTS` | `true`/`false`. Controls the tap-to-fill demo accounts panel on the login screen. Defaults to visible outside production, hidden when `NODE_ENV=production` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` | Powers the automated SOS call/SMS. Omit any of the three and SOS falls back to logging + admin-panel notification only |
| `PUBLIC_URL` | Your deployed URL (e.g. `https://pinktt.onrender.com`) — Twilio calls this back to fetch what to say during the SOS call |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Powers admin email notifications on new signups, and Forgot Password reset emails. Free Gmail App Password (needs 2-Step Verification on) — no paid email service needed |
| `ADMIN_NOTIFICATION_EMAIL` | Who receives signup notification emails. Defaults to `Maillardelliot25@gmail.com` |
| `PINK_INBOX_EMAIL` | Second copy address for admin emails (the business inbox, separate from the personal owner address) |
| `TEXTBELT_KEY` | Optional paid key for admin SMS (SOS alerts). Without it, uses TextBelt's free shared key — capped at 1 SMS/day worldwide, best-effort only |
| `ADMIN_NOTIFICATION_PHONE` | Where admin SMS alerts go |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Enables real phone push notifications (rider/driver/admin). Free, standard Web Push — generate a pair once with `node -e "console.log(require('web-push').generateVAPIDKeys())"` and set both. Push is silently disabled without them |
| `CANONICAL_HOST` | Optional (e.g. `pinktt.com`) — every request to any other host 301-redirects here once a custom domain is live. No-op until set |
| `NODE_ENV` | Set to `production` on your host |

**Payment processing is not yet integrated.** Stripe and PayPal don't operate in Trinidad & Tobago; the real options are WiPay, Powertranz, or Republic EPay. This needs a decision on which processor before it can be built.

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
3. Driver accepts → live status updates via WebSocket + a phone push notification
4. Ride completes → earn PinkPoints
5. Optionally set up a recurring commute → matched to a primary + backup driver

### Driver
1. Sign up → upload govt ID + driver's licence + national ID card + a live portrait camera capture → accept the Code of Conduct → admin reviews
2. Admin approves (in Admin panel) → driver gets notified (in-app + phone push)
3. Go online → new nearby ride requests arrive in real time, including a phone push even if the app is backgrounded
4. Accept → arriving → in progress → complete → earnings credited (80%)
5. Matched recurring commutes show in their own Recurring tab; a peek drawer on other tabs previews nearby one-off rides without switching tabs

### Admin
- Approve/reject driver applications
- View all users, rides, earnings, SOS events
- Real-time SOS alerts pushed via WebSocket + phone push notification
- Manage app branding (icon, background video, wallpaper history), driver tiers, and settings

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
├── server.js               ← Express + SQLite/Postgres + WebSocket backend
├── pinktt.db                ← SQLite database (auto-created, local dev only)
├── package.json
├── patch.py                 ← Re-generates public/index.html from source
├── scripts/regression.js    ← Playwright end-to-end regression suite (npm test)
├── .github/workflows/
│   ├── keepalive.yml        ← Free cron pinging /healthz to prevent free-tier idle spin-down
│   └── regression.yml       ← CI regression run
└── public/
    ├── index.html            ← Full Pink.TT app (served by Express)
    ├── offline.html           ← Shown when the service worker can't reach the network
    ├── reset-password.html   ← Forgot Password flow (request link / set new password)
    ├── driver-agreement.html ← Driver Agreement + Code of Conduct text
    ├── terms.html / privacy.html
    └── sw.js                 ← Service worker: offline fallback, asset caching, push notifications
```

---

## Regenerate Frontend

If you need to re-patch the HTML from the original source:
```bash
python3 patch.py
```

---

## Deploy to Production

**Currently live on Render** at [pinktt.onrender.com](https://pinktt.onrender.com) (free tier, no card required). Render's free plan spins a service down after 15 minutes idle and takes 30-60s to cold-start on the next request — for a safety app (SOS, live tracking) that's a real reliability risk, not just a cosmetic delay. That's solved without moving to a paid plan: `GET /healthz` is a cheap no-DB endpoint that `.github/workflows/keepalive.yml` (a free GitHub Actions cron, already in this repo) or an external free pinger like [cron-job.org](https://cron-job.org) hits every 5-10 minutes, which never lets the service go idle long enough to sleep — free plan hours (750/month) comfortably cover running 24/7 (744 hours in a 31-day month) as long as it's actually pinged that often.

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. At [render.com](https://render.com), New → Web Service, connect this GitHub repo/branch. This repo has a ready `render.yaml` Blueprint if you'd rather use New → Blueprint instead — it auto-configures the same thing.
3. Render auto-detects Node.js via `package.json`. Build command `npm install`, start command `node server.js` (already set if using the Blueprint) — Render auto-assigns `PORT`, which the app already reads via `process.env.PORT`.
4. In the service's Environment settings, add:
   - `NODE_ENV=production`
   - `JWT_SECRET=<a long random string>`
   - `DATABASE_URL` — your Supabase (or other Postgres) connection string (see below) — **required**, since Render's free-plan disk doesn't persist across redeploys, so local SQLite would lose all data on every deploy
   - `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` (optional — omit to run ID verification in demo mode)
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (optional — omit to disable phone push notifications)
   - `SHOW_DEMO_ACCOUNTS=false`
5. Deploy. Render gives you a live `*.onrender.com` URL with HTTPS (needed for camera/GPS access on mobile) — auto-deploy on push is on by default.
6. Set up the free keep-alive: either confirm `.github/workflows/keepalive.yml` is running under your GitHub repo's Actions tab (it targets `https://pinktt.onrender.com/healthz` — update the URL there if you're deploying under a different domain), or create a free monitor at [cron-job.org](https://cron-job.org) hitting your `/healthz` URL every 5-10 minutes.

### Alternative: Bonto (free, no card required)

Bonto ([bonto.dev](https://bonto.dev)) has a real always-on free tier (no idle spin-down at all) rather than Render's ping-to-stay-awake workaround, traded for a ~75 compute-hour/month cap — the app just stops working once you cross that, a more predictable failure mode than a cold start.

1. At [bonto.dev](https://bonto.dev), create an account and a new app connected to this GitHub repo/branch (Git push-to-deploy) — or, if already set up via the Terminal `git clone` method, run `git fetch origin && git checkout claude/pinktt-server-app-structure-a338zo && git pull && npm install` in its Terminal tab (no auto-deploy hook that way, so redeploys need a manual pull).
2. Bonto auto-detects Node.js the same way as Render — no Dockerfile needed.
3. Set the same environment variables as the Render steps above.
4. Deploy/redeploy. Bonto gives you a live `*.bonto.run` URL with HTTPS.

### Setting up a persistent database

Local SQLite doesn't survive redeploys on most hosts — pick one of these.

**Supabase (Postgres)** — if you already have a Supabase project:
1. Dashboard → Project Settings → Database → Connection string → copy the URI (either "Session pooler" or direct connection both work with this app).
2. Fill in your database password (set at project creation, or reset it from that same page).
3. Set that full string as `DATABASE_URL` on your host. No separate setup script needed — the app creates its own tables on first boot.

**Turso (libSQL)** — alternative if you'd rather not use Postgres:
Run `node turso-setup.js` with a `TURSO_API_TOKEN` (get one free at [turso.tech](https://turso.tech), no card required) to provision a database and print the `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` to set on your host.

### Other alternatives considered

- **Koyeb** ([koyeb.com](https://www.koyeb.com)) — free Hobby instance, scales to zero after 1hr idle. As of this writing Koyeb is being acquired by Mistral AI and account creation (email verification) was unreliable during testing.
- **Vercel/Netlify** — ruled out: both run Node as stateless serverless functions with no persistent process, which conflicts with this app's `app.listen()` + in-memory WebSocket design. Moving to either would require rewriting the server as serverless functions and replacing the WebSocket layer (e.g. with Supabase Realtime) — a substantially bigger job than a hosting swap.
- **Railway / Fly.io** — both now require a credit card to sign up, so they're excluded by the "no card" constraint.
