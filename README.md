# BetTracker

A cloud-synced tracker for daily sports-betting results. Log your wins and
losses on your **computer** or your **phone**, and they stay in sync in real
time — a bet you add on the couch shows up on your laptop instantly.

Log **as many sessions per day as you like** — a bet in the morning, another in
the afternoon, and so on — and the app sums them into that day's net total. The
calendar, dashboard, and win/loss streaks all work off those daily totals.

One React UI runs two ways:

- **Phone** — an installable **PWA** (Add to Home Screen). Works on Wi-Fi or
  cellular; opens full-screen like a native app.
- **Computer** — the same app, either installed as a desktop PWA from your
  browser **or** as a native **Electron** window.

Both talk to your own **Supabase** project (hosted Postgres + Auth + Realtime),
so your data lives in one place, protected by an email/password login and
row-level security. It's your account, your data, your cloud project.

The app is **offline-tolerant**: each device keeps a local copy of your data,
so BetTracker opens instantly (even with no connection) and you can keep
logging bets offline — changes queue on the device and sync automatically the
moment you're back online. The header badge tells you where you stand:

| Badge | Meaning |
|---|---|
| 🟢 **Synced** | Everything is saved to the cloud and shared with your other devices |
| 🟡 **Syncing n…** | Queued changes are being pushed right now |
| ⚪ **Offline · n queued** | No connection — changes are safe on this device and will sync automatically |

Signing out removes that device's local copy (cache and queued changes);
anything already synced stays safe in your Supabase project.

## What you'll need

- **Node 20+**
- A free **Supabase** account (supabase.com) — this is the shared backend.

## One-time setup

### 1. Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com) and create a new project
   (the free tier is plenty).
2. Open **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and **Run**. That creates the
   `entries` table, locks it to each user with row-level security, and enables
   realtime sync.
   - *Already set up an earlier version?* Re-run `schema.sql` (it's safe to run
     again) or just run
     [`supabase/migrations/001_multiple_sessions_per_day.sql`](supabase/migrations/001_multiple_sessions_per_day.sql)
     to enable multiple sessions per day. Your existing entries are untouched.
3. Go to **Project Settings → API** and copy your **Project URL** and the
   **anon public** key.

### 2. Point the app at your project

```bash
cd bettracker
cp .env.example .env
# edit .env and paste in your URL + anon key
npm install
```

`.env` holds:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

(The anon key is safe to ship in a client app — it can only do what your
row-level security policies allow.)

## Run it in dev

```bash
npm run dev
```

Vite prints two URLs — a `localhost` one for your computer and a
**Network** one (e.g. `http://192.168.1.20:5173`). Open the Network URL on your
phone (same Wi-Fi) to use both at once and watch them sync.

Prefer the native desktop window instead of the browser?

```bash
npm run dev:desktop     # Electron, hot-reloaded
```

The first time you launch, create an account (Sign up), then sign in with the
same email/password on your phone — both devices now share the same data.

## Put it on your phone (deploy the PWA)

The web app is fully static (just HTML/JS/CSS talking to Supabase), so any
static host works. Build it, then deploy the `dist/` folder:

```bash
npm run build          # type-checks, bundles, and generates the PWA -> dist/
```

Easiest hosts (all have free tiers) — set the two `VITE_SUPABASE_*` values as
build-time environment variables in the host's dashboard:

- **Vercel** — `vercel` (or connect the repo); framework preset "Vite".
- **Netlify** — `netlify deploy --prod --dir dist`, or drag `dist/` onto the
  dashboard.
- **Cloudflare Pages / GitHub Pages** — serve `dist/` as static files.

Then on your phone open the deployed URL and **Add to Home Screen**
(iOS: Share → Add to Home Screen; Android: install prompt / ⋮ menu). It installs
with the BetTracker icon and launches full-screen.

To preview a production build on your LAN without deploying:

```bash
npm run preview        # serves dist/ on your network; open it on your phone
```

## Build a native desktop installer (optional)

```bash
npm run build:desktop       # installer for your current OS  -> release/
npm run build:desktop:dir   # unpacked app (no installer)     -> release/
```

electron-builder targets NSIS (Windows), DMG (macOS), and AppImage (Linux). A
given OS's installer must be built on that OS.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Web app dev server (open on phone + computer) |
| `npm run build` | Type-check + build the web/PWA bundle → `dist/` (deploy this) |
| `npm run preview` | Serve the built web app on your LAN |
| `npm run dev:desktop` | Native desktop app (Electron) in dev |
| `npm run build:desktop` | Package a native desktop installer → `release/` |
| `npm run typecheck` | Type-check the web + desktop code |

## How it's put together

```
bettracker/
├── vite.config.ts              # web / PWA build (the phone + browser app)
├── electron.vite.config.ts     # desktop build
├── electron-builder.yml        # desktop packaging targets
├── supabase/schema.sql         # run once in your Supabase project
├── build/make-icon.mjs         # regenerates all app/PWA icons
└── src/
    ├── main/index.ts           # Electron: a native window around the web UI
    ├── preload/index.ts        # minimal (data goes over the network, not IPC)
    ├── shared/types.ts         # shared entry types
    └── renderer/src/
        ├── App.tsx             # auth gate + dashboard + live sync wiring
        ├── auth/               # AuthProvider + Login screen
        ├── data/entries.ts     # Supabase CRUD + realtime subscription
        ├── lib/                # supabase client, validation, csv, dates, stats
        └── components/         # HeroStats, CalendarView, BalanceChart, …
```

**Sync.** Every device subscribes to Postgres change events for its own rows, so
an insert/edit/delete on one device refreshes the others within a second — no
refresh button.

**Offline.** The last-known rows are cached on the device for instant startup,
and mutations go through a persistent outbox: applied to the UI immediately,
replayed against Supabase in order on reconnect (entry ids are client-generated
UUIDs, so a retried insert can never create a duplicate). Editing a
not-yet-synced entry rewrites its queued insert; deleting one cancels it before
the server ever hears about it.

**Security.** Auth is Supabase email/password. Row-level security means every
query is automatically scoped to the signed-in user; one account can never read
or write another's rows. The anon key in the client grants nothing beyond those
policies.

## Data model

One row per day, per user (`supabase/schema.sql`):

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | the owner; enforced by row-level security |
| `date` | date | `YYYY-MM-DD` — many rows can share a date |
| `amount` | numeric | one session's result; `> 0` win, `< 0` loss, `0` push |
| `note` | text | optional (e.g. "morning parlay") |

Each row is a single session/bet. A day can hold any number of them, and the
app sums a day's rows into its net total everywhere it's shown. **Export CSV**
writes one row per session (sorted by date), so summing a date in a spreadsheet
reproduces the day total.
