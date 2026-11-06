# TripCode — engineering spec (v0.1 → v1.0)

Condensed from the product architecture doc (TripCode 產品架構書 v2.1). This file is the
source of truth for implementers. UI copy and user-facing messages are Traditional Chinese.

## What it is

An open-source, non-profit, local-first travel planner modeled on open-slide:

- A trip is a folder `trips/<id>/`. The itinerary is `trip.ts` (`export default defineTrip({...})`,
  types in `src/core/types.ts`). No server, no database, no accounts, no affiliate links, no hosted payments
  (an opt-in local purchase layer exists since v1.5: see "v1.5 — watch and buy").
- Claude Code (the user's own) authors and edits trips, guided by skills in `.claude/skills/`.
- A Vite dev server (`npm run dev`) renders trips: daily timeline + colored route map.
- A `tripcode` CLI (`cli/tripcode.ts`, run with plain `node` — Node ≥22.18 strips types) gives Claude
  Code tools: Google Places/Routes lookups, trip check, exports.
- git is the version system. Variants (方案 B) are sibling files `variant-b.ts`, not branches.

## Repository layout

```
profile.md                    personal preferences (cross-trip)
destinations/<country>.md     destination guide (regions, bases, transport, seasons) — sourced
styles/<id>.md                travel style (pace, walking limit, budget split)
trips/<id>/brief.md           per-trip brief from onboarding
trips/<id>/trip.ts            main plan (locked items + candidates)
trips/<id>/variant-b.ts       optional variant, same type
trips/<id>/inbox/NN.md        imported raw text (e.g. 小紅書 posts), one file per tile
trips/<id>/bookings.md        booking checklist (gitignored by default)
src/core/                     pure TS shared by viewer + CLI (no DOM, no Node APIs)
src/viewer/                   React viewer
vite-plugin-tripcode.ts       dev-server API used by the viewer to write files
vite.config.ts
cli/tripcode.ts               CLI entry
.claude/skills/<name>/SKILL.md
```

## Hard engineering rules

- Dependencies are fixed in package.json (react, react-dom, vite, typescript, @types/*). Do NOT add
  packages. Use standard web/Node APIs. Google Maps JS is loaded with a plain `<script>` tag.
- Every `.ts` import uses an explicit `.ts`/`.tsx` extension (Node type stripping requires it).
- Only erasable TypeScript (no enums, no namespaces, no parameter properties).
- Tests: `node:test` + `node:assert/strict`, files named `*.test.ts` next to the code. Run `npm test`.
- `npm run typecheck` must pass.
- `src/core/*` must stay pure: no `fs`, no `window`, no `fetch`. Inject I/O as parameters.

## src/core modules

| File | Exports | Notes |
| --- | --- | --- |
| `types.ts` | contract (exists) | Do not change shapes without the foreman's approval. |
| `time.ts` | `toMinutes('HH:MM')`, `fromMinutes(n)`, `weekday(date)` | small helpers |
| `check.ts` | `checkTrip(trip, opts?) => Issue[]` | see Check rules |
| `links.ts` | `dayMapsLinks(day, opts?) => string[]` | Google Maps dir URLs |
| `ics.ts` | `tripToIcs(trip) => string` | RFC 5545, TZID = trip.tz, CRLF line endings |
| `source-edit.ts` | `insertComment`, `setItemField`, `setCandidateStatus`, `findObjectById`, `removeItem`, `setLocked`, … | pure string → string edits of trip.ts source |

### Check rules (`checkTrip`)

`opts.hoursFor?: (item) => OpeningHours | undefined` supplies live hours (CLI fetches from Google);
otherwise `item.hours?.value` is used. Rules (code → level):

- `date-range` (error): a day's date is outside `trip.start..trip.end`, or days are not in ascending order.
- `time-order` (error): an item has `end` earlier than `start`.
- `overlap` (error): an item starts before the previous timed item on the same day ends.
- `closed` (error): a timed item falls on a weekday with no period or on a `closedDates` date.
- `outside-hours` (warn): an item's start..end is not inside an open period.
- `transit-gap` (warn): a transit item has `duration` and its start..end window is shorter than it.
- `arrival` (warn): the first non-flight item of a day starts earlier than (flight `end` + 60 min)
  when that day contains an arriving flight.
- `missing-source` (error): a `Sourced` value has an empty `source` or invalid `fetchedAt`.
- `duplicate-id` (error): two items/candidates share an id.
- `missing-transit` (warn): two consecutive located stops of a day (poi/meal/hotel with `loc`; flights and items without
  `loc` are skipped) have no `transit` item between them and the straight-line transit estimate
  (`estimateMinutes(a, b, 'transit')`, see `optimize.ts`) is longer than 20 minutes. Up to 30 km the message names both
  places and quotes the estimate labelled 「僅供參考」; beyond 30 km it states only the straight-line distance in km
  (the city-speed estimate would be an invented number for intercity trips). A pair is skipped when either stop, or any
  item between them, has `locked: true` (already booked, so the user knows how they get there); a locked item without
  `loc` that is not a hotel/flight/transit (a booked day tour) covers every later stop of that day. `itemId` = the second stop.
- `day-overload` (warn): between the first and the last timed item of a day, known stay time (start–end windows, merged
  when they overlap, or `poi.minutes`) plus travel between consecutive located stops is longer than the span from the
  first start to the last end. Travel is the sum of known `transit.duration` values when a transit item sits between two
  stops (a transit item without a duration adds nothing — no invented times), else the straight-line estimate. Days with
  fewer than two timed items are skipped; unknown stays count as 0, so the rule errs on the side of silence. No `itemId`.
Messages are Traditional Chinese, e.g. 「09:30 卡貝爾橋早於抵達後可行時間（08:05 抵達）」.

### Google Maps links (`dayMapsLinks`)

`https://www.google.com/maps/dir/?api=1&origin=…&destination=…&waypoints=a|b&travelmode=transit`.
Use `origin_place_id` / `destination_place_id` / `waypoint_place_ids` when placeId exists; label
params use the item title (URL-encoded) or `lat,lng`. Max 8 waypoints per URL — split longer days
into consecutive links (each link's origin = previous link's destination). Skip transit/free/meal
items without a location. `travelmode` defaults to `transit`, overridable via opts.

### Source edits (`source-edit.ts`)

The viewer may only make these edits, all scoped to the object literal whose first-level property
is `id: '<id>'` (single or double quotes). Brace matching must ignore braces inside strings,
template literals and comments.

- `insertComment(src, targetId, text, anchor = 'item')` → inserts a line
  `// @trip-comment(<anchor>): <text>` directly above the line that opens that object, with the
  same indentation. anchor ∈ item | gap | leg | day. For `day` the target is the day's date
  (`date: 'YYYY-MM-DD'`) instead of an id.
- `setItemField(src, itemId, field, value)` → replaces a first-level property value (string or
  number) inside the object; inserts the property after `id:` if missing. Allowed fields:
  title, start, end, flightNo, bookingRef, note. Any other field throws.
- `setCandidateStatus(src, candidateId, status, day?)` → sets `status`, and sets/removes `day`.
- Every edit returns the new source string and must leave all other bytes untouched.

## Dev-server API (`vite-plugin-tripcode.ts`)

All endpoints are POST JSON under `/__tripcode/`, implemented as Vite `configureServer` middleware.
They validate `tripId` against `^[a-z0-9-]+$` and only touch files inside `trips/<tripId>/`.

| Endpoint | Body | Effect |
| --- | --- | --- |
| `comment` | `{tripId, file?, targetId, anchor, text}` | `insertComment` on trip.ts (or `file`) |
| `item-field` | `{tripId, file?, itemId, field, value}` | `setItemField` |
| `candidate` | `{tripId, file?, candidateId, status, day?}` | `setCandidateStatus` |
| `inbox` | `{tripId, text}` | writes next `inbox/NN.md` (frontmatter `status: pending`, `createdAt`) |
| `current` | `{tripId, file?, day?, itemId?}` | writes `node_modules/.tripcode/current.json` (`{tripId, file, day, itemId, updatedAt}`, `day` 1-based, optional) for the `current-trip` skill |

Requests are rejected (403/415) unless Host is localhost/`*.localhost`/an IP (or in `server.allowedHosts`), any
`Origin` matches Host, `Sec-Fetch-Site` is not cross-site, and `Content-Type` is `application/json`. `item-field`
accepts `start`/`end` only as `HH:MM`; `inbox` requires `trips/<tripId>/` to exist; bodies are capped at 1 MB.

Responses: `{ok: true}` or `{ok: false, error}` with HTTP 400. Trip files are loaded by the viewer
via `import.meta.glob('/trips/*/*.ts')` and `import.meta.glob('/trips/*/inbox/*.md', {query: '?raw'})`
so file changes trigger HMR / reload.

## Viewer (`src/viewer/`)

Layout (desktop first, works at 1280px; collapses sensibly at narrow widths):

```
┌ trip picker · day tabs (Day 1 … N, All) · variant switch ─────────────────────┐
├ 已確定資訊欄: locked items (flights, hotels…) as editable inputs; check result ┤
├ 匯入欄 (left) ─┬ 地圖 (center) ──────────────────┬ 時間軸側欄 (right, collapsible) ┤
│ paste textarea │ day-colored numbered pins +      │ visual bars (POIs colored,     │
│ tiles; click → │ polyline; candidate pins:        │ transit thin gray) + text list │
│ expand raw     │ unconfirmed=dashed ring "?",     │ "09:30 卡貝爾橋"; click syncs  │
│ text           │ discuss=solid other color "…",   │ with map highlight             │
│                │ accepted=solid "✓", rejected=    │                                │
│                │ faded. Click pin → detail panel  │                                │
│                │ with actions + 留言 box          │                                │
└────────────────┴──────────────────────────────────┴────────────────────────────────┘
```

- Map: if `import.meta.env.VITE_GOOGLE_MAPS_API_KEY` is set, load Maps JavaScript API via script tag
  and draw markers/polylines; otherwise render an offline SVG map (equirectangular projection of
  all `loc`s, fitted to bounds) with the same pin semantics. Items without `loc` are listed but not drawn.
- Selected item/candidate is shared state: map, timeline and detail panel highlight together, and the
  viewer POSTs `current`.
- Editing a locked-item field POSTs `item-field`; after the file reloads, `checkTrip` runs in the
  browser and the 已確定資訊欄 shows issues (green 「行程健檢通過」 when none).
- Comments: detail panel has a textarea → POST `comment` (anchor item). Timeline gaps between items
  can be clicked to comment with anchor `gap` (targetId = the following item id).
- Candidate actions: 加入第 N 天 (accepted + day), 待討論, 不去, 恢復 (back to unconfirmed).
- Inbox tile shows first ~14 chars, status (等 Claude 解析 / N 個地點未確認 / 找不到地點), click to expand.
- Day colors: a fixed 8-color palette; all colors via CSS variables; light and dark mode.
- Accessibility basics: buttons are buttons, focus visible, labels on inputs.

## CLI (`cli/tripcode.ts`)

`node --env-file-if-exists=.env cli/tripcode.ts <command>`; `npm run tripcode -- <command>`.
Output is JSON on stdout (so Claude can parse it) unless `--pretty`. Errors → stderr + exit 1.

| Command | What |
| --- | --- |
| `places search "<query>" [--near lat,lng] [--lang zh-TW] [--provider google\|osm]` | Default provider: `google` when `GOOGLE_MAPS_API_KEY` is set, else `osm`. Google: Places API (New) `places:searchText`, `source:'google-places'`. OSM: Nominatim `/search?format=jsonv2&limit=5` (+ `viewbox` bias around `--near`), `source:'openstreetmap-nominatim'`, `placeId` = `osm:<node\|way\|relation>/<id>`. Both return `{source, fetchedAt, results:[{placeId, name, address, loc, rating?}]}` |
| `places details <placeId>` | Google id: `GET /v1/places/{id}`, hours as `OpeningHours` + `businessStatus` (`confidence:'live'`). `osm:` id: Nominatim `/lookup?osm_ids=N123&extratags=1`; `opening_hours` is parsed only for simple forms (`24/7`, `Mo-Fr 09:00-17:00; Sa 10:00-14:00`), otherwise `hours: null` and the raw string in `hoursRaw`; `confidence:'reference'` |
| `routes <from> <to> [--mode transit\|walk\|drive] [--depart ISO]` | With a key: Routes API `computeRoutes`; from/to are `place_id:XXX` or `lat,lng`; returns minutes + distance + steps summary. Without a key: straight-line estimate (`estimateMinutes`/`haversineKm`), `source:'haversine-estimate'`, `confidence:'reference'`, `estimate:true`, plus a `note` that real transit times need a Google key or the official timetable; only `lat,lng` accepted; no other routing service is called |
| `check <tripId> [--file variant-b.ts] [--live]` | imports the trip module, runs `checkTrip`; `--live` fetches hours for items with placeId; prints issues; exit 1 on errors |
| `export ics <tripId>` | writes `trips/<id>/export/trip.ics` |
| `export links <tripId>` | writes `trips/<id>/export/links.md` (per-day Google Maps links) |
| `export kml <tripId> [--file x.ts]` | writes `trips/<id>/export/trip.kml` (KML 2.2: one Folder per day with placemarks + route LineString, a 「候選景點」 Folder) |
| `optimize <tripId> --day N [--file x.ts] [--mode transit\|walk\|drive] [--offline] [--keep id,id] [--start HH:MM]` | proposes a shorter visiting order for one day; **read-only** (prints JSON: `order`, `before`, `after`, `moves`, `source`, `confidence`; `--pretty` for a human view). Online uses Routes `computeRouteMatrix`; `--offline` or no key uses a haversine estimate (walk 4.5 / transit 25 / drive 40 km/h + 5 min), labelled `confidence: 'reference'`. Locked stops stay in place; items with both `start` and `end` are time windows. Claude applies the proposal via `trip-authoring` |
| `list` | lists trips with title and dates |

Google calls use `fetch` with header `X-Goog-Api-Key` (from `GOOGLE_MAPS_API_KEY`) and an explicit
`X-Goog-FieldMask`. A missing key is not an error: the CLI prints a Traditional Chinese note on stderr saying
which provider it uses (`--provider google` without a key is the only error). Nominatim calls follow the
[usage policy](https://operations.osmfoundation.org/policies/nominatim/): User-Agent
`TripCode/<package.json version> (open-source travel planner; local CLI)`, at most one request per second
(in-process throttle), single user-initiated lookups only (no bulk or scheduled use). OSM data is
© OpenStreetMap contributors (ODbL). Network, clock and sleep are injected so tests never touch the network.

`osm:` ids are **not** Google place ids. `Item.placeId` is sent to Google by `dayMapsLinks` as
`origin_place_id` etc., so trip files should not store `osm:` ids in `placeId` (keep `loc`; cite the source in
`note`). The CLI itself ignores `osm:` ids for `check --live` and `optimize`.

## Skills (`.claude/skills/<name>/SKILL.md`)

Frontmatter `name` + `description` (description states when to trigger). Body in English for the
model, with Traditional Chinese examples of user phrasing. Skills:

| Skill | Version | Purpose |
| --- | --- | --- |
| `onboard-trip` | v0.1 | 5-step onboarding → `brief.md` (+ `profile.md` on first use); ≤5 questions per round; skip/defaults; ask familiarity first |
| `create-trip` | v0.1 | from brief → 2–3 skeleton plans (bases, moves, hotel changes) → user picks → write trip.ts via CLI lookups |
| `trip-authoring` | v0.1 | file contract, planning rules, self-check, "numbers need sources", run `npm run check` after edits |
| `apply-comments` | v0.2 | process `@trip-comment` markers, minimal diffs, remove markers |
| `current-trip` | v0.2 | read `node_modules/.tripcode/current.json` for "這一天/這個景點" |
| `import-inbox` | v0.2 | parse inbox tiles → candidates (dedupe, sources, 找不到地點) |
| `find-prices` | v0.2 | official site first, then 2–3 resellers; total price; sources + time; never "全網最低" |
| `create-destination` | v0.2 | write `destinations/<country>.md` with sources |

## Milestones

- **v0.1** — types, core (time/check/links/ics/source-edit), viewer (timeline, map, facts bar,
  timeline sidebar, inbox UI, candidate pins, comments), dev-server API, CLI (places, routes, check,
  export, list), skills v0.1, sample Switzerland trip, README.
- **v0.2** — `optimize`, variant side-by-side compare, apply-comments/current-trip/import-inbox/
  find-prices/create-destination skills, PDF (print stylesheet), KML export, PWA offline.
- **v1.0** — `npx create-tripcode`-style init script, docs, contribution guide, example trips, polish.


## v1.1 — home page, manual places, tickets, Notion (foreman spec, 2026-10-16)

**Contract additions** (`src/core/types.ts`): `Attachment {file, label, kind?}` and `ItemBase.attachments?: Attachment[]`.
Ticket files live in `trips/<id>/tickets/` (gitignored). `Candidate.sources` may contain `'manual'`.

**Dev-server endpoints (new)**, same guard/validation rules as the others:

| Endpoint | Body | Effect / response |
| --- | --- | --- |
| `search` | `{q, near?: {lat,lng}, lang?}` | Proxies to the CLI's OpenStreetMap Nominatim provider (same UA + 1 req/s throttle; Google when a key is set). Read-only. Returns `{ok, source, fetchedAt, results:[{name, address, loc, placeId?}]}` |
| `add-candidate` | `{tripId, file?, title, loc, placeId?, day?}` | Appends a Candidate to `candidates` (id = kebab-case slug of title, de-duplicated), `status: day ? 'accepted' : 'unconfirmed'`, `sources: ['manual']`. Uses a new pure `insertCandidate(src, candidate)` in `src/core/source-edit.ts`. |
| `attach` | `{tripId, file?, itemId, label, kind?, filename, dataBase64}` | Writes the file to `trips/<id>/tickets/<safe-name>` (≤ 15 MB, pdf/png/jpg/jpeg/webp/heic/pkpass only) and appends an Attachment to the item via a new pure `addAttachment(src, itemId, attachment)`. |
| `detach` | `{tripId, file?, itemId, attachmentFile}` | Removes the Attachment entry (`removeAttachment`) and deletes the file. |
| `new-trip` | `{tripId, title, start, end, tz, adults?, childrenAges?}` | Reuses `cli/commands/new-trip.ts` rendering/validation; creates the trip folder. |

The viewer reads ticket files through Vite (`/trips/<id>/tickets/...`) to preview/open them.

**Notion sync**: `tripcode export notion <tripId> [--file x.ts] [--parent <pageId>]`.
Env: `NOTION_TOKEN` (internal integration secret), `NOTION_PARENT_PAGE_ID` (a page shared with the integration).
Creates one page per trip under the parent (title = trip title), then idempotently rewrites its content:
a summary block (dates, party, check status, generated-at), then per day a heading
「Day N · MM/DD（週） 標題」 followed by items as bulleted rows 「09:30 卡貝爾橋」 with note, Google Maps link
(dayMapsLinks / search link) and attachments uploaded with the Notion File Upload API and shown as file blocks
under the item. Candidates are listed at the end. Page id + uploaded file hashes are stored in
`trips/<id>/.notion.json` (gitignored) so re-syncs update the same page and skip unchanged files.
Notion API version and endpoints must be verified against the official docs at implementation time; use plain
fetch with injected fetch for tests. Never print the token.


## v1.2 — reorder and schedule (2026-10-16)

**Pure edits** (`src/core/source-edit.ts`, string → string, byte-preserving outside the moved block): `moveItem(src, itemId, toDate, beforeItemId?)`,
`insertItem(src, toDate, item | literal, beforeItemId?)`, `scheduleCandidate(src, candidateId, toDate, beforeItemId?)`. `// @trip-comment` lines directly
above an object travel with it; the block is re-indented to its new position; trailing-comma style of the target array is kept. Items must sit on their own
lines. A move to the position the item already has returns the source unchanged.

**Dev-server endpoints**, same guards, validation and 1 MB limit as above. `toDate` must be a `date` of the trip; `beforeItemId` (optional/null = end of day)
must be an item of that day and not the moved item. Errors are HTTP 400 `{ok:false, error}` and nothing is written.

| Endpoint | Body | Response |
| --- | --- | --- |
| `move-item` | `{tripId, file?, itemId, toDate, beforeItemId?}` | `{ok, itemId, toDate}` |
| `schedule-candidate` | `{tripId, file?, candidateId, toDate, beforeItemId?}` | `{ok, id, toDate}` — candidate is removed from `candidates` and becomes a `poi` item with the same id (title / placeId / loc copied, `why` → `note`) |
| `add-candidate` (changed) | `{tripId, file?, title, loc, placeId?, day?}` | without `day`: unchanged, plus `scheduled: false`. With `day` (1-based): inserts a time-less `poi` (`loc` + `fetchedAt`) at the **end of that day**, responds `{ok, id, item, scheduled: true}`; no candidate is created |


## v1.3 — remove, lock, optimize (2026-10-17)

**Pure edits** (`src/core/source-edit.ts`): `removeItem(src, itemId)` deletes the item's object together with the
`// @trip-comment` lines directly above it and keeps the array's comma style (last element without trailing comma, only
element → `items: []`); `setLocked(src, itemId, locked)` inserts `locked: true` after `id:` when missing and removes the
property entirely for `false` (a no-op when nothing changes). Both throw for unknown ids and for candidate ids.

**Dev-server endpoints**, same guards, validation and 1 MB limit as above. Errors are HTTP 400 `{ok:false, error}` and nothing is written.

| Endpoint | Body | Response |
| --- | --- | --- |
| `remove-item` | `{tripId, file?, itemId}` | `{ok: true, itemId}` |
| `set-locked` | `{tripId, file?, itemId, locked: boolean}` | `{ok: true, itemId, locked}` |
| `optimize` | `{tripId, file?, day, mode?}` (`day` 1-based; `mode` transit \| walk \| drive, default transit) | `{ok: true, currentMinutes, bestMinutes, savedMinutes, order: string[], source, confidence, changed, moves, notes}` |

`optimize` is **read-only** (the trip file is never written). It wraps `routableStops` / `optimizeDay` and the CLI's
`buildMatrix` (`cli/commands/optimize.ts`): `source` is `'google-routes'` (`confidence: 'live'`) when `GOOGLE_MAPS_API_KEY`
is set and the Routes call succeeds, otherwise `'haversine-estimate'` (`confidence: 'reference'`) — the UI must label that
as a reference value. A failing Google call falls back to the estimate and says so in `notes`. `order` lists the ids of the
day's routable stops (locked stops keep their slot); a day with fewer than two routable stops returns zero minutes and
`changed: false`.

## v1.4 — undo / redo and edit in place (2026-10-31)

**History** (`src/core/history.ts`, pure and in-memory; one `EditHistory` per dev server). `handleTripcodeRequest` wraps
every trip-file edit endpoint (`comment`, `item-field`, `candidate`, `add-candidate`, `move-item`, `schedule-candidate`,
`remove-item`, `set-locked`): it reads the file, runs the edit, and when the text changed records `{label, before, after, itemId}`
(max 50 per file; a new edit clears redo). Successful edits respond with `history: {undo, redo, undoLabel?, redoLabel?, undoItemId?, redoItemId?}`.

| Endpoint | Body | Response |
| --- | --- | --- |
| `undo` / `redo` | `{tripId, file?}` | `{ok: true, label, itemId?, history}`; HTTP 409 `{ok: false, error, history}` when there is nothing to do or the file changed since the edit |
| `history` | `{tripId, file?}` | `{ok: true, history}` |

An undo / redo is applied only when the file still equals the text that edit produced (`after` for undo, `before` for redo).
Otherwise nothing is written, both stacks for that file are dropped and the error says the file was changed elsewhere, so
an edit by Claude or an editor is never overwritten. Without a `history` dep (unit tests) the three endpoints answer 400.
Uploads, inbox pastes and new trips are not undoable.

**Viewer.** Double-click (or F2 on the focused row) edits a non-transit item's name; double-click its time edits `start`
(`InlineEdit.tsx`, `inline-edit.ts`: `930` → `09:30`, titles one line ≤ 120). Both go through `item-field`. The header has
undo / redo buttons; Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl+Y work outside text fields, and each step reselects the item it touched.

## v1.4 — AI 助手 panel (2026-10-31)

An in-viewer chat with Claude Code, modeled on open-slide's agent panel: the viewer sends the user's words plus what is on
screen, Claude Code edits `trips/<id>/` through the project's skills, and the dev server hot-reloads the result.
**Dev server only**: `import.meta.env.DEV` gates the button, and `vite build` output has no `/__agent`. Opt out with
`TRIPCODE_AGENT=0`.

**Server** (`src/agent/`, mounted at `/__agent` by `vite-plugin-tripcode.ts`, loaded on first request):

| File | Role |
| --- | --- |
| `types.ts` | Session / item / event types shared with the viewer |
| `store.ts` | Sessions in memory, persisted to `node_modules/.tripcode/agent-sessions.json` (30 sessions × 400 items); every change is an event |
| `runner.ts` | One turn per session: events → store, parks questions and permission requests, stop, edit-and-resend (rewinds the provider to a checkpoint) |
| `claude.ts` | Provider: imports `@anthropic-ai/claude-agent-sdk` **from the workspace at run time**, maps its message stream, `canUseTool` |
| `prompt.ts` | System-prompt addendum + the viewer cursor (`<tripcode-context>`: trip file, day, item) appended to each message |
| `install.ts` | `npm install --save-dev --save-exact` of the newest stable version published ≥ 7 days ago |
| `routes.ts` | HTTP: `GET /status`, `GET /events` (SSE), `POST /install`, `GET\|POST /sessions`, `GET\|DELETE /sessions/:id`, `POST /sessions/:id/messages\|stop\|respond` |

**Safety.** Only loopback sockets are served (everything else gets `enabled: false`). Every route also passes
`guardRequest` (allowed Host, same-origin `Origin`, no cross-site `Sec-Fetch-Site`; every POST must be
`application/json`). The agent may edit under `trips/` and `destinations/` without asking; every other tool call
(shell, web, edits elsewhere) becomes a permission card the user must allow, unless 「自動允許」 is on. Trip titles and
item ids are escaped before they enter the prompt.

**Viewer** (`src/viewer/agent/`, `styles/agent.css`): `agent-store.ts` mirrors the server session through the event
stream; `AgentPanel.tsx` has a connect view (SDK not installed), history, transcript (streamed Markdown, tool rows,
permission and question cards, edit-and-resend) and a composer (model, effort, auto-allow). On desktop it takes the
detail card's slot (the card hides while it is open); on mobile it is a full-screen sheet.

## v1.6 — 訂票清單, meal gaps, 出發準備度 (2026-11-04)

Direction change from the v1.5 review (2026-11): the office page is where the
planned trip turns into purchases the user makes themselves, and the buying robot becomes an advanced section. M1 of the plan:

| Piece | Where |
| --- | --- |
| `Booking` on items (need, status, official page, purchase page, sellers, sale date or rule, deadline, cancellation, conflict; facts are `Sourced`) | `src/core/types.ts`; the health check requires a source for each (`check.ts`) |
| `deriveBookingTodos(trip, now)`: rows from the item's own `booking`, then `locked` + voucher, then kind (flight, hotel, long or locked intercity transit), then note keywords; every row has `reason`, keyword guesses are only `recommended`; mixed notes (「免預約」 and 「要預約」) are listed with the doubt written out; past dates are dropped; nights with no lodging are merged into one row | `src/core/bookings.ts` |
| Links per row: official first (a checked purchase page, or the home page, or a labelled search), then Klook and Trip.com (a product page only when `sellers` has one, otherwise a plain Google search with `site:`); `cleanBookingUrl` drops tracking and affiliate parameters and refuses non-https; resellers can never fill the official slot | same |
| `findMealGaps(trip)`: lunch and dinner slots that are missing or only a placeholder, the stops before and after (by time, or by order when the day has no times), a locked evening event moving dinner earlier, the hotel as a third anchor; `parseMapsLink` reads a pasted Google Maps place link (short links are refused with a hint) | `src/core/meals.ts` |
| `readiness(trip, {now, brief})`: empty trip or day, unfilled brief, unbought required tickets, sale dates and deadlines, nights without a bed, keyword guesses merged into one line, stale booking facts, meal gaps, missing coordinates, unchecked transit, old coordinates. Warnings or notes only | `src/core/readiness.ts`; CLI `tripcode ready <id>` and `tripcode bookings <id>` |
| `setBooking` / `setItemLoc`: minimal edits that touch only the asked `booking` fields (round-trips byte for byte) | `src/core/source-edit.ts` |
| `POST /__tripcode/booking` (booked / not-needed / todo; booked also locks, stamps `bookedAt`, `boughtVia`, optional times; one undo step; settles a matching proposed purchase intent) and `POST /__tripcode/meal` (fills a placeholder meal or inserts a meal at the chosen place) | `vite-plugin-tripcode.ts` |
| `POST /__tripcode/cover` `{tripId, dataBase64}` stores the home-page cover photo as `trips/<id>/cover.jpg` (JPEG only, checked by its first bytes, at most 700 KB; the viewer shrinks any picture to about 1200 px first; never creates a trip folder; not part of undo), `POST /__tripcode/cover-remove` `{tripId}` deletes it. The booking page groups cards by `Day.city`, else by the hotel you sleep in | `vite-plugin-tripcode.ts`, `src/viewer/cover.ts`, `src/viewer/office/booking-model.ts` |
| `POST /__tripcode/idea-new` `{tripId}` creates `trips/<id>/idea.json` (refuses an existing folder) → `{ok, tripId, idea, next}`; `POST /__tripcode/idea` `{tripId, op}` with `op` = `answer` `{field, value}` (`value: null` skips) \| `choose` `{placeId}` \| `reject` `{placeId}` \| `reject-round` \| `dates` `{start, end}` → `{ok, idea, next}` (never creates a folder; the page never writes places, the AI does that through `tripcode idea places`); `POST /__tripcode/idea-finish` `{tripId, title?, tz?, adults?, childrenAges?}` creates `trips/<newId>/` (trip.ts, brief.md prefilled from the answers, inbox/), moves idea.json in and removes the old folder when nothing else is in it → `{ok, tripId: newId, files}`. Plain file operations, not part of undo. `tripcode idea <new\|show\|answer\|places\|choose\|reject\|reject-round\|dates\|finish>` does the same from the CLI; all of it goes through the pure `src/core/idea.ts` (parse, validate, `nextStep`). See `docs/FIND-DESTINATION.md` | `vite-plugin-tripcode.ts`, `cli/commands/idea.ts`, `src/core/idea.ts`, `.claude/skills/find-destination/SKILL.md` |
| The page `#/trip/<id>/office` (button 「訂票清單」): 出發準備 card, 訂票清單 (grouped by urgency, three link buttons per row, 「我買好了」 with where it was bought), 吃飯空檔 (anchor choice, Maps search link, paste the chosen place back), the AI panel docked; a collapsed 「盯價與開賣提醒」 section lists the watches and their alerts | `src/viewer/office/` |
| Skills: `booking-checklist`, `review-trip`, `fill-meals`; the agent prompt now defaults to review and fill, not to buying | `.claude/skills/`, `src/agent/prompt.ts` |
| **The planning protocol (v1)**: five fixed steps (盤點, 排行程, 審稿, 訂票, 出發前) whose status is computed from the files, never declared (`planStages`: a step is done only when every step before it is done and its own condition holds), shown by `tripcode ready` and as a stepper on the office page; plus the fixed rules (priority order, source order, decision card, one reply shape) in the `plan-trip` skill | `src/core/plan.ts`, `.claude/skills/plan-trip/SKILL.md` |
| Day-structure rules as notes in `readiness`, judged by distance and time rather than counts: `walking-heavy` (estimated walk = straight-line distance between consecutive located stops × 1.3, against the limit in profile.md or 8 km; legs over 3 km are not counted as walking), `day-time-tight` (daylight left after flights, fixed trains, transit and walking, per stop, under 50 min), `no-easy-day` (5 days at 75% of the limit), plus `booking-link-missing`; thresholds in `PLAN_RULES`; the model in `src/core/load.ts`; every estimate lists what it could not see; the user can accept a note for a day (`Day.accepted`) | `src/core/readiness.ts`, `src/core/load.ts` |

**The paying layer was taken out (2026-11-04, maintainer's decision).** No `buy pay`, no `buy vault`, no card, no autopilot, no purchase intents, no ledger, no staff animation:
TripCode organises the booking list and the official links, and the user buys on the seller's own page. A full copy of the removed code is kept by the maintainer outside the repo. What stays from v1.5 is not payment: `buy watch` / `buy scan` /
`buy alerts` (sale-date reminders and price watches, `--render` for JavaScript pages) and `buy browser` (reading pages in TripCode's own Chrome, used by `booking-checklist`).

Not in M1 (see the plan): ranking restaurants with Google Places data (M2, needs a key), taste accumulation, Notion import.

## v1.5 — watch and buy (2026-11-03; the payment part was removed 2026-11-04)

What v1.5 built and what is left of it:

| Stays (`src/purchase/`, `cli/commands/buy.ts`) | Removed (archived outside the repo) |
| --- | --- |
| `price.ts` (price only from JSON-LD, meta, itemprop or the user's regex: never guessed from loose text), `scan.ts` (https only, no private hosts, 60-minute minimum, alerts for target price, drop, sale opening), `store.ts` (`trips/<id>/purchase/{watches,samples,alerts}.json`, gitignored) | `vault.ts`, `prompt.ts`, `policy.ts`, `checkout.ts`, `pay.ts`: the card vault, passphrase prompt, spending policy and page-total check, card typing, payment |
| `cdp.ts` + `browse.ts` (TripCode's own Chrome over the DevTools Protocol: open, read, links, click, type, press, screenshot, `renderPage` for watches with `render`) | `buy vault|pay|intent|ledger`, purchase intents, the autopilot key, the `buy-tickets` skill |
| `activity.ts` (short sentences in `~/.tripcode/activity.jsonl`), `office.ts` / `routes.ts` (`/__buy`: watches, alerts, scan now, ack) | the four-staff office animation, the board, the vault setup guide, the agent panel's `buy pay` refusals |

Why it was removed: the review found it was never verified on a real merchant and the idea runs into 3-D Secure, logins and bot detection; the AI's
value here is organising what to book, not paying.
