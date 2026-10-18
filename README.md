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

Track your **bankroll** too: a starting figure plus every **deposit and
withdrawal**, so the current bankroll adds up to the cent, a chart view of it
over time, and a quiet warning when a stake is more than **5%** of it. And if
you think in **units**, set what one is worth and every amount reads in units.

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
| 🟠 **Retrying · n queued** | Supabase failed for now (a 5xx, a rate limit) — changes are safe on this device and are tried again after a growing wait (1 s, 2 s, 4 s … up to 2 minutes) |
| 🔴 **Not syncing · n queued** | Supabase refused this app's key or session — changes are safe on this device and sync once that is sorted out |
| 🔴 **Signed out · n queued** | Your session ended (signing out on another device ends it everywhere) — changes are safe on this device; **Sign in again** sends them |
| 🟠 **Update needed · n queued** | Your database is missing a migration — changes are safe on this device and sync as soon as you run it (see [setup](#1-create-the-supabase-project)) |

The count covers every queued change: bets, deposits and withdrawals. A
settings change waiting to sync shows on the badge too (without a count).
A request the server never answers is given up after 30 seconds, as if the
connection had dropped, and tried again later.
Signing out removes that device's local copy (cache, queued changes and
refused ones); anything already synced stays safe in your Supabase project.
While changes are still queued or refused, **Sign out** asks you to click
again.

Three more things stay on screen until you deal with them, because they are
about changes that haven't reached the server:

- **Signed out** — your session ended while changes waited here. **Sign in
  again** opens the sign-in form over this device's data, queue included;
  nothing is cleared.
- **Not saved on this device** — the browser's storage refused the queue
  (full, or turned off). Cached server data is dropped first to make room;
  when even that isn't enough the change stays in that window only, keeps
  syncing while it is open, and the toast says so instead of "Added".
  **Try again** stores it once there is room, on top of whatever other
  windows stored meanwhile (what this window sent or deleted stays out).
- **Refused** — Supabase refused a change for good (a check it fails, say).
  It leaves the queue so it can't block the rest, and waits here with the
  server's reason: **Send again** (never over a newer edit of the same bet)
  or **Discard**.

Several windows of the app (two tabs, or a tab and the installed app) share
one queue: each change is made to the stored queue under a lock that spans
windows (the Web Locks API), only one window sends it at a time, and a change
made in one window shows in the others. The lock alone isn't enough, because
each window reads its own copy of the browser's storage, which another
window's write reaches a moment later; so every change also counts up a
version kept in IndexedDB, and the next window waits until its copy has it
before reading. Over plain http on your local network (`npm run dev` on the
phone) the browser has no such lock, and windows there don't coordinate.

Small things that add up: a **light theme** (☀️ in the header — it follows your
OS until you pick one, then stays put), **search and filters** over your history
with paging, a balance chart you can flip between **all time and the selected
month**, the interface in **English or Spanish** (the header button switches;
it follows your browser until you pick one, then stays put; validation and
sync error messages stay in English), and
keyboard shortcuts — `←`/`→` to change month, `T` to log today, `Esc` to
close a dialog.

## What you'll need

- **Node 22**, 22.12 or later (Electron 43 and supabase-js need it; it is what
  CI runs)
- A free **Supabase** account (supabase.com) — this is the shared backend.

## One-time setup

### 1. Create the Supabase project

1. Sign in at [supabase.com](https://supabase.com) and create a new project
   (the free tier is plenty).
2. Open **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and **Run**. That creates the
   `entries`, `user_settings` and `bankroll_moves` tables, locks them to each
   user with row-level security, and enables realtime sync.
   - *Already set up an earlier version?* Re-run `schema.sql` (it's safe to run
     again) or apply just the migrations you're missing, in order:
     [`001_multiple_sessions_per_day.sql`](supabase/migrations/001_multiple_sessions_per_day.sql)
     (several bets per day),
     [`002_stake_and_tags.sql`](supabase/migrations/002_stake_and_tags.sql)
     (stake, sport, book, bet type),
     [`003_odds_and_status.sql`](supabase/migrations/003_odds_and_status.sql)
     (odds, pending bets),
     [`004_user_settings_and_closing_odds.sql`](supabase/migrations/004_user_settings_and_closing_odds.sql)
     (settings, closing odds) and
     [`005_bankroll_moves.sql`](supabase/migrations/005_bankroll_moves.sql)
     (deposits and withdrawals; it doesn't depend on 004, so the two can run
     in either order). Your existing bets are untouched — old ones simply have
     no stake or odds recorded, and 003 gives each the status its result
     implies.
   - *Upgrading an install people are using?* Run the migrations **before**
     you deploy the new version. Devices still on the old version keep
     working in between: their writes carry no status, and 003 gives them the
     one their amount implies (except that a pending bet, which they show as
     $0, stays pending if they send that $0 back). Then deploy, and update
     every device; changes a device still has queued from the old version
     are sent after the update the way that version would have sent them. If you deploy first, nothing is lost: the new version keeps each
     change (settings, deposits and withdrawals included) queued on the
     device, shows **Update needed**, and sends them as soon as the
     migrations have run. Without 005, the bankroll counts only the starting
     figure and the settled bets until then, plus whatever deposits and
     withdrawals that device has queued. Don't sign out on that device until
     then — signing out clears its queue.
3. Copy your **Project URL** (it looks like `https://<ref>.supabase.co`) and
   your **publishable key** (`sb_publishable_…`, under **Project Settings →
   API Keys**). The older **anon** key (`eyJ…`) works too, until Supabase
   retires the legacy keys at the end of 2026. Never the **secret** key
   (`sb_secret_…`) or **service_role**: they skip row-level security, and the
   build refuses them.
4. Open **Authentication → URL Configuration**. Set **Site URL** to the
   address where you'll use the app (your Netlify address, say), and list the
   others you sign up from under **Redirect URLs** (`http://localhost:5173`
   for dev). The confirmation email links back to the address you signed up
   from when it's listed there, and otherwise to the Site URL — on a new
   project, `http://localhost:3000`, which shows an error page (the account is
   confirmed all the same: go back to the app and sign in). For an app only you
   use, you can turn **Confirm email** off instead, in the **Email** provider's
   settings (**Authentication → Sign In / Providers**). A link that has expired,
   or was already opened, brings you to the sign-in screen, which says so.

### 2. Point the app at your project

```bash
git clone https://github.com/Vict0rL1/Bettracker.git
cd Bettracker
cp .env.example .env
# edit .env and paste in your URL + publishable key
npm install
```

`.env` holds:

```
VITE_SUPABASE_URL=https://YOUR-PROJECT-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-key
```

(The variable keeps its old name; a publishable key goes in it. It is safe to
ship in a client app — it can only do what your row-level security policies
allow.)

`npm run dev` and `npm run build` check these two values first. The build
stops when they can't work, or would put a secret in the app, and says what to
put instead; dev says it in the terminal and on the app's setup screen.
It catches a URL without `https://`, the dashboard's address, the database
connection string (it holds the database password), an API path after the
address, the examples left in, a secret or `service_role` key, a key cut short
or with quotes or spaces in it, something that isn't a key at all (the JWT
secret, say), and an anon key from another project than the URL's, which is
what Supabase calls **Invalid API key**. A publishable key carries no project
to compare, so that last one shows at sign-in instead, where BetTracker says
which key to use. A build with the old anon key also says when to switch it.

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

## Try it without Supabase (demo)

```bash
npm install
npm run demo
```

It opens on `http://localhost:5172` already signed in, with nothing in it,
and needs no Supabase project and no `.env`: a fake backend keeps everything
in that browser's storage (the same fake the e2e suite runs against, in
`src/renderer/src/demo/`). The app behaves as it does against Supabase,
offline included — turn the Wi-Fi off and changes wait on the device, then
sync when it's back. A bar across the top says it's the demo, and **Start
over** (two clicks) empties it. Signing out leads to the sign-in screen; any
email and a password of 6 or more characters sign you back in. The
**Network** URL works on your phone too; each browser has its own demo. None
of the demo's code goes into `npm run build` (only its three strings and the
banner's CSS do).

