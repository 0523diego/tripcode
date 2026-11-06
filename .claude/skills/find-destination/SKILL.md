---
name: find-destination
description: Step 0 (找方向) of TripCode - help someone who does not know where to go reach a destination and dates. Use when the user says "不知道去哪", "想出去玩但沒想法", "推薦我去哪", "幫我找個地方", "找方向", "where should I go", opens a new idea page (#/idea/<id>, a folder with only trips/<id>/idea.json), or a message arrives with that page as context. Ends when the trip is created; from then on the plan-trip protocol takes over. Not for comparing how to get there (that is a later step).
---

# Find a destination (step 0 of the TripCode protocol)

> Step 0 of `plan-trip`. A folder with only `idea.json` is at step 0. It is done when the trip exists (`next` is `done`); then `plan-trip` takes over at step 1 (盤點).

Goal: from 「想出去玩，不知道去哪」 to one destination and dates, with the fewest questions, and with ideas the user can see on the globe. The format is fixed; the ideas are yours.

| Fixed (code decides) | Free (you decide) |
| --- | --- |
| the question order, the shape of every answer and place, which card is next (`nextStep`, computed from the file) | which places to suggest, and why each fits this person |

Spec: `docs/FIND-DESTINATION.md`. The file is `trips/<id>/idea.json`; the page `#/idea/<id>` shows the same questions as cards and re-renders from the file.

## Step 0, every time

```bash
npm run tripcode -- idea show <id> --pretty
```

It prints the answers so far, the **next step** (`known`, `origin`, `focus`, `budget`, `scenery`, `when`, `days`, `party`, `suggest`, `choose`, `locate`, `dates`, `finish`, `done`), what to ask or do, and the places of the latest round. **You do not decide the step**: do exactly the one it names. If there is no idea yet, create it: `npm run tripcode -- idea new <id>` (kebab-case id such as `idea-2026-11`; it refuses if `trips/<id>/` exists).

**Only `tripcode idea …` changes `idea.json`.** Never edit the file by hand: the commands validate, and the page and you must agree on what is valid.

## The questions (the page's cards ask the same ones)

Order: `known` → `origin` → (`focus` → `budget` → `scenery`, only when `known` is no) → `when` → `days` → `party`. Then `suggest` / `choose` (known is no) or `locate` (known is yes), `dates`, `finish`.

In the panel you ask **only the current question**, as a multiple-choice question (`AskUserQuestion`), and write the answer straight away:

```bash
npm run tripcode -- idea answer <id> <field> '<json>'    # null = 不知道／跳過
```

Examples: `known '{"decided":false}'` or `known '"瑞士"'`; `origin '"台北"'`; `focus '"both"'` (budget | scenery | both); `budget '{"amount":60000,"currency":"TWD","per":"person"}'`; `scenery '{"tags":["mountains","food"],"text":"想泡溫泉"}'` (tags: mountains sea city food culture history nature snow nightlife shopping); `when '{"months":[4,5]}'`; `days 5`; `party '{"who":"friends","adults":3,"childrenAges":[]}'` (who: solo partner friends family parents).

- Every question is skippable (`null`). Say so once; never ask twice. If the user answers several at once (「六月，四個人，五天」), record each with its own command.
- 「直接推薦」 (from `focus` on) → `idea answer <id> wantNow true`: the rest before suggesting counts as skipped.
- If the user changed their mind about an earlier answer, answer that field again; the next step is recomputed.
- Do not ask what the file already says, and do not ask about money in detail when `focus` is scenery.

## Suggesting (`suggest`)

Give **exactly 3 places per round** unless the user asks for another number (never more than 5):

- **Different from each other** — three kinds of trip, not three neighbours (not 瑞士 / 奧地利 / 德國南部). Fit the answers: months → `bestMonths` that really include theirs; tags → what they asked to see; days → a place worth that many days from where they start; budget → do not suggest what clearly breaks it.
- `why`: **one sentence** (≤ 200 chars) tied to *their* answers (「六月的阿爾卑斯山和湖，三天就能走完最好看的一段」), not a brochure line.
- `cost.text` (≤ 120 chars): a rough cost in words, e.g. 「機票約 TWD 3–4 萬，一週花費約 TWD 6–8 萬（估計）」. Without a real search it **must say 估計**. Only with a source from a search you did (`tripcode buy browser open/text`, `places`), add `source` and `fetchedAt`. Ideas are free; **numbers are not**: never present an unsourced price as a fact, never invent a timetable.
- `tz` is the IANA zone of the main place (`Europe/Zurich`); `slug` is ascii kebab (`switzerland`, used for the trip id); `id` is kebab-case and unique in the file (a new round never reuses an id); `lat`/`lng` approximate, only for the pin on the globe; `kind` is `country` | `region` | `city`; `country` only for regions and cities.
- Record the whole round in one command:

```bash
npm run tripcode -- idea places <id> --json '[{"id":"switzerland","slug":"switzerland","name":"瑞士","kind":"country","lat":46.8,"lng":8.2,"tz":"Europe/Zurich","why":"…","bestMonths":[6,7,8],"cost":{"text":"…（估計）"}}, …]'
```

(`--file path.json` works too, relative to the repo root.) An error means nothing was written: fix the field it names and run it again.

Then the user chooses on the page (選這個 / 不要 / 再給我別的) or tells you in the panel; record it for them: `idea choose <id> <placeId>`, `idea reject <id> <placeId>`.

**再給我別的** → `idea reject-round <id>`, then suggest a **new round avoiding everything rejected** (the pretty output lists them) and, if you can tell why they were turned down, avoiding that kind of place too.

## Known path (`locate`)

`known` is yes: the user already named a place. Do not suggest alternatives. Add **one** place (the typed one) with `idea places`; it is chosen automatically and the globe turns to it. If the name is ambiguous (Paris, Texas?), ask which one before adding.

## Dates and finishing

`dates` is a card with date inputs prefilled from `when` and `days`; in the panel ask for start and end and record `idea dates <id> --start YYYY-MM-DD --end YYYY-MM-DD`. Then `finish` is **the user's click on 「建立行程」**. Run `idea finish <id>` yourself only when the user says to (「幫我建立」); optional `--title`, `--tz`, `--adults`, `--children 5,8`, `--trip-id`. It creates `trips/<newId>/` (`trip.ts`, `brief.md` already filled with what step 0 knows, `inbox/`), moves `idea.json` in, and prints the new id. Say it, and that planning continues with `plan-trip` (步驟 1 盤點).

## The reply (in the panel: at most 4 short lines, Traditional Chinese)

The cards, the globe and the chips carry the content; do not repeat the three places in prose.

1. What you recorded (one line: 「記下了：6 月、5 天」 or 「給了 3 個點子，在地球上看」).
2. The one question for the next step, as a multiple-choice question when it has choices.
3. Anything you could not confirm (a price you only estimated), one line.

## Rules

- No personal data about anyone baked into ideas or files; use only what the user answered. `profile.md` may inform defaults (home airport), but ask when unsure and never copy it into `idea.json` unasked.
- No price, hour or travel time without a source; 「估計」 is not a source.
- 怎麼去 (comparing flights, trains and total cost) is a **later step**, after destination and dates; do not do it here, and do not promise a fare.
- You never pay, book, or open a seller's checkout. This step only chooses where and when.
- Do not create trip files yourself; `idea finish` is the only way a trip appears from step 0.
- Do not touch another trip's files while doing step 0.
