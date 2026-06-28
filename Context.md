# Project Context — Assignment Automator (NCPA Sound Crew)

A single orientation file for anyone (human or AI) picking up this codebase.
For user-facing feature docs see `README.md`; this file is the working context.

## What it is

A full-stack web app that automates **sound crew assignments** for NCPA
(National Centre for the Performing Arts) events. The operator uploads a monthly
events CSV, the rules engine proposes crew assignments balancing workload and
capabilities, the operator reviews/overrides, then exports back to the NCPA
scheduler format.

## Tech stack

- **Backend**: [Hono](https://hono.dev) (TypeScript), runs on Cloudflare Workers/Pages
- **Database**: Cloudflare D1 (SQLite) — binding `ncpa-crew-db`, env var `DB`
- **Frontend**: Vanilla JS + Tailwind CSS (both via CDN), no framework/build step for the UI
- **Build**: Vite (`@hono/vite-build`) → `dist/_worker.js`
- **Deploy**: Cloudflare Pages, project `crew-assignment`

## Code layout

Almost everything lives in one file — be aware before searching:

- `src/index.tsx` — **the whole app**: Hono routes (`/api/*`) *and* the entire
  frontend (HTML + embedded `<script>` JS) served from `app.get('/')`. ~3000+ lines.
- `src/renderer.tsx` — minimal JSX renderer wiring for Hono.
- `migrations/0001_initial_schema.sql` — D1 schema.
- `seed.sql` — initial 14-member crew roster + capability matrix (starting state only).
- `public/static/` — static assets.
- `sample_events*.csv` — example input files.
- `.github/workflows/deploy.yml` — deploys to Cloudflare Pages **on push to `main`** (no PR-level CI).

## Data model (D1)

- `crew` — roster + capability matrix. Columns: `name` (unique), `level`
  (`Senior|Mid|Junior|Hired`), `can_stage`, `stage_only_if_urgent`,
  `is_outside_crew`, `venue_capabilities` (JSON), `vertical_capabilities` (JSON),
  `special_notes`.
- `crew_unavailability` — day-offs (hard blocks), FK to `crew` (ON DELETE CASCADE).
- `events` — uploaded events (preserves original CSV fields + normalized venue/vertical).
- `assignments` — final crew→event assignments.
- `workload_history` — per-crew per-month assignment counts (for balancing).

Capability values: `Y*` = specialist (preferred by engine), `Y` = can do,
`N` = cannot (engine never assigns to those venues/verticals).

## User workflow (UI)

Header has a 5-step indicator plus a **Settings** button (top-right).

1. **Day-offs** — availability calendar grid (internal crew only; outside/hired excluded).
2. **Upload** — CSV parse + preview, venue/team normalization, manual-review flags.
3. **Crew Requirements** — set crew counts per event + FOH preferences.
4. **Review/Edit** — assignments table with manual override modal + conflict warnings.
5. **Export** — NCPA CSV / calendar / workload report.

**Settings modal** (added in the crew-settings iteration): add / edit / delete
crew and edit their capability matrix. Changes refresh the day-off calendar live.
Roster is now DB-backed, so `npm run db:seed` overwrites edits — only seed a
fresh DB.

## Assignment engine rules (high level)

- FOH: specialist rotation within verticals, capability matching.
- Stage: internal crew prioritized; Outside Crew (OC) must be paired with ≥1
  internal member; all-OC only when no internal crew is available.
- Day-offs are hard blocks (unavailable crew never assigned).
- Multi-day events: same crew throughout.
- Workload balancing within capability tiers.
- (Note: an earlier per-person monthly assignment cap was removed from `main`.)

## API endpoints

`GET/POST /api/crew`, `PUT/DELETE /api/crew/:id`,
`GET/POST/DELETE /api/unavailability` (+ `/bulk`),
`POST /api/events/upload`, `GET /api/events`, `PUT /api/events/:id`,
`POST /api/assignments/run`, `GET /api/assignments`, `PUT /api/assignments/:eventId`,
`GET /api/export/{csv,calendar,workload}`.

## Dev commands

```bash
npm install
npm run build              # vite build → dist/
npm run db:migrate:local   # apply migrations to local D1
npm run db:seed            # load initial roster (overwrites!)
npm run db:reset           # wipe local D1, migrate, seed
npm run dev:sandbox        # wrangler pages dev on :3000
npm run deploy             # build + deploy to Cloudflare Pages
```

## Date handling

CSV input/display/export use `dd-mm-yyyy`; internal storage is `yyyy-mm-dd`.

## Conventions

- Develop on a feature branch (e.g. `claude/<topic>`), never commit directly to `main`.
- Open PRs as **draft** first; squash/merge into `main` triggers the deploy workflow.
- Keep changes scoped to one iteration; don't fold in unrelated reworks.
- The roster/capability matrix is the source of truth in the DB, not in `seed.sql`,
  once the app has been used.