## Put it on your phone (deploy the PWA)

The web app is fully static (just HTML/JS/CSS talking to Supabase), so any
static host works. Build it, then deploy the `dist/` folder:

```bash
npm run build          # type-checks, bundles, and generates the PWA -> dist/
```

The two `VITE_SUPABASE_*` values are written into the bundle when it is built:
a `dist/` you build yourself takes them from your `.env`, and a host that
builds from the repo needs them as build-time environment variables in its
dashboard. Change them, and the app has to be built and uploaded again.
Easiest hosts (all have free tiers):

- **Vercel** — `vercel` (or connect the repo); framework preset "Vite".
- **Netlify** — `netlify deploy --prod --dir dist`, or drag `dist/` onto your
  site's **Deploys** page (dropping it on the sites list makes a new site,
  at a new address).
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
| `npm run demo` | The app against a fake backend in the browser, no Supabase needed — see [Try it without Supabase](#try-it-without-supabase-demo) |
| `npm run build` | Type-check + build the web/PWA bundle → `dist/` (deploy this) |
| `npm test` | Run the unit tests (stats, offline outbox and sync, CSV, validation, …) |
| `npm run test:watch` | Same, in watch mode |
| `npm run preview` | Serve the built web app on your LAN |
| `npm run dev:desktop` | Native desktop app (Electron) in dev |
| `npm run build:desktop` | Package a native desktop installer → `release/` |
| `npm run build:desktop:dir` | The desktop app unpacked, without an installer → `release/` |
| `npm run typecheck` | Type-check the web + desktop code and the e2e suite |
| `npm run test:e2e` | Browser tests with Playwright against a built copy (no backend needed), on ports 4183, 4182 and 4181 (`E2E_PORT`, `E2E_DEMO_PORT`, `E2E_DEV_PORT` move them). The first time, run `npx playwright install chromium` |
| `bash supabase/tests/run.sh` | Run the migrations and `schema.sql` against a throwaway Postgres and check the result. Needs `psql`, `createdb`, `dropdb` and `pg_dump`, with the `PG*` variables pointing at a server where it may create databases (all named `bettracker_test_*`) |

CI (`.github/workflows/ci.yml`) runs on every push and pull request: a secret
scan (gitleaks), the unit tests, the type-check and the build, the schema
checks against Postgres, and the e2e suite.

## Settings

The sliders button in the header opens per-user settings, stored in the
`user_settings` table (migration 004) and cached on the device so they work
offline and follow you to other devices:

- **Odds format** — American (default), decimal or fractional. Odds are always
  *stored* as decimal; this only changes how they are shown and typed. The odds
  box is lenient either way: `+150`, `1.91` and `3/2` are all understood.
- **Unit size** and **Show amounts in** dollars or units — see
  [Bankroll and units](#bankroll-and-units). Units need a unit size; clearing
  it switches back to dollars.
- **Bankroll** — what it stands at, and a link to the Bankroll dialog.
- **Default stake** — prefilled in quick add (the floating `+` button, or `T`).
- **Monthly loss limit** — a banner appears when the current month's net loss
  reaches 80% of it (amber) and again once it reaches it (red). It never blocks
  logging a bet; dismissing it hides it until the next line is crossed or the
  month turns.

## Bankroll and units

**Bankroll.** The *Bankroll* tile (first of the small stat tiles) opens a
dialog where the bankroll adds up:

> starting bankroll + deposits − withdrawals + settled P/L = current bankroll

The **starting bankroll** is what you had before your first bet. **Deposits
and withdrawals** are logged there (amount, date, an optional note) and can
be edited or deleted, with Undo; they work offline and sync like bets. They
are not bets: they never count in P/L, ROI, streaks or the loss limit, and
they are never painted as wins or losses. Pending bets add nothing until they
settle; their stakes show as *riding*. The bankroll always covers every bet,
whatever date range is chosen. With no starting bankroll and no deposit or
withdrawal it reads *—*; on a device that has not loaded your settings or
your deposits and withdrawals yet (a first start offline) it reads *…*
rather than a wrong figure.

**The chart** switches between **P/L** (the running result, from 0) and
**Bankroll** (the bankroll as a level, with the money put in — start plus
deposits less withdrawals — as a dashed line; the gap between them is the
P/L). One axis either way. The choice is remembered on the device.

**The 5% note.** Under the stake box in quick add and in the day form, a
quiet line says what share of the current bankroll the stake is, and turns
amber above 5%. It never blocks or asks for confirmation. In the day form it
applies to a bet dated today or later, or one still pending; a settled bet in
the past is history.

**Units.** Set a unit size (what one unit is worth) and switch *Show amounts
in* to Units: every amount — stat cards, chart, calendar, history, breakdown,
pending panel, loss banner — reads in units (`+2.35u`, stakes as `2.5u`),
with the dollars on hover for the big figures. It is display only: one size
applies to all history, you still type amounts in dollars (the note under the
stake box shows them in units), and the database and the CSV stay in dollars.

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
Bettracker/
├── vite.config.ts              # web / PWA build (the phone + browser app)
├── electron.vite.config.ts     # desktop build
├── electron-builder.yml        # desktop packaging targets
├── playwright.config.ts        # e2e suite (e2e/), run against a built copy
├── .github/workflows/ci.yml    # CI: secrets scan, tests, build, schema, e2e
├── supabase/
│   ├── schema.sql              # run once in your Supabase project
│   ├── migrations/             # 001–005, for installs made before each change
│   └── tests/                  # runs the two above against a real Postgres
├── build/make-icon.mjs         # regenerates all app/PWA icons
├── e2e/                        # Playwright specs + the harness that boots the app on a fake Supabase
└── src/
    ├── main/index.ts           # Electron: a native window around the web UI
    ├── preload/index.ts        # minimal (data goes over the network, not IPC)
    ├── shared/types.ts         # Bet, BetInput, Settings, OddsFormat, BankrollMove
    ├── shared/supabaseEnv.ts   # checks VITE_SUPABASE_URL / _ANON_KEY (the build and the app)
    └── renderer/src/
        ├── App.tsx             # auth gate + dashboard + live sync wiring
        ├── auth/               # AuthProvider + Login screen (+ authErrors.ts, Supabase's refusals in words)
        ├── data/bets.ts        # Supabase CRUD + realtime subscription
        ├── data/useBetSync.ts  # bets state: cache, outbox, sync loop
        ├── data/offline.ts     # device cache + outbox
        ├── data/drain.ts       # replaying the outbox: what leaves it, what stays
        ├── data/errors.ts      # reading a failed request: offline, paused, retry, migration needed, refused
        ├── data/session.ts     # no request for a user's rows without their session
        ├── data/store.ts       # the queues in storage, shared by every window under a lock (and a version in IndexedDB)
        ├── data/useOpQueue.ts  # a queue of ops as the bets and the moves keep it (storage, drain lock, refused)
        ├── data/settings.ts    # per-user settings (+ useSettings.ts, the same in small)
        ├── data/moves.ts       # deposits and withdrawals (+ useMoves.ts, their cache, outbox and sync)
        ├── lib/                # supabase client (requests time out after 30 s), validation, csv, odds, dates, stats, bankroll, format, strings, …
        ├── demo/               # `npm run demo`: the fake Supabase (shared with e2e) and its entry
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
applies an edit only if the row's `updated_at` is not newer. A new bet carries
the moment it was logged (or last edited, if that was before it synced) the
same way, so an edit made while its insert is still on the way is never taken
for an older one. If another
device's later edit already landed, the older one is refused, dropped from the
queue, and the app shows "A newer edit from another device was kept" before
refreshing to the winning version (unless a later change to that bet from this
device is still queued: that one has the last word). A retry of the same edit after a lost
response still applies (its own timestamp satisfies the check), and a delete
beats an edit in either order. Device clocks are trusted, which is the price
of a conflict rule that needs no server-side logic — no extra column, no
trigger.

**Offline.** The last-known rows are cached on the device for instant startup,
and mutations go through a persistent outbox: applied to the UI immediately,
replayed against Supabase in order on reconnect (entry ids are client-generated
UUIDs, so a retried insert can never create a duplicate). Editing an entry
whose insert has not been sent yet rewrites that queued insert; deleting one
cancels it before the server ever hears about it. Once a change has gone out,
though, it is left alone, even if its answer never came back (it may have
landed): an edit or a delete made afterwards queues behind it and goes out
after it, so nothing done while a request is out, or after one fails, is lost.
The change at the head of the queue when the app starts counts as gone out,
since a version from before this rule did not record it. If the server
refuses a new bet on its first try, the edits queued for it are dropped with
it (they could only be refused too); a delete or an Undo queued for it stays.
Deposits and withdrawals have their own cache and outbox under exactly the
same rules (and the same conflict rule), so one held back by a missing
migration never holds back a bet. A change that finds no session (it ran out
and couldn't be renewed: signing out on another device ends it here too) or
a key Supabase doesn't take stays queued too, and goes out after the next
sign-in, or with a copy of the app that has the right key. The data layer
asks for the session before every read and write, because without one
supabase-js would go as nobody and row-level security would answer as for
nobody: an empty history, an edit with no row to change. A request the server
fails for now (a 5xx, a rate limit, a timeout) leaves the change queued and is
tried again after a growing wait; only a refusal for good takes a change out
of the queue, into the **Refused** notice. Every failure keeps its HTTP status
and error code, which is what tells the two apart. Full reads page through
the rows the server sends, from where the last page ended, so a project whose
`max-rows` is below the 1,000 asked for still reads in full.

**Security.** Auth is Supabase email/password. Row-level security means every
query is automatically scoped to the signed-in user; one account can never read
or write another's rows. The publishable (or anon) key in the client grants
nothing beyond those policies, and the build refuses a key that would (a secret
or `service_role` key) or a database connection string, so neither can end up
in a published bundle.

## Data model

One row per bet, per user (`supabase/schema.sql`, table `entries`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | generated on the device, so a retried insert is recognised instead of duplicated |
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
| `created_at` | timestamptz | when the row reached the server ("logged at") |
| `updated_at` | timestamptz | when the bet was last logged or edited, on the device that did it — the key the conflict rule compares |

Deposits and withdrawals live in `bankroll_moves` (migration 005): `id`
(generated on the device), `user_id`, `date`, `amount` (`> 0` a deposit,
`< 0` a withdrawal, never `0`), `note`, `created_at` and `updated_at` (the
conflict key, as for bets). The starting bankroll and the unit size are
settings (`user_settings`, migration 004).

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
`date, status, stake, odds, closing_odds, amount, sport, book, bet_type, note`
(odds as decimal) — summing a
spreadsheet reproduces that day's total.

**Import** reads that same shape back, so an export is a working backup of
your bets (deposits, withdrawals and settings are not in it). Only a
header row is required; column order doesn't matter, extra columns are ignored,
and common aliases from other trackers are accepted (`day`, `p/l`, `profit`,
`risk`, `wagered`, `league`, `sportsbook`, `market`, `notes`, `result`,
`price`, and `session` from the days when a row was called that, …). Files
from before odds and statuses existed import unchanged — the status is what
the amount implies. The import reports how many rows came without a stake,
since those stay out of ROI. Values may
carry currency symbols, thousands separators, or parenthesised negatives
(`"$1,234.50"`, `(45.00)`). Odds and closing odds may be decimal (`1.91`,
`2,50`), American (`+150`, `-110`, `-110.00`, `+2,500`) or fractional (`3/2`,
`10:11`, `100-1`); they are stored as decimal either way. A whole number from
100 up, like `150` or `150.00`, could be +150 with its plus sign dropped
(spreadsheets do that) or a decimal longshot, and `1,200` could be +1200 or
1.2, so the file decides, for both odds columns at once: an export from this
app is decimal (unless American odds were typed into it); a header that
names the format (`american odds`, `decimal odds`) settles it; otherwise
signed prices elsewhere in the file make it American and decimals make it
decimal, and a file with both kinds reports that line instead of guessing.
With nothing else to go by, a `1,200` makes the file decimal, and a whole
number follows your odds format setting, both as the odds box reads them. A
cell that is not a price that can be stored counts for nothing. Lines that can't be read are skipped and reported
rather than half-guessed, and the import queues through the same offline outbox
as everything else — so it works with no connection and can't create duplicate
rows if it's retried. It goes up in chunks of 250, and the app keeps count of
the chunks the server confirmed: an import cut halfway sends only the rest
when it is retried, and a row that did land is never written over (another
device may have edited it since). A confirmed row is the server's from then
on, so one deleted on another device stays deleted. Only rows of the chunk
that was out when the connection dropped are sent again; if one of those
had landed and was deleted elsewhere before the retry, it comes back.
