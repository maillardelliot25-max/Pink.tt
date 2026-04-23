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

- **SQLite database** (`pinktt.db`) — all users, rides, earnings persist between restarts
- **WebSocket** — riders and drivers communicate in real time (no refresh needed)
- **JWT auth** — secure tokens, 30-day sessions
- **Live map** — CARTO/OpenStreetMap tiles, Leaflet.js, animated GPS tracking

---

## Accounts

| Role   | Email              | Password    |
|--------|--------------------|-------------|
| Admin  | admin@pink.tt      | Admin@2024  |

New users register from the app — no pre-seeding needed.

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

## Deploy to Production

For a real server (e.g. DigitalOcean, Railway, Render):

```bash
# Set environment variable
export PORT=3000
export NODE_ENV=production

# Use PM2 for persistence
npm install -g pm2
pm2 start server.js --name pinktt
pm2 save
```

For HTTPS (required for camera/GPS access on mobile), put behind Nginx + Let's Encrypt.
