---
name: create-trip
description: Turn a finished `brief.md` into a real `trips/<id>/trip.ts` in TripCode, using layered recommendation (skeleton plans, then daily themes, then places). Use when the user says "幫我排行程", "開始規劃", "出幾個方案", "從簡報產生行程", "create the itinerary", or after `onboard-trip` finishes. Do NOT use before a brief exists; run `onboard-trip` first.
---

# Create a trip from a brief

> Step 2 (排行程) of the `plan-trip` protocol. Done when every upcoming day has something planned; check with `npm run tripcode -- ready <tripId> --pretty`. Obey the protocol's day rules and priority order.

Read first: `trips/<id>/brief.md`, `profile.md`, `styles/<style>.md`, `destinations/<country>.md` if it exists, and the `trip-authoring` skill (file contract and planning rules). If `destinations/<country>.md` does not exist, offer `create-destination` and continue without it, clearly labelling what you could not verify.

The plan is built in **three layers**. Do not jump to a full itinerary: the user must be able to say "no" cheaply at each layer, and the first layer is where the biggest decisions live.

Facts come from tools, never from memory:

```bash
npm run tripcode -- places search "Kapellbrücke, Luzern" --near 47.05,8.31 --lang zh-TW
npm run tripcode -- places details <placeId>
npm run tripcode -- routes place_id:AAA place_id:BBB --mode transit --depart 2027-06-13T09:00:00+02:00
npm run tripcode -- optimize <tripId> --day N      # prints an order proposal for one day; never edits files
npm run tripcode -- export ics|links|kml <tripId>  # writes trips/<id>/export/ (gitignored)
npm run tripcode -- list --pretty
```

Output is JSON (add `--pretty` for humans). What you use from it:

- `places search` → `{ source, fetchedAt, results: [ { placeId, name, address, loc: { lat, lng, fetchedAt }, rating? } ] }`. Provider is automatic: Google when `GOOGLE_MAPS_API_KEY` is set, otherwise keyless OpenStreetMap (`source: 'openstreetmap-nominatim'`, `placeId` like `osm:way/123`; force with `--provider google|osm`). Copy `loc` into the item. Copy `placeId` only when it is a Google id: `osm:` ids are not Google place ids and Google Maps links would break, so omit `placeId` for OSM results. `--near` only biases ranking (about 5 km); put the city in the query. Empty `results` → do not guess.
- `places details` → same fields plus `businessStatus` and, when Google has them, `hours`, already a `Sourced<OpeningHours>` (`confidence: 'live'`). For `osm:` ids, `hours` is `confidence: 'reference'` and only filled for simple opening_hours; otherwise `hours` is `null` and the raw string is in `hoursRaw` (read it yourself, never convert it by guess).
- `routes` → `{ minutes, distanceMeters, steps, duration, source, fetchedAt }`. `duration` is a ready-to-paste `Sourced<number>` for a transit item (minutes, rounded up) when it comes from Google. Without a key the output is a straight-line estimate (`source: 'haversine-estimate'`, `estimate: true`): use it only to judge feasibility, never paste it as a transit `duration`. `--depart` is read as an ISO time; include the destination's UTC offset (it is not interpreted in the trip's `tz`). Modes: `transit` (default), `walk`, `drive`; `from`/`to` are `place_id:XXX` or `lat,lng`.
- `optimize <tripId> --day N` → `{ current, order, before, after, savedMinutes, moves, changed, source, confidence, estimate, … }`: a proposed order of that day's located stops (locked stops keep their slot). It never changes files: you decide, apply it as a minimal edit (ids stay, locked items stay, times re-set, transit items from `routes`), then run `check`. Without an API key it estimates from straight-line distance (`estimate: true`); use it to pick an order, never as a `duration`. Optional flags: `--mode`, `--keep id,id`, `--start HH:MM`, `--file`, `--offline`. Quote its numbers only as printed.

No key is needed: without `GOOGLE_MAPS_API_KEY` the CLI says on stderr that it uses OpenStreetMap and straight-line estimates, and that is fine. Mention once that a Google key is an optional upgrade (better POI data, live hours, real transit routes; see `.env.example`). For hours, ticket prices or real transit times that the CLI cannot give, you may use web search/fetch to read the official site or timetable and cite the URL as `source` (confidence `reference`). Never fill a gap with a guess.

## Layer 1 — Skeleton plans (2–3, structurally different)

Show only **bases, moves and totals**, no POIs yet. Offer two or three plans that differ in *structure*, not in decoration. For example for 9 days in Switzerland: (A) 3 bases, one hotel change each 3 nights; (B) 2 bases with day trips; (C) one-way road trip. For each plan give:

