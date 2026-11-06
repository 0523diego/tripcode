---
name: plan-trip
description: The fixed planning protocol of TripCode. Use first for any planning request - "幫我排行程", "接下來要做什麼", "我現在在哪一步", "這趟準備得怎麼樣", "plan my trip", "what's next" - and whenever you are unsure which skill to use. It says which of the five steps the trip is at (computed from the files, never guessed), which skill does that step, the rules every trip follows, and the one reply format. The same protocol runs for every trip so the quality does not depend on the day or on who asks.
---

# The TripCode planning protocol (v1)

Every trip goes through the same five steps (after step 0, finding a destination, for people who have none yet), in the same order, and answers in the same shape. What changes from trip to trip is the **content** (which places, what pace, which food), and that comes from the user, `profile.md` and `brief.md`, never from you. What is fixed is the **process, the formats, the checks and the source rules**. Fixed rules that can be checked by code are checked by code (`tripcode ready`, `check`); the rest are on this page, and you follow them every time.

## Step 0, every time: find out where the trip is

```bash
npm run tripcode -- ready <tripId> --pretty
```

It prints 「現在在第 N 步：…」, the five steps with ✓ for the ones that are done, and 「下一步」 with the skill to use. **You do not decide the step and you never declare one done:** a step is done only when every step before it is done and its own condition holds in the files. Do the current step. Do not jump ahead ("既然在盤點，順便把每天排好" is not allowed): a later step built on an unfinished one gets redone.

If the user asks for something outside the current step (「先幫我看看住宿」), do it, and say which step the trip is at afterwards.

## Step 0, before the five: 找方向

Someone who does not know where to go yet has no trip, only an idea: a folder `trips/<id>/` that contains `idea.json` and no `trip.ts` (the page `#/idea/<id>`). `tripcode ready` does not apply to it. Run `npm run tripcode -- idea show <id> --pretty` instead: it says which question comes next (computed from the file, like the steps below) and what to do. Use the `find-destination` skill, and change `idea.json` only with `tripcode idea …` commands. Step 0 is done when the trip is created (`next` is `done`, `trips/<newId>/` has `trip.ts` and a prefilled `brief.md`); the five steps start there.

## The five steps

| # | Step | Done when | Skill | You may write |
| --- | --- | --- | --- | --- |
| 0 | 找方向 | the user has a destination and dates and the trip is created (`idea show` says `done`) | `find-destination` | `idea.json`, only through `tripcode idea …` |
| 1 | 盤點 | the user told you what is booked, must-do, never, limits; `brief.md` has no 「（待填）」 | `onboard-trip` | `brief.md`, `profile.md` |
| 2 | 排行程 | every upcoming day has something planned **and every night has a lodging point** | `create-trip`, `import-inbox` | `trip.ts` |
| 3 | 審稿 | `check` is clean and no day is overloaded (see the day rules) | `review-trip` | nothing by default: report, then edit what the user picks |
| 4 | 訂票 | everything that must be reserved is bought or has an answer (a hotel that is only 「待選」 counts until it is booked and locked); every item has a confirmed official link or an explicit 「找不到」 | `booking-checklist` | `booking` fields (not `status`) |
| 5 | 出發前 | every meal has a place; no stale facts; coordinates and travel times verified | `fill-meals`, `find-prices` | `trip.ts` |

## Rules that hold in every step

**Order of priority when things conflict** (higher wins; say what you gave up):
1. `locked: true` items (booked or must-do). You never change them. If the plan conflicts, move the others or report it.
2. Timed reservations and sale dates.
3. Opening hours and closed days.
4. A sensible route (the next stop is near the last one).
5. Taste and nice-to-haves.
Never silently drop something the user said they must do: if it does not fit, say so and give two ways out.

**Lodging is the spine of every day.** Every night has a lodging point, because each day on the map and in the list starts and ends there (and the walking and time estimates use it as the two ends of the day). A hotel item sits on its check-in day with `nights`. If the user has not decided yet, still put a hotel item there (title 「住宿（待選）」, not `locked`): the day then has a start and an end, and the booking list shows it as still to book. Never leave a night without one, and never plan a day before you know where it starts.

**Give every day a `city`** (`city: '米蘭'` on the `Day`). The booking page groups what to buy by city; a day without one is grouped under the hotel instead, which reads worse. A transit day (米蘭 → 羅馬) takes the city you sleep in that night.

