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

Play **casino games** too (Stake's Dice, Limbo, Mines …)? Log each session
as a **casino play**: the game, what it won or lost, and **Won** or **Lost**
(see [Casino plays](#casino-plays)).

Track your **bankroll** too: a starting figure plus every **deposit and
withdrawal**, so the current bankroll adds up to the cent, a chart view of it
over time, and a quiet warning when a stake is more than **5%** of it. And if
you think in **units**, set what one is worth and every amount reads in units.

And your **everyday expenses**, in a tab of their own: a coffee logged in a
couple of taps, each **card** kept apart, **monthly budgets** (for the month,
per card and per category) and one chart of what all the cards spent. Type an
expense, or let **AI** read it from a photo of a receipt or an Apple Wallet
screenshot (optional, see [AI reading of receipts](#ai-reading-of-receipts-optional)).
Expenses are shown in the **currency** you choose (your main one); an expense
paid in **another currency** (a USD charge when you keep your accounts in CAD)
is recorded as paid and converted to yours at that day's exchange rate. Bets
stay in dollars.

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

The count covers every queued change: bets, deposits and withdrawals,
expenses, cards and budgets. A settings change waiting to sync shows on the
badge too (without a count).
A request the server never answers is given up after 30 seconds, as if the
connection had dropped, and tried again later.
Signing out removes that device's local copy (cache, queued changes and
refused ones); anything already synced stays safe in your Supabase project.
While changes are still queued or refused, **Sign out** asks you to click
again. A sync still on its way when you sign out writes none of it back, and
nothing of one account is ever read or sent as another that signs in on the
same device. Signing out in one window signs the app's other windows out too.

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
  windows stored meanwhile (what this window sent or deleted stays out). A
  change Supabase refused while there was no room to keep it counts here too.
- **Refused** — Supabase refused a change for good (a check it fails, say).
  It leaves the queue so it can't block the rest, and waits here with the
  server's reason: **Send again** (never over a newer edit of the same bet)
  or **Discard**. Sent again while the queue can't be stored, it stays
  stored here, out of sight, until it has gone or the queue is stored.

Several windows of the app (two tabs, or a tab and the installed app) share
one queue: each change is made to the stored queue under a lock that spans
windows (the Web Locks API), only one window sends it at a time, and a change
made in one window shows in the others. The lock alone isn't enough, because
each window reads its own copy of the browser's storage, which another
window's write reaches a moment later; so every change also counts up a
version kept in IndexedDB, and the next window waits until its copy has it
before reading. Over plain http on your local network (`npm run dev` on the
phone) the browser has no such lock, and windows there don't coordinate.

Small things that add up: a **light theme** (in the menu ☰ — it follows your
OS until you pick one, then stays put), **search and filters** over your history
with paging, a balance chart you can flip between **all time and the selected
month**, the interface in **English or Spanish** (the menu switches it;
it follows your browser until you pick one, then stays put; validation and
sync error messages stay in English), and
keyboard shortcuts — `←`/`→` to change month, `T` to log today (an expense,
in the Expenses view), `Esc` to close a dialog.

The **Bets | Expenses** tabs under the header switch between the two views
(each device remembers the last one). The top bar holds only the name, the
sync badge and the menu (☰): the account, **Import & export**, **Pending
bets**, **Settings**, **Expense settings** (cards, budgets and the expense
currency, from either view), the theme, the language and **Sign out**. The
menu button shows how many bets are waiting for a result; the menu works
from the keyboard (arrows, Home/End, Escape back to the button). Adding is
the round **+** button at the bottom right, on a computer as on a phone: a
bet in the Bets view, an expense in the Expenses view (`T` does the same).
The end of the page keeps clear of it, so the history's pager and the last
rows are never under it.

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
   `entries`, `user_settings` and `bankroll_moves` tables and the expenses'
   `expenses`, `expense_cards` and `expense_budgets`, locks them to each user
   with row-level security, and enables realtime sync.
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
     in either order) and
     [`006_lost_free_bets.sql`](supabase/migrations/006_lost_free_bets.sql)
     (a free bet that loses stays lost when edited later; it only replaces
     003's trigger, so it runs after 003) and
     [`007_deleted_rows.sql`](supabase/migrations/007_deleted_rows.sql)
     (a deleted bet, deposit or withdrawal stays deleted: an insert sent
     again after its answer was lost can no longer bring it back; it runs
     after 005) and
     [`008_expenses.sql`](supabase/migrations/008_expenses.sql)
     (the Expenses view: expenses, cards, monthly budgets and the currency
     expenses are shown in; it runs after 007 and 004, and stops with a
     message if either is missing) and
     [`009_expense_original_currency.sql`](supabase/migrations/009_expense_original_currency.sql)
     (an expense paid in another currency: three columns on `expenses` for
     what was paid, its currency and the rate; it runs after 008, and stops
     with a message if 008 is missing). Not sure which you have run?
     [`supabase/check_migrations.sql`](supabase/check_migrations.sql) is a
     read-only query for the SQL editor that lists 002 to 009 with **yes** or
     **NO** next to each; it changes nothing. Your existing bets are untouched —
     old ones simply have no stake or odds recorded, and 003 gives each the
     status its result implies. Without 006 everything works, except that
     editing a lost free bet ($0 stake, $0 result) turns it into a push (its
     P/L stays $0). Without 007 everything works too, except that a bet
     deleted on one device can come back when another device sends again an
     insert of it whose answer was lost (an import, a restore, a quick add on
     a bad connection). Without 008 the bets and the bankroll work as before;
     the Expenses view says the database needs it, what you add there waits
     on the device as **Update needed**, and budgets and the currency can't
     be set until it has run. Without 009 (and with 008) the Expenses view
     reads and shows everything, and budgets and the currency work, but an
     expense you add or edit waits on the device as **Update needed** (every
     such change names 009's columns): the view says which file to run, and
     what waits is sent by itself once it has.
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
   **Forgot your password?** on the sign-in screen uses the same rule: the
   reset email links back to the address it was asked from when that is
   listed under Redirect URLs, else to the Site URL, and the app opens on a
   form for the new password. Supabase's own mailer sends only a few emails
   an hour; for real use, set up SMTP (**Authentication → Emails**). The
   desktop app (a `file://` page) can't receive the link: it opens in the
   browser, at the Site URL — set the new password there, then sign in on
   the desktop.

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
**Network** URL works on your phone too; each browser has its own demo.

**Load sample data**, in the same bar, fills the demo so you can look at the
app full before putting anything real in it: two months of a made-up
person's bets (sixty, with a starting bankroll and a deposit) and everyday
expenses in Canadian dollars (two cards, some paid in US dollars with their
rate, a refund, rows read by AI, four budgets with one near its limit and
one over). It is the same every time, dated back from today, and it replaces
whatever the demo holds (it asks first when there is anything to replace);
the app then reloads on the view you were on. From there it is ordinary
data: edit it, add to it, or **Start over**.

None of the demo's code or sample data goes into `npm run build` (only its
strings and the banner's CSS do); the e2e suite reads the built scripts to
make sure.

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
| `npm run check:rates` | Ask the **real** exchange-rate service for the latest rate, a past weekday and a past Saturday, and read the answers with the app's own parser. Needs internet access; see [Other currencies](#other-currencies-and-exchange-rates) |

CI (`.github/workflows/ci.yml`) runs on every push and pull request: a secret
scan (gitleaks), the unit tests, the type-check and the build, the schema
checks against Postgres, and the e2e suite. None of it touches the network:
the tests answer for Supabase, Anthropic and the exchange-rate service
themselves. The one check that calls a third party, `npm run check:rates`,
has a workflow of its own (`.github/workflows/rates-contract.yml`): run it by
hand from the Actions tab, and it also runs on a pull request that touches
the rates code. The main CI never depends on it.

## Settings

**Settings** in the menu (☰) opens per-user settings, stored in the
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

## The dashboard

First come the numbers looked at most: P/L over the chosen range, the
bankroll, and the bets still waiting for a result (a click opens the bankroll
or the pending list). Then the month (with its own month to month arrows)
and ROI. Strike rate, the break-even rate the odds imply, CLV, winning days,
streaks, best and worst day, drawdown and the breakdowns are under
**Advanced analytics**, closed until opened (remembered on the device).
Bets and days are kept apart in the words: "bets won" is the strike rate,
"winning days" the share of days that ended up; each figure says how many
bets it covers (the break-even rate covers only those with odds).

A new account (no bets yet) gets a short **Getting started** guide: set the
starting bankroll, choose how odds are written, log the first bet. It goes
once the three are done, or when hidden.

The **+** button at the bottom right (or `T`) logs a bet in a couple of taps,
for today unless another date is picked; **More details** carries what was
typed to the full form. Its **Sports | Casino** switch at the top logs a
casino play instead (see [Casino plays](#casino-plays)). The calendar's days
open their own day too.

## Date ranges

The row above the stat cards picks the range P/L, ROI, the balance chart and
the advanced analytics are computed over: all time, this week (Sunday to
Saturday), this month, the last 30 days, this year, or custom dates
(inclusive at both ends). The bankroll, the pending bets, the calendar, its
month card and the history always cover every date, and each card says
which (a tag such as "All dates"); the history can be narrowed to the range
with its **Dates shown** filter. The choice is remembered on the device.

## Forms: problems in words, drafts, free bets

A form says what is wrong next to the box, in words (tied to the box for
screen readers), and moves the focus there; buttons are not greyed out
instead. A bet the app refuses keeps the form open with everything typed,
and says why above the buttons; a form closes only once its bet is accepted.
Closing a form by accident (Escape, a tap outside, a reload) keeps what was
typed as a draft: the quick add keeps one, the day's form one per day and
one per bet being edited. It opens again with the draft (and says so), until
it is saved or **Discard**ed. Drafts live on the device and go with a
sign-out.

A **free bet** is a stake of 0: it stays out of ROI and its profit is shown
apart, as bonus. Its win can't be worked out from a $0 stake, so the app
asks for the promotional profit the book paid; one that loses is lost at
$0. A profit that rounds to $0.00 at the odds given is asked for too.

The pencil in the history edits that bet; the date opens the whole day. On a
phone the history is a list of cards (date, result, amount, stake and a
short description), each opening to its odds, closing odds, tags, note and
actions; selecting cards works as ticking rows does.

## Editing the history in bulk, and Undo

Tick rows in the history (the header box ticks the page) and a bar appears,
saying how many are selected and how many of those the filters hide, to
**retag** them (empty boxes keep a bet's current tag), **settle** the
pending ones as won / lost / push / void (a win whose profit can't be worked
out, with no odds or a free bet, and a loss without a stake are skipped) or
**delete** them (click twice: the button says how many). Every delete
— single or bulk — and every bulk edit shows an **Undo** in its toast. Undo
writes the previous values back through the same outbox, so it works offline
and syncs like any other change; a restored bet keeps its id but gets a new
"logged at" time.

## Pending bets

The menu button (☰), and the **Pending bets** card on the dashboard, show how
many bets are still waiting for a result; **Pending bets** in the menu (or a
click on the card) opens a panel listing them, oldest first. Each settles in one tap
(WON / LOST / PUSH / VOID — the result is worked out from the stake and odds),
and a bet whose date has passed is flagged so it is not forgotten. Settling
works offline like any other edit. A result that can't be worked out (a win
without odds, a loss without a stake) opens the bet's form to type it.

## Casino plays

Besides sports bets, the quick add logs **casino plays** (Stake's Dice,
Limbo, Mines, Plinko …): **Sports | Casino** at the top of the sheet (a
radio group: the arrows, Home and End switch it) opens on the kind of the
bet logged last. The casino side asks for the date, the **game** (ten chips
for Stake's common games, or **Other game**, which suggests the ones used
before; the last game comes chosen), the **amount** won or lost, net, and
**Won** or **Lost**, which gives it its sign. Under them, small and
optional: the **site** (the last play's, else Stake) and what was
**wagered**. A loss can't be more than what was wagered. The sports side is
the sheet as it was, its tags and stake taken from the last *sports* bet, so
a casino play in between never turns the next bet's sport into "Casino".

There is no new table or column: a casino play is an ordinary bet with sport
**Casino** (a bet already tagged "casino" counts too), the game as its bet
type, the site as its book, no odds, the net result as its amount and what
was wagered, when typed, as its stake. So it counts in P/L, the bankroll,
the calendar and the monthly loss limit; the breakdown shows **Casino** as
a sport and each game as a bet type; ROI counts only the plays with a wager;
CLV and the odds bands leave them out. The history, the day and the pending
list read one as "Casino · Limbo · Stake". The full form edits it like any
bet, with no odds asked for and the stake optional. It goes through CSV and
backups unchanged. More in `docs/casino-2026-11.md` (Spanish).

## Expenses

The **Expenses** tab (next to **Bets**, under the header) is for everyday
spending: a coffee, a taxi, the groceries. It needs migrations 008 and 009
(see [setup](#1-create-the-supabase-project)); until they have run, the view
says which one is missing and what you add waits on the device.

- **An expense** has a date, an amount, a card (or none), a merchant, a
  category (coffee, food & restaurants, groceries, transport, shopping,
  entertainment, health, home & bills, subscriptions, travel, other) and a
  note. The **+** button at the bottom right (or `T`) opens a sheet, with
  **Scan receipt** at its top, that starts on the amount and remembers the
  last card and category on that device. Amounts read the way you type them:
  `4,50`, `4.50`, `1.234,50` and, in a currency without cents, `12.500`. A
  **refund** (or credit) is an expense below zero: it shows in green and
  lowers that month's spending.
  Edit and delete from the list; each comes with an **Undo**. It all works
  offline and syncs like the bets.
- **Merchants you have typed before** are suggested as you type (the latest
  first). In a new expense, one of them also brings the **category and card
  it was last filed under**, and a line under the box says so ("As last
  time: Coffee · Visa"). It only fills what you haven't chosen yourself in
  that sheet, it follows the name as it stands (type on past "Uber" to "Uber
  Eats" and you get Uber Eats' own), and it never touches an expense you are
  editing.
- **Each category has a small glyph** next to its name wherever it is named:
  the sheet's chips, the list (leading each row on a phone), the categories,
  the scan review and the budgets. Decoration only, in a neutral ink (colour
  is kept for money), and hidden from screen readers.
- **Cards** — as many as you like (name, last 4 digits, credit or debit),
  under **Expense settings** (in the menu ☰). Deleting a card that has
  expenses archives it: it leaves the pickers and its expenses keep its name. An expense whose card
  isn't there shows under **No card**.
- **Budgets** — monthly, the same every month: one for the whole month, one
  per card and one per category, all optional. The **Budgets** panel gives
  each one two lines, its name and `$338.81 of $400.00 · $61.19 left` (or
  `· $12.00 over`), with a bar under them: amber from 80%, red once over, and
  always said in words too. They never block anything. With no budget set the
  panel is one quiet line, *No budget set*, and **Set one**, which opens
  Expense settings at the budgets. A budget of an archived card is left out
  until the card is restored. Two devices that set the same budget meet on
  one row.
- **Currency** — expenses are shown in the currency picked in **Expense
  settings**: your main currency (USD by default; CAD, EUR, MXN, COP, ARS,
  CLP, PEN and more). Its code stands next to the month's title and amounts
  are written with its short symbol (`$16.80` for Canadian dollars too).
  Changing it converts nothing: the same numbers are shown with the new
  symbol. Bets stay in dollars, and units never apply to expenses.
- **Other currencies** — an expense can be paid in a currency that isn't
  yours: pick it next to the amount, and the app converts it (see
  [Other currencies and exchange rates](#other-currencies-and-exchange-rates)).
- **The month** — four figures in one strip: what was spent, what is left of
  the budget, each card's share and the daily average. Under what was spent,
  one line compares it with **the month before**: day for day while the month
  is under way ("12% less than at this point last month": both months up to
  today's day number, never part of a month against a whole one), whole
  months for a past one. An arrow and plain words, no colour; hover it for
  the figure it is compared with. It is left out when the month before has no
  expenses. **By card** lists the three largest; **+n more** is a button that
  lists them all. Then one chart of every card's spending (running total
  against the budget, drawn with straight segments so nothing reads as spent
  before its day, or per day; hover or tap a day for its figures, days still
  to come say nothing), the categories (each one's share of the month's
  positive spending, so they add up to 100%; a refund lowers its own
  category's net), and the list (a table on a computer, cards on a phone;
  search, and filter by card and category). The arrows and `←`/`→` change
  the month, shared with the bets' calendar. On a phone the strip is two
  columns: the total across the top, *Budget left* and *Daily average* side
  by side, *By card* across the bottom.
- **The daily average and the projection** — the average is the net of what
  is dated **through today** divided by today's day number: an expense
  logged ahead (the rent due on the 30th, entered on the 2nd) is not in it,
  or two days would average a month's rent. Its line says so and where the
  month is heading: "19 days · on pace for $1,685.40", the average over
  every day of the month **plus what is already dated after today** (it is
  spent whatever the pace). Hover it for the figure the average is made of.
  A past month says "Over 31 days" and projects nothing (the month is what it
  was); a month still to come says it hasn't started. The projection lives
  in that one line: the total above it is always what was actually spent.
  Until the expenses have loaded on the device (or while it is offline and
  never did) the figures are "—" and the reason is said once under the
  total, in the chart and in the list; a zero is only ever a real zero.
- **Tap a card or a category to see its expenses** — a card under *By
  card*, a card's or a category's budget, or a category under *By category*:
  the list shows just that card's (or that category's) expenses for the
  month, scrolls up into view and says so in a quiet line above it ("Visa ×
  · 12 expenses · $561.63", with **Show all**). The budgets' monthly total
  shows the whole month again; the list's boxes always show the same filter.
- **Scan receipt**, first in the expense sheet — the AI reads a receipt
  photo or an Apple Wallet screenshot and fills in the expenses for you to
  check before anything is saved (see [AI reading of receipts](#ai-reading-of-receipts-optional)).
- **Export CSV** (in the list) writes every expense, with the columns `date,
  amount, currency, card, card_last4, merchant, category, note, source,
  original_amount, original_currency, fx_rate`. `amount` is in your main
  currency (`currency`); the last three are filled for an expense paid in
  another one (what was paid, in what, and the rate) and empty otherwise. They
  were added at the end, so a spreadsheet built on the first nine still reads
  them where it expects. The bets' CSV is unchanged.

### Other currencies and exchange rates

Say your main currency is Canadian dollars and a subscription charges you in
US dollars. In the expense sheet (the **+** button), pick **USD** in the box
next to the amount and type what you paid. Under it the app shows the **rate**
of that day and the amount **in CAD**, and saves both: `USD 12.00` as paid,
`$16.80` as what it counts for. Totals, budgets, the chart and the categories
always use the amount in your main currency; the list shows the original
beside it, small, written with its code so a bare `$` always means your own
currency.

- **Both boxes can be typed in.** Type the amount your bank actually charged
  (banks add their own fee) and the rate follows it; type a rate and the
  amount follows. What you type is kept when you change the date; empty the
  box and leave it to get the day's rate back.
- **The line under them says where the rate is from**: "Rate of Nov 13 (ECB)",
  "Saved with this expense" when you edit one, or "Typed by you". Editing an
  expense shows what was saved and asks for nothing until you change its date
  or currency.
- **No rate, no guess.** If there is no rate (no connection and none saved,
  or a currency the service doesn't publish, such as COP), the two boxes stay
  empty and say so; the expense is saved once you type the rate or the amount
  in your currency. An amount in dollars is never saved as if it were yours.
- **Scan receipt** works the same way for each row of a picture: every row
  has its own currency (see [AI reading of receipts](#ai-reading-of-receipts-optional)),
  a row in another one shows what was read and what it comes to, and one
  field per currency gives a rate to every row of it that has none. A row
  without a rate is left out of **Add N** until it has one.
- The currency you last paid in is offered first, after your own.

**Where the rates come from.** [Frankfurter](https://frankfurter.dev), a free
service with no account and no key that publishes the European Central Bank's
reference rates: one rate per business day, around 16:00 CET, for about
thirty currencies (USD, CAD, EUR, GBP, MXN, BRL, JPY, CHF and others; not
COP, ARS, CLP or PEN). A weekend or a holiday uses the business day before
it, and the line says which day the rate is of. These are reference rates:
what your bank charged will differ a little, which is why the amount is
yours to correct.

**What leaves the device.** One request per pair and day, straight from the
app to `api.frankfurter.dev`, carrying **two currency codes and a date** and
nothing else: not the amount, not the merchant, no account, no cookie, no
key, no referrer. It doesn't go through Supabase. In the main currency
nothing is ever asked. The app's content security policy allows that one host
besides Supabase. The demo (`npm run demo`) asks the same service when you
pick another currency there: it is the one request the demo sends anywhere.

**Offline.** Rates are kept on the device (one small cache for the device,
not per user: a rate is nobody's data; signing out leaves it, and it is
dropped with the other caches if storage runs full). A rate already fetched
is not asked for again; without a connection the newest saved rate of that
pair is used, and the line says which day it is of.

**Checking the real service.** The tests never call it (they answer in its
place), so `npm run check:rates` is how its answers are checked for real: it
asks for the latest rate, a past weekday and a past Saturday, reads them with
the same code the app uses (`src/renderer/src/lib/fx.ts`), checks the CORS
header a browser needs, prints what it got, and exits non-zero if the app
would not read something as expected. Without internet access it says it
could not reach the service and checks nothing.

## AI reading of receipts (optional)

**Scan receipt**, first in the expense sheet (the **+** button in the Expenses
view), reads a photo of a receipt or an Apple
Wallet screenshot with Claude (Anthropic) and fills in the expenses: one per
receipt (its total, tip included), one per visible Wallet transaction
(declined ones left out, refunds as refunds). Nothing is saved until you
check them: each row can be edited or unticked, its card is matched by the
last 4 digits (or the name) the image shows, and one that looks like an
expense you already have (same date, amount and card, a similar merchant) is
unticked and shown next to it. Everything works without it: until it is set
up, scanning says so and you type the expense instead.

**The currency of each expense.** A Wallet list can mix purchases in your
currency and in another one, and a bare `$` can be any dollar, so the
reading gives each expense its own currency and says how it knows it: a code,
a currency word or a symbol of one currency shown for that amount (`USD`,
`US$`, `CA$`, `€`), or, for a bare `$`, where the image shows the purchase
was made (a US state or a Canadian province in the address, a ZIP or postal
code, Sales tax against GST/HST/PST/QST, a phone number, a website's
country). It never assumes your currency. When nothing in the image settles
it, the row takes the currency you last paid in at the same merchant, else
your own, and where that matters (you have expenses in other currencies, or
the picture mixes them) the row says **Currency assumed** so you give it a
look. When the image also shows what the card was charged in your currency
(Wallet: "USD 12.00" with "CA$16.95" under it), that is the amount saved,
**as charged**, and no rate is fetched for it. Each row's currency can be
changed in its fields, and **Currency of all rows** sets them all at once.
**After updating the app, deploy the function again** (the same `functions
deploy` as below; the secrets stay): until then the old function still
works, with one currency for the whole picture. An app installed before
this change works with the new function too: it reads the picture's one
currency, which is set when every row shares it.

It runs in a Supabase **Edge Function**, `extract-expenses`
(`supabase/functions/extract-expenses/`), with **your own Anthropic API key**,
which lives only in that function's secrets: never in `.env`, never in a
`VITE_` variable (the build refuses one, since it would be published in the
app). The function checks that the caller is signed in and on its allow list,
sends the image to Claude (`claude-opus-5-5`) with a fixed prompt and a JSON
schema (`src/shared/expenseExtraction.ts`, shared with the app, which checks
the answer again) and returns the expenses it read. It stores nothing.

### Set it up

In this order: (1) run migrations `008_expenses.sql` and
`009_expense_original_currency.sql` in the SQL editor (after 007); (2) deploy
the function and set its secrets; (3) deploy the app. In any other order
nothing is lost: expenses wait as **Update needed** until 008 and 009 have
run, and scanning says AI reading isn't set up until the function is there,
while typing an expense works.

You need the [Supabase CLI](https://supabase.com/docs/guides/cli), run here
through `npx` at the version these steps were last checked with, **3.2.0**
(a newer one may name its flags differently; check `--help`), and the
project's **reference id** (the `<ref>` of `https://<ref>.supabase.co`).

```bash
# From the repository root (the folder that holds supabase/).
npx supabase@3.2.0 login

# The secrets go in a file, not on the command line (it would stay in the shell
# history). supabase/functions/.env is git-ignored (the .env rule). It holds:
#   ANTHROPIC_API_KEY=<a key from a dedicated Anthropic workspace, see below>
#   EXTRACT_ALLOWED_USERS=<your user id>
npx supabase@3.2.0 secrets set --remote=<ref> --env-file supabase/functions/.env
rm supabase/functions/.env

npx supabase@3.2.0 functions deploy extract-expenses --remote=<ref> --no-verify-jwt
```

- **`--no-verify-jwt`**: the function checks the user itself, and the
  browser's CORS preflight (which carries no token) must reach it. The same
  setting is in [`supabase/config.toml`](supabase/config.toml)
  (`[functions.extract-expenses] verify_jwt = false`), so a plain `functions
  deploy` can't turn the gateway's check back on.
- **Docker**: the CLI bundles the function with Docker when it's running;
  without it, add `--use-api` to bundle on Supabase's side.
- **Everything the function needs is under `supabase/functions`**: its
  `index.ts` and `_shared/expenseExtraction.ts`, a byte-for-byte copy of
  `src/shared/expenseExtraction.ts` (the app's own module), so bundling never
  has to reach outside that folder, with or without Docker. The copy is never
  edited by hand: after changing the module run `npm run sync:function`; a
  unit test fails while the two files differ.
- **The secrets can also be set in the Dashboard** (Edge Functions →
  Secrets) instead of with `secrets set`: the same two names and values, and
  no file to make or delete.
- **`EXTRACT_ALLOWED_USERS`**: who may scan, comma-separated user ids
  (recommended; **Authentication → Users** shows yours) or confirmed emails.
  Unset, every scan is refused ("This account isn't allowed"). `*` lets every
  signed-in user scan: never use it while **Allow new users to sign up** is on
  (**Authentication → Sign In / Providers**), or anyone could sign up and
  spend your key.
- **The key**: make a **dedicated Anthropic workspace** for this function in
  the [Anthropic Console](https://console.anthropic.com), give it a **monthly
  spend limit**, and create the key there. That limit is the only hard cap:
  the function's own throttle (one scan at a time and 20 per 10 minutes per
  user, per server instance) is best effort. When the limit or the credit
  runs out, the app says so and typing still works.
- **Time**: a scan usually takes 10 to 60 seconds. The app gives up after
  115 s and the function stops by 108 s, retrying at most once and only after
  a quick connection or server failure, so a scan the app gave up on is never
  still running, nor billed twice.
  Check in Supabase's docs (Edge Functions → Limits) that your plan lets a
  function run that long.
- **Checking it compiles** (optional, needs Deno; `npx` fetches it):
  `npx --yes deno@2.9.6 check --config supabase/functions/extract-expenses/deno.json supabase/functions/extract-expenses/index.ts`.
  Behind a proxy with its own certificate, set `DENO_CERT` to that
  certificate. `deno.json` sets `"lock": false` so the check doesn't write a
  `deno.lock` into the repository: the direct dependencies are pinned in the
  import lines themselves.
- **The SDK version** is pinned in the import (`npm:@anthropic-ai/sdk@1.8.0`).
  When you move it, take the newest release that is **at least 7 days old**
  (not one published the day before), and run the check above: it fails if a
  field the function uses (`fallbacks`, `output_config.format`,
  `stop_details`, the error codes) isn't typed in that version.
- **Undo**: `npx supabase@3.2.0 functions delete extract-expenses --remote=<ref>`
  (the app goes back to "not set up"). 008 and 009 are additive and need no
  undoing for the app to keep working.

### What it costs

Claude Opus 5.5 costs $4 per million input tokens and $20 per million output
tokens. The app sends the image at most 1600 px on its long side: a 1600×1200
photo is about 2,600 input tokens (width × height / 750; a 739×1600 Wallet
screenshot about 1,600), plus about 2,000 for the instructions and the
schema, so about **$0.018** of input. The answer and the model's thinking
(effort medium) take about 1,000 to 5,000 output tokens (each row carries its
currency too), **$0.02 to $0.10**. All in, about **3 to 12 US cents per
scan**. If Claude declines an image and the request falls
back to another model (the function asks for that fallback), that attempt is
billed at that model's rates; the function logs it (`fallback: true`).

### What leaves the device

From the device, through the function, to Anthropic under your API key: the
image (re-encoded as a JPEG, which drops the location and camera details),
your cards' names and last 4 digits (to match the card; never their ids),
today's date, your time zone, the expenses' currency and the app's language.
The function stores nothing and logs only codes, sizes, timings and token
counts, never the image, an amount or a merchant. The app keeps nothing of
the image either (not on the device, in a draft, in a backup or on the
server); only the expenses you confirm are saved. Anthropic handles what it
receives under its commercial terms; how long it keeps API data is in its
[Privacy Center](https://privacy.anthropic.com).
In the demo (`npm run demo`) nothing is sent anywhere: the image stays in the
browser and a sample result is shown.

## How it's put together

```
Bettracker/
├── vite.config.ts              # web / PWA build (the phone + browser app)
├── electron.vite.config.ts     # desktop build
├── electron-builder.yml        # desktop packaging targets
├── playwright.config.ts        # e2e suite (e2e/), run against a built copy
├── .github/workflows/ci.yml    # CI: secrets scan, tests, build, schema, e2e
├── .github/workflows/rates-contract.yml  # the real exchange-rate service, checked apart (by hand, and on PRs that touch the rates code)
├── scripts/check-rates.mjs     # `npm run check:rates`: that check
├── supabase/
│   ├── schema.sql              # run once in your Supabase project
│   ├── migrations/             # 001–009, for installs made before each change
│   ├── check_migrations.sql    # read-only: which of them this project already has
│   ├── functions/extract-expenses/  # the Edge Function that reads receipts with Claude (optional)
│   ├── config.toml             # Supabase CLI settings: that function's gateway JWT check off
│   └── tests/                  # runs schema.sql and the migrations against a real Postgres
├── build/make-icon.mjs         # regenerates all app/PWA icons
├── e2e/                        # Playwright specs + the harness that boots the app on a fake Supabase
└── src/
    ├── main/index.ts           # Electron: a native window around the web UI
    ├── preload/index.ts        # minimal (data goes over the network, not IPC)
    ├── shared/types.ts         # Bet, BetInput, Settings, OddsFormat, BankrollMove, Expense, ExpenseCard, ExpenseBudget
    ├── shared/supabaseEnv.ts   # checks VITE_SUPABASE_URL / _ANON_KEY (the build and the app); refuses an Anthropic key
    ├── shared/expenseExtraction.ts  # the AI reading's prompt, schema and checks, shared by the app and the Edge Function
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
        ├── data/rowTable.ts    # expenses, cards and budgets on the server (+ rowStorage.ts, useRowSync.ts: one sync for the three)
        ├── data/extract.ts     # calls the extract-expenses function
        ├── data/fxRates.ts     # exchange rates: the request, the device's cache, what is used offline
        ├── lib/fx.ts           # their pure part: the URL, reading the answer, the conversion, the cache's shape
        ├── lib/                # supabase client (requests time out after 30 s), validation, csv, odds, dates, stats, bankroll, format, strings, …
        ├── demo/               # `npm run demo`: the fake Supabase (shared with e2e), its entry and the sample data
        └── components/         # HeroStats, CalendarView, BalanceChart, Breakdown, … (expenses/: the Expenses view)
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
refuses a new bet for good (not as one it already has, which is how it
answers one that landed), what was queued for that bet after it (its edits
and its delete, up to an Undo that adds it again) goes into the **Refused**
notice with it: sending them again does what you did, so a bet you deleted
stays deleted and one you edited is made as you left it.
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
`max-rows` is below the 1,000 asked for still reads in full. Reads don't wait
for the queue: one answered before a change landed lays that change over what
it read, so an import's rows don't vanish and a deleted bet doesn't come back
when it arrives.

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

The expenses (migrations 008 and 009) live in three tables, each row with an `id`
generated on the device, its `user_id`, `created_at` and `updated_at` (the
conflict key, as for bets). Each table is locked to its user by row-level
security, and a deleted row stays deleted (007):

- `expenses`: `date`, `amount` (`> 0` spent, `< 0` a refund or credit, never
  `0`, always in the expenses' currency: every total reads it),
  `original_amount`, `original_currency` and `fx_rate` (migration 009: for an
  expense paid in another currency, what was paid, signed like `amount`, its
  ISO code, and the units of the expenses' currency per 1 of it, with 8
  decimals; all three set or all three `null`; `amount` is normally their
  product, but it may be what the bank charged, so nothing insists on it),
  `card_id` (a card's id or `null`, with
  **no** foreign key: an expense can reach the server before its card, and
  one whose card isn't there shows as "No card"), `merchant`, `category` (one
  of the fixed keys: `coffee`, `food`, `groceries`, `transport`, `shopping`,
  `entertainment`, `health`, `home`, `subscriptions`, `travel`, `other`),
  `note` and `source` (`manual` or `ai`).
- `expense_cards`: `name` (1 to 40 characters), `last4` (4 digits or empty),
  `kind` (`credit` or `debit`) and `archived`.
- `expense_budgets`: `scope` (`total`, `card` or `category`), `target` (empty
  for the total, the card's id or the category's key) and `monthly_limit`
  (`> 0`), one row per scope and target; its `id` is made from the user, the
  scope and the target, so two devices setting the same budget meet on one
  row.

`user_settings.expense_currency` (008) is the ISO 4217 code the expenses are
shown in (`USD` by default); changing it converts nothing.

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

Everything that goes in or out is under **Import & export** in the menu (☰).

**Full backup** downloads one JSON file with every bet, deposit and
withdrawal, the settings, and the expenses with their cards and budgets:
`{ "format": "bettracker-backup", "version": 1, "exportedAt", "account",
"bets", "moves", "settings", "expenses", "expenseCards", "expenseBudgets" }`
(the expenses' currency is one of the settings, `expenseCurrency`; an expense
paid in another currency carries its `originalAmount`, `originalCurrency`
and `fxRate`, which a backup from before them simply lacks). It is
offered once all of that has loaded on the device. The expense lists came
later and are optional, so a backup from before them still restores, and an
older version of the app reads a new backup and ignores them. **This version
can't restore expenses, cards or budgets yet**: the restore says how many the
file holds and leaves them there. **Restore** checks the whole file first (a
file that isn't a backup, or comes from a newer version, is refused; an
entry that fails the app's checks is left out and listed) and then shows
what it would do. A restore only adds: a bet or deposit already here (same
id) stays as it is now, even if the backup has it differently, so restoring
the same file twice adds nothing the second time, and one deleted since
comes back. A backup of another account gets new ids, and its bets that
look like bets here are offered as possible duplicates, skipped unless kept.
The settings are replaced only when asked (the expenses' currency only
once the device has seen migration 008 working, since a database without it
would refuse the whole change). A restore can be undone like an import.

**Export bets CSV** writes one row per bet, sorted by date, with the columns
`date, status, stake, odds, closing_odds, amount, sport, book, bet_type, note`
(odds as decimal) — summing a
spreadsheet reproduces that day's total.

**Import CSV** reads that same shape back (deposits, withdrawals and settings
are not in it: that is what the full backup is for). Nothing is added before
a **review**: how many rows are ready, every line that can't go in and why,
and the possible duplicates, rows with the same date, result, amount, stake,
odds and tags as a bet already here (each bet here matches at most one row;
the note and the closing odds don't count, since they are often added
later). Possible duplicates are skipped unless you say they are separate
bets; two identical rows in the file are both kept, since two identical bets
on one day are possible. Each import is kept on the device as a batch and can
be **undone** as a whole later (the bets it added that are still there are
deleted; that Undo can be undone in turn). The same file picked again is
recognised: still on its way (an interrupted import, which finishes on its
own), it says so and importing it again takes a deliberate choice; already
imported, it says when, and its bets show as possible duplicates. Only a
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
