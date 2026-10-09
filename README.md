# BetTracker

A cloud-synced tracker for daily sports-betting results. Log your wins and
losses on your **computer** or your **phone**, and they stay in sync in real
time — a bet you add on the couch shows up on your laptop instantly.

Log **as many sessions per day as you like** — a bet in the morning, another in
the afternoon, and so on — and the app sums them into that day's net total. The
calendar, dashboard, and win/loss streaks all work off those daily totals.

Record the **stake** behind each bet and you also get **ROI** (yield) — profit
divided by the amount risked — which is the number that actually says whether
you're beating the price. Tag bets by **sport**, **bookmaker** and **bet type**
to see which of them earn their keep. All four fields are optional: bets logged
without a stake still count toward P/L and win rate, and the app tells you how
many are missing one instead of quietly guessing.

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
| 🟠 **Update needed · n queued** | Your database is missing a migration — changes are safe on this device and sync as soon as you run it (see [setup](#1-create-the-supabase-project)) |

Signing out removes that device's local copy (cache and queued changes);
anything already synced stays safe in your Supabase project.

Small things that add up: a **light theme** (☀️ in the header — it follows your
OS until you pick one, then stays put), **search and filters** over your history
with paging, a balance chart you can flip between **all time and the selected
month**, and keyboard shortcuts — `←`/`→` to change month, `T` to log today,
`Esc` to close a dialog.

## What you'll need

- **Node 20+**
- A free **Supabase** account (supabase.com) — this is the shared backend.

## One-time setup

### 1. Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com) and create a new project
   (the free tier is plenty).
2. Open **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and **Run**. That creates the
   `entries` and `user_settings` tables, locks them to each user with
   row-level security, and enables realtime sync.
   - *Already set up an earlier version?* Re-run `schema.sql` (it's safe to run
     again) or apply just the migrations you're missing, in order:
     [`001_multiple_sessions_per_day.sql`](supabase/migrations/001_multiple_sessions_per_day.sql)
     (several bets per day),
     [`002_stake_and_tags.sql`](supabase/migrations/002_stake_and_tags.sql)
     (stake, sport, book, bet type),
     [`003_odds_and_status.sql`](supabase/migrations/003_odds_and_status.sql)
     (odds, pending bets) and
     [`004_user_settings_and_closing_odds.sql`](supabase/migrations/004_user_settings_and_closing_odds.sql)
     (settings, closing odds). Your existing bets are untouched — old ones
     simply have no stake or odds recorded, and 003 gives each the status its
     result implies.
   - *Upgrading an install people are using?* Run the migrations **before**
     you deploy the new version. Devices still on the old version keep
     working in between: their writes carry no status, and 003 gives them the
     one their amount implies. Then deploy, and update every device. If you
     deploy first, nothing is lost: the new version keeps each change queued
     on the device, shows **Update needed · n queued**, and sends them as soon
     as the migrations have run. Don't sign out on that device until then —
     signing out clears its queue.
3. Go to **Project Settings → API** and copy your **Project URL** and the
   **anon public** key.

### 2. Point the app at your project

```bash
git clone https://github.com/Vict0rL1/Bettracker.git
cd Bettracker
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
| `npm test` | Run the unit tests (stats, offline outbox, CSV, validation) |
| `npm run test:watch` | Same, in watch mode |
| `npm run preview` | Serve the built web app on your LAN |
| `npm run dev:desktop` | Native desktop app (Electron) in dev |
| `npm run build:desktop` | Package a native desktop installer → `release/` |
| `npm run typecheck` | Type-check the web + desktop code |
| `npm run test:e2e` | Browser tests with Playwright against a built copy (no backend needed) |

## Settings

The sliders button in the header opens per-user settings, stored in the
`user_settings` table (migration 004) and cached on the device so they work
offline and follow you to other devices:

- **Odds format** — American (default), decimal or fractional. Odds are always
  *stored* as decimal; this only changes how they are shown and typed. The odds
  box is lenient either way: `+150`, `1.91` and `3/2` are all understood.
- **Default stake** — prefilled in quick add (the floating `+` button, or `T`).
- **Monthly loss limit** — a banner appears when the current month's net loss
  reaches 80% of it (amber) and again once it passes it (red). It never blocks
  logging a bet; dismissing it hides it until the next line is crossed or the
  month turns.

## Breakdown

The breakdown card groups P/L, record, ROI and CLV by sport, book, bet type,
**odds band**, **weekday** or **month**. The bands are defined once, in
`src/renderer/src/lib/bands.ts`: heavy favorite (≤ 1.50, i.e. −200 and
shorter), favorite (to 1.90 / −111), even (to 2.10 / +110), underdog (to 3.50 /
+250) and longshot (longer). Bets that cannot be placed — no tag, or no odds —
are left out rather than lumped into a "none" bucket, and every row shows its
sample size.

## Date ranges

The row above the stat cards picks the range the stats, the balance chart and
the breakdown are computed over: all time, this week (Sunday to Saturday),
this month, the last 30 days, this year, or custom dates (inclusive at both
ends). The calendar, its month card, the history and the pending count always
show everything. The choice is remembered on the device.

## Editing the history in bulk, and Undo

Tick rows in the history (the header box ticks the page) and a bar appears
to **retag** them (empty boxes keep a bet's current tag), **settle** the
pending ones as won / lost / push / void (a win with no odds is skipped, since
its profit cannot be worked out) or **delete** them (click twice). Every delete
— single or bulk — and every bulk edit shows an **Undo** in its toast. Undo
writes the previous values back through the same outbox, so it works offline
and syncs like any other change; a restored bet keeps its id but gets a new
"logged at" time.

## Pending bets

**Pending** in the header shows how many bets are still waiting for a result
and opens a panel listing them, oldest first. Each settles in one tap
(WON / LOST / PUSH / VOID — the result is worked out from the stake and odds),
and a bet whose date has passed is flagged so it is not forgotten. Settling
works offline like any other edit.

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
        ├── data/offline.ts     # device cache + outbox (with unit tests)
        ├── lib/                # supabase client, validation, csv, dates, stats, theme
        └── components/         # HeroStats, CalendarView, BalanceChart, Breakdown, …
```

**Stats.** One grouping pass per render feeds the calendar, the stat cards and
the chart. ROI is computed only over bets that recorded a stake — an unknown
stake is excluded rather than treated as `0` (which would send ROI to infinity)
or as the profit (which would invent data). Wherever a figure covers a subset,
the UI says so: the ROI card reads "4 of 5 bets with a stake", and a breakdown
row whose profit and ROI cover different sets is marked `(1/2)`.

**Sync.** Every device subscribes to Postgres change events for its own rows, so
an insert/edit/delete on one device refreshes the others within a second — no
refresh button.

**Conflicts.** Two devices can edit the same bet while offline. The rule is
*last write wins, by when the edit was made*: every edit carries the moment the
user made it, that moment is written as the row's `updated_at`, and the server
applies an edit only if the row's `updated_at` is not newer. If another
device's later edit already landed, the older one is refused, dropped from the
queue, and the app shows "A newer edit from another device was kept" before
refreshing to the winning version. A retry of the same edit after a lost
response still applies (its own timestamp satisfies the check), and a delete
beats an edit in either order. Device clocks are trusted, which is the price
of needing no server-side logic — no extra column, no trigger.

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

One row per bet, per user (`supabase/schema.sql`, table `entries`):

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | the owner; enforced by row-level security |
| `date` | date | `YYYY-MM-DD` — many rows can share a date |
| `amount` | numeric | the bet's **net result**; `> 0` won, `< 0` lost, `0` push/void, `null` while pending |
| `stake` | numeric | amount risked; `null` = not recorded (excluded from ROI), `0` = free bet (bonus profit) |
| `odds` | numeric | decimal price, `> 1`; optional |
| `closing_odds` | numeric | the price when the market closed, `> 1`; optional. CLV = odds / closing_odds − 1 (migration 004) |
| `status` | text | `pending` · `won` · `lost` · `push` · `void`; a write without one (from a version older than migration 003) gets the one its amount implies |
| `note` | text | optional (e.g. "morning parlay") |
| `sport` | text | optional tag (e.g. "NBA") |
| `book` | text | optional tag (e.g. "DraftKings") |
| `bet_type` | text | optional tag (e.g. "Parlay") |

Each row is one bet. A day can hold any number of them, and the app sums a
day's settled rows into its net total; a pending bet stays out of P/L, ROI
and streaks until you settle it (one tap from the day dialog or the history).

ROI counts won and lost bets with a real stake. Pushes and voids return the
stake, so they're out of the denominator; free bets (stake 0) risk nothing,
so their profit is reported beside ROI as *bonus* rather than inside it.
Next to ROI and the strike rate you'll see the sample size, a *small sample*
flag under 50 bets, and the average implied probability of your odds — the
strike rate you need to beat at those prices.

`amount` is the **net** result, so a $100 bet that wins at even money is
`amount = 100, stake = 100` (not 200), and losing it is `amount = -100`. When
you pick LOSS in the form the amount auto-fills from the stake, since a losing
bet almost always costs exactly what was risked.

## Import and export

**Export CSV** writes one row per bet, sorted by date, with the columns
`date, status, stake, odds, amount, sport, book, bet_type, note` — summing a
spreadsheet reproduces that day's total.

**Import** reads that same shape back, so an export is a working backup. Only a
header row is required; column order doesn't matter, extra columns are ignored,
and common aliases from other trackers are accepted (`day`, `p/l`, `profit`,
`risk`, `wagered`, `league`, `sportsbook`, `market`, `notes`, `result`,
`price`, and `session` from the days when a row was called that, …). Files
from before odds and statuses existed import unchanged — the status is what
the amount implies. The import reports how many rows came without a stake,
since those stay out of ROI. Values may
carry currency symbols, thousands separators, or parenthesised negatives
(`"$1,234.50"`, `(45.00)`). Lines that can't be read are skipped and reported
rather than half-guessed, and the import queues through the same offline outbox
as everything else — so it works with no connection and can't create duplicate
rows if it's retried.
