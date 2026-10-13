# Super Likes Bot — website + admin panel

Node 20 / Express / PostgreSQL. Deploys on Render (not Vercel).

## What's here
- `server.js` backend (public API, admin API, atomic Like limit, encrypted API configs, `GET /health`)
- `public/` frontend (`index.html`, `admin.html`, logo, styles, JS). Tables are created automatically on start (idempotent migration in `migrate()`).
- `render.yaml` Blueprint (web service + Postgres), `.env.example`

## Deploy on Render
1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → pick the repo. It creates the web service and the Postgres database.
   Manual alternative: New Web Service, **Build Command** `npm install`, **Start Command** `npm start`, health check path `/health`, plus a Postgres database and the env vars below.
3. Set `ADMIN_PASSWORD` (a long random password) when prompted. `SESSION_SECRET` and `CONFIG_ENCRYPTION_KEY` are auto-generated; **do not change `CONFIG_ENCRYPTION_KEY` later** or saved API configs become unreadable.
4. Open `https://YOUR-SERVICE.onrender.com/health` → must show `OK` (HTTP 200).
5. Open `/admin`, log in, add regions, then configure each API.

The server binds `0.0.0.0` and reads `PORT`. Render's free Postgres expires after 30 days — use a paid plan for permanent storage.

## Configuring APIs (admin → Like/Info/Level/JWT)
No API formats are built in — enter what your provider documents:
- **Endpoint URL** with placeholders, e.g. `https://host/like?uid={uid}&region={region}`
- **Method** GET/POST, **body type** and **body template** (placeholders work here too)
- **Input fields**: the names shown to visitors (`region` becomes a dropdown from your region list; `uid` must be 4–20 digits)
- **Secret headers** (JSON, e.g. `{"x-api-key":"..."}`): write-only, stored AES-256-GCM encrypted, never returned to the browser. Put keys in headers, not in the URL.

"Test connection" only checks that the server is reachable; it does not send a Like or validate your request format.

## User limit
Admin → User Limits. Applies to **Like only**, enforced in Postgres with an atomic upsert (concurrent requests can't exceed it). A visitor is counted by IP **and** an anonymous cookie. Default: disabled until you enable it. Failed upstream calls refund the slot. Limitation: there is no user login, so users behind a shared IP share a counter and a determined person with many IPs can evade it.

## UptimeRobot
1. uptimerobot.com → **Add New Monitor** → type **HTTP(s)**.
2. URL: `https://YOUR-SERVICE.onrender.com/health` (your real Render domain), interval 5 min.
3. Alert contacts as you like. `/health` makes no database or API calls, so provider outages won't mark the site down. Monitoring detects downtime and keeps a free instance awake; it cannot guarantee 100% uptime.

## Local dev
`cp .env.example .env`, point `DATABASE_URL` at a local Postgres, set `PGSSL=disable`, `npm install`, `npm start` (export env vars first). `ALLOW_PRIVATE_UPSTREAM=1` permits localhost upstreams for testing only — never set in production.

## Notes
- Formatted view parses JSON in the browser, so integers above 2^53 may lose precision there; **Raw** and **Copy Full Response** always use the exact original text.
- Admin sessions: 2 h, HttpOnly, SameSite=Strict, Secure in production; login limited to 10 failures / 15 min; admin writes require an `X-Requested-With` header.