- Base towns and nights per base (hotel changes = count).
- Main legs between bases, with **train/transit hours** and **estimated transport cost** *from tools or cited sources*. If you cannot source a number, write 「待查」 rather than an estimate.
- What it favors and what it gives up (tied to the brief: 「適合你說的『少換住宿』，代價是…」).
- Which locked items it respects (flights, booked hotels).

Present as a short comparison table in chat. Before showing it, create the **shell `trips/<id>/trip.ts`** if none exists by running `npm run new-trip -- <id> --title "<標題>" --start YYYY-MM-DD --end YYYY-MM-DD --tz <IANA> [--adults N] [--children 5,8] [--destination <id>] [--style <id>]` (it writes `trip.ts` with one empty `{ date, items: [] }` per day and `candidates: []`, plus `inbox/`, and refuses to overwrite; if `onboard-trip` already created the folder, write the shell by hand with the same shape). The viewer lists a trip only when `trip.ts` exists (and the 匯入欄 needs it), so tell the user they can open `npm run dev` and paste saved posts now. To show skeletons on the map, put plan A in `trip.ts` and plan B in `variant-b.ts` (the viewer has a file switcher), each with **days holding only hotel/transit/flight items**. Ask the user to pick one (or merge); when they choose, make `trip.ts` the chosen skeleton and delete `variant-b.ts` only if they agree. Do not continue until they choose; a one-line 「選 A，但第 5 天改住…」 counts.

## Layer 2 — Daily themes

For the chosen skeleton, propose one line per day: a **theme**, a rough weather need, and an effort level.

```text
第 3 天  琉森 → 少女峰區　主題：高山鐵道　weather: clear　強度：中
第 4 天  少女峰區　　　　　主題：湖光緩步　weather: any　 強度：低
```

- Mark scenery-dependent days `weather: 'clear'` and keep at least one `any` day to swap with. Say which days are swappable.
- Respect the pace and walking limit from the style/brief.
- Put an easy day after a long transfer day.

Wait for the user's reaction (they may swap or drop days). Then write the day skeleton into `trip.ts`: each day gets `date`, `title`, `weather`, and the locked items.

## Layer 3 — Places with reasons

Now fill each day with POIs and meals. **Every POI carries its reason**, in `note`, in this shape: why it is here / the tradeoff / the constraint.

```ts
note: '為什麼：湖畔步行最輕鬆的開場。取捨：下午人多。限制：行李先寄放飯店。',
```

Rules:

- Search each place with `places search`, copy `placeId` and `loc`; run `places details` for anything where the weekday matters. Leave `hours` out for Google places: `npm run check -- <id> --live` fetches live hours for every item with a Google `placeId` (it needs the API key; `osm:` ids are skipped). Plain `check` only validates hours that are written in the file.
- For consecutive stops that are not walkable, add a `transit` item with `mode`, a start/end window, and a Sourced `duration` from `routes`.
- Keep `items` in chronological order, each with `start` and `end` when known (the checker flags `overlap` against the previous timed item).
- Add lunch and dinner `meal` items near the route (a neighborhood or a named place the user can later swap), no invented prices.
- **Suggestions you did not schedule** go to `candidates` with `status: 'unconfirmed'`, `sources: ['claude']`, and a `why`. Also suggest candidates from the user's `inbox/` (see `import-inbox`). Keep candidates few and relevant; they appear on the map for the user to accept, discuss or reject.
- Do not stack scenery-dependent stops on a `weather: 'clear'` day unless that is the point of the day; give the day a plan B in `note` or as a candidate.
- Locked items stay exactly as the user gave them.

## Write and verify

1. Write/modify `trips/<id>/trip.ts` following `trip-authoring` (one item per object, stable kebab-case ids, Sourced numbers only). Use small steps: skeleton first, then each day, so diffs stay reviewable.
2. Run `npm run check -- <id>` after each write (add `--file variant-b.ts` for the variant). Fix errors. Run once with `--live` at the end if a Google key is set.
3. Tell the user (Traditional Chinese): the trip id, to run `npm run dev` (Vite prints the URL, normally `http://localhost:5173`), what is locked, what is unconfirmed, which numbers you could not source, and the next move: accept/discuss/reject candidates in the viewer (加入 sets `accepted` + a day; you then schedule it, see `trip-authoring`), leave comments (`apply-comments`), paste more posts into the 匯入欄 (`import-inbox`), `find-prices` for the booking checklist, or `export ics|links|kml`.

## Do not

- Produce a full itinerary before the skeleton is chosen.
- Offer skeleton plans that differ only in names of attractions.
- Quote travel times, fares, ticket prices or hours that did not come from a tool or a cited page.
- Book anything or give payment links. Finding the official purchase page and booking facts is `booking-checklist`; the user buys on the seller's page.
- Change locked items, or silently drop a must-do from the brief; if it does not fit, say so and offer options.
