---
name: current-trip
description: Resolve which trip, file, day and item the user is looking at in the TripCode viewer. Consult whenever the user says "這一天", "這個景點", "這個", "這裡", "我現在看的那天", "this day", "this stop", or any deictic reference to the plan without naming it. Re-read `node_modules/.tripcode/current.json` at the start of EVERY such turn; the user navigates between turns.
---

# Where is the user right now?

When the user says "把這天排鬆一點" or "這個景點換掉", they mean what is selected in the viewer. Before asking 「哪一天？」, read the cursor file the dev server writes.

## Re-read on every deictic turn

`current.json` is a live cursor, not a fact about the conversation. Read it **fresh at the start of every turn** that uses a deictic reference, even if you read it a minute ago or just edited that trip. A stale read edits the wrong day. If `tripId` / `day` / `itemId` differ from your last read, use the new values.

## The file

Path (from the project root): `node_modules/.tripcode/current.json`. The dev server writes it (`POST /__tripcode/current`) whenever the viewer's trip, file, day or selection changes.

```json
{
  "tripId": "switzerland-2027-06",
  "file": "trip.ts",
  "day": 2,
  "itemId": "kapellbruecke",
  "updatedAt": "2027-01-09T14:32:11.123Z"
}
```

- `tripId` — folder under `trips/`. Always present.
- `file` — the plan file being viewed: `trip.ts` or a variant such as `variant-b.ts`. Always present. **Edit this file**, not necessarily `trip.ts`.
- `day` — **1-based day number** (day 1 = `days[0]`; same numbering as a candidate's `day`). Absent when the viewer shows all days and nothing is selected. If an item is selected while all days are shown, `day` is the day that contains it.
- `itemId` — `id` of the selected item **or candidate**. Find it with `id: '<itemId>'`; it is a candidate if it sits in `candidates`. Absent when nothing is selected, and also when the user selected a gap or the whole-day comment box (those are not items).
- `updatedAt` — ISO time of the last change.

Treat any missing field as "not selected".

## Using it

- 「這一天 / 這天」 → `days[day - 1]` of `trips/<tripId>/<file>`. No `day` → ask which day.
- 「這個景點 / 這個 / 這裡」 → `itemId`. No `itemId` → ask.
- 「這個行程 / 整趟」 → the whole `tripId` / `file`.
- Then read `trip-authoring` and edit with a minimal diff.

## Sanity checks

- Open the file and confirm `days[day - 1]` and `itemId` exist. If not, the cursor is stale: ignore it and ask.
- The file is only rewritten when the user navigates, so an old `updatedAt` can still be right if they have been sitting on that day. If it is hours old, from an earlier work session, or the request does not fit the selection (user says 「早餐」, selection is a museum), confirm in one line first (「你現在是在看第 2 天的卡貝爾橋嗎？」).
- For big changes (rewriting a day, deleting items) always confirm the target in one line.
- If `updatedAt` is newer than your last read, the user moved: switch to the new values without asking.

## When the file is missing

The viewer has not been opened on a trip yet (or `node_modules` was cleaned). Do not create the file or guess. Ask which trip/day, or suggest `npm run dev` and clicking the day.

## Do not use when

- The user names the trip, day or place explicitly.
- A `@trip-comment` marker already points at the target (use `apply-comments`).