**Order of sources** (a fact is only as good as its source): the operator's own page > an authorised ticket seller reached from that page > a reseller (Klook, Trip.com, KKday ...) > blogs and posts. For strikes, closures and schedule changes read local-language news. Every price, duration, opening hour and date is `Sourced` (`source`, `fetchedAt`, `confidence`). No source, no value: write 「查不到」. Read pages with `buy browser open <url>` and `buy browser text` (JavaScript runs there; a plain fetch sees an empty shell). Do not click consent walls for the user; do not log in.

**Day structure** (checked by `tripcode ready`; notes, not errors; the numbers live in `PLAN_RULES` in `src/core/readiness.ts`, the estimate in `src/core/load.ts`). A day is judged by **what it asks of the traveller, never by how many points it has**: two sights 200 m apart cost almost nothing, two at opposite ends of a city cost a lot.
- **Walking**: the straight-line distance between consecutive located stops (the stops' `loc`; no map service needed), times 1.3 for streets, against the user's daily limit (`profile.md`, default 8 km). Legs of more than 3 km are not counted as walking: transport is assumed, and if none is planned the page says so (`missing-transit`).
- **Time**: the daylight (08:30–21:30) minus flights (with an hour after landing), fixed train or bus times, known transit durations and the walking, divided by the sights and meals of the day. Under about 50 minutes each is rushed (`day-time-tight`). Stay times nobody wrote down are not guessed.
- **No easy day**: 5 days in a row that each use at least 75% of the walking limit.
- Fixed things this protocol also relies on: arrival buffer after a flight and overlaps (`check`), meals with a place or knowingly open (`meal-gap`), a booking answer for every sight that needs a ticket, lunch and dinner near the stop the user chooses; a locked evening event pulls dinner earlier.
- Every estimate says it is an estimate and what it could not see (no coordinates, a flight without times). Straight lines understate real routes: a sourced `duration` on a transit item (from `routes` with a Google key) replaces the estimate. If you can improve an estimate (add coordinates, add `start`/`end` to flights and trains), do that instead of arguing with the number.
- The user can answer a note with 「這天就這樣」 (the page writes `accepted: ['walking-heavy']` on that day in `trip.ts`). An accepted note is settled: do not raise it again for that day, and do not take the choice back. You may write `accepted` only when the user said so.

**Personalisation, every trip:** read `profile.md` and `brief.md` before you suggest anything; ask only what they do not answer; never ask twice. When the user rejects something, record why in one line (a comment on the candidate or a note in `brief.md`) so the next trip is better. Skipped questions get a default marked 「（預設）」.

**Booking links, every item:** three choices in the same order: official (a confirmed purchase page, else the official home page, else a plainly labelled search), Klook, Trip.com. Resellers are options, never "the official page"; no tracking or affiliate parameters; no ranking of sellers unless you compared the same conditions and say so.

**Nothing pays:** you never pay, never touch a card, never run anything that spends money. The user buys on the seller's page and presses 「我買好了」 on the 訂票清單 page.

## The decision card (anything the user must choose)

Up to **3 options**, each with the same lines so they compare at a glance: what it is, total price including taxes and fees (or 「查不到」), cancellation terms, what it gives up, source and when you read it. Then **your recommendation and one reason**. Never list more than 3. Never recommend without a reason.

## The reply (always this shape, Traditional Chinese, short)

1. **現在在第 N 步：…**（照 `ready` 的輸出）
2. **這次做了什麼**：最多 5 條，具體（地點、日期、檔案），不寫「優化了行程」。
3. **需要你決定**：最多 3 件；每件用上面的決定卡。沒有就省略這一段。
4. **我沒辦法確認的**：查不到、被擋住、來源互相矛盾的，一條一條列，不要藏。
5. **下一步**：只有一個。

## Before you say you are done (self-check)

- `npm run check -- <tripId>` has no errors, and you did not add a new 「未查證」 where you could have looked it up.
- `npm run tripcode -- ready <tripId> --pretty`: the step did not move backwards, and the number of open things in the current step went down.
- No fact without a source; no reseller in an official slot; no locked item touched; no `status: 'booked'` set by you.
- The reply has the five parts, no more than 5 / 3 / 3 items where limits apply.

## What this protocol does not fix

Which places, how fast, what to eat, what the trip is about. Do not impose a "standard itinerary": two trips planned with this protocol should look different and be equally sound.
