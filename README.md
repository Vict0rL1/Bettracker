# BetTracker

A local-first desktop app for logging daily sports-betting results. Track wins
and losses one day at a time, watch your monthly and lifetime P/L, and see your
bankroll curve build over the season. Everything is stored locally in SQLite —
no account, no cloud, no internet dependency.

Built with **Electron + React + TypeScript**, with **better-sqlite3** for
storage and **electron-builder** for packaging into a standalone installer for
Windows and macOS.

## Features

- **Daily entry** — log a date, an amount (win, loss, or push), and an optional
  note like "NBA parlay". One entry per day; every entry is editable and
  deletable.
- **Big-number dashboard** — the current month's P/L and lifetime P/L are the
  visual focal point, rendered large and bold, neon-green when up and red when
  down. Win rate, current streak, and best/worst day fill in the secondary stats.
- **Calendar heatmap** — each day of the month is a colored tile (green win, red
  loss, gray push, empty for no entry). Click any day to log or edit it.
- **History table** — every entry in a scrollable list, sortable by date or
  amount, with inline edit and delete (delete asks for a confirming second click).
- **Month navigation** — arrow between months; each month totals itself
  independently while the lifetime number stays cumulative.
- **Balance chart** — a cumulative P/L area chart over your whole history, with a
  hover crosshair and tooltip.
- **CSV export** — write every entry to a CSV file (Excel-friendly, UTF-8 BOM +
  CRLF) from the header button.

## Getting started

```bash
cd bettracker
npm install     # installs deps and rebuilds better-sqlite3 for Electron's ABI
npm run dev      # launches the app with hot-reload
```

> `npm install` downloads the Electron runtime and runs
> `electron-builder install-app-deps`, which compiles the native SQLite module
> against Electron. This needs network access to GitHub's release CDN the first
> time — run it on a machine with unrestricted outbound HTTPS.

## Building an installer

```bash
npm run build         # installer for your current OS
npm run build:win     # Windows NSIS installer  -> release/
npm run build:mac     # macOS DMG               -> release/
npm run build:linux   # Linux AppImage          -> release/
npm run build:dir     # unpacked app (no installer), for a quick sanity check
```

Artifacts land in `release/`. Building a given OS's installer is only fully
supported when running on that OS (a Windows `.exe` must be built on Windows,
a macOS `.dmg` on macOS).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev mode with hot-reload (electron-vite) |
| `npm run start` | Preview the production build without packaging |
| `npm run build` | Type-check, bundle, and package an installer for this OS |
| `npm run build:dir` | Bundle and produce an unpacked app in `release/` |
| `npm run typecheck` | Type-check main and renderer without emitting |
| `npm run rebuild` | Rebuild native deps against Electron (if `better-sqlite3` errors) |

## How it's put together

```
bettracker/
├── electron.vite.config.ts     # main / preload / renderer build config
├── electron-builder.yml        # packaging targets and options
├── build/                      # installer resources (app icon)
└── src/
    ├── main/                   # Electron main process
    │   ├── index.ts            #   window + app lifecycle
    │   ├── db.ts               #   better-sqlite3: schema, upsert, validation
    │   ├── csv.ts              #   CSV serialization
    │   └── ipc.ts              #   IPC handlers (get/upsert/delete/export)
    ├── preload/index.ts        # contextBridge — the only main↔renderer surface
    ├── shared/types.ts         # types + IPC channel names shared both ways
    └── renderer/               # React UI
        └── src/
            ├── App.tsx
            ├── components/     # HeroStats, CalendarView, BalanceChart, …
            └── lib/            # date, money, and stats helpers
```

**Security.** The renderer runs sandboxed with context isolation on and Node
integration off. It never touches the database directly — it calls a small,
typed API exposed over `contextBridge`, and every write is validated in the main
process before it reaches SQLite.

**Where the data lives.** A single SQLite file, `bettracker.db`, in Electron's
per-user app-data directory (e.g. `%APPDATA%/BetTracker` on Windows,
`~/Library/Application Support/BetTracker` on macOS). It persists across restarts
and app updates. Use **Export CSV** to back it up or move it elsewhere.

## Data model

One table, one row per day:

| Column | Type | Notes |
|---|---|---|
| `date` | TEXT | `YYYY-MM-DD`, unique — enforces one entry per day |
| `amount` | REAL | net result; `> 0` win, `< 0` loss, `0` push |
| `note` | TEXT | optional, up to 500 chars |

Re-logging a date updates that day in place (upsert) rather than adding a
duplicate.
