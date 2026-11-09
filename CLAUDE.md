# TripCode — Agent Guide

TripCode is an open-source, non-profit, local-first AI travel planner modeled on open-slide.
Read `docs/SPEC.md` before changing code. Progress lives in `PROGRESS.md`.

## Hard rules

- Trips live in `trips/<kebab-case-id>/`; the plan is `trip.ts` typed by `src/core/types.ts`.
- Never invent prices, opening hours or travel times. Use the `tripcode` CLI or a cited web source,
  and wrap the value in `Sourced` with source + fetchedAt. Unknown → leave it out and say so.
- Never change `locked: true` items unless the user asks explicitly.
- No accounts, servers, affiliate links, commission, or hosted payments. Links to sellers are plain: no tracking or affiliate parameters,
  and a reseller (Klook, Trip.com, ...) is never presented as the official page.
- **You never pay.** The user buys from the 訂票清單 page, on the seller's own page. TripCode has no payment layer (taken out 2026-11-04; a copy
  is kept outside the repo): never ask for or write a card number, CVC or passphrase anywhere, never read `~/.tripcode/` (TripCode's own Chrome profile).
- **Flight prices are an opt-in, unofficial read** (`tripcode flights`, `src/prices/`, off unless `TRIPCODE_FLIGHTS=1`): it reads Google Flights' public search page, which Google's terms do not allow, so it is personal, low-frequency use only. Never run it in a loop or on a schedule, never send cookies or click through Google's consent page, stop at any block or pause and give the user the Google Flights link instead. Every price is a dated snapshot ("Google 顯示價，訂票前以官方為準"); it never edits `trip.ts`. Uses no dependency (Node `fetch` only).
- Do not add dependencies. Versions in package.json are exact; never use a version published
  less than 7 days ago; keep package-lock.json committed. The one exception is `@anthropic-ai/claude-agent-sdk`:
  it is opt-in, installed only when the user presses 「安裝並連接」 in the viewer's AI 助手 panel (which pins the newest
  version that is ≥ 7 days old), and the code never imports it statically.
- Imports use explicit `.ts`/`.tsx` extensions; only erasable TypeScript syntax.
- After editing a trip: `npm run check -- <tripId>`; after editing code: `npm test` and `npm run typecheck`.
- User-facing text is Traditional Chinese.

## Which skill to use

- **Any planning request, "接下來做什麼", or when unsure → `plan-trip` first.** It is the fixed protocol: run `npm run tripcode -- ready <tripId> --pretty` to see which of the five steps the trip is at, do that step with the skill it names, and answer in the protocol's one format. The skills below are its steps.

- 「不知道去哪」「推薦我去哪」, or a folder with only `trips/<id>/idea.json` → `find-destination` (step 0; `tripcode idea show <id> --pretty`; change `idea.json` only with `tripcode idea …`).
- New trip / "我想去…" → `onboard-trip` (interview → `brief.md`), then `create-trip` (skeleton → daily themes → places).
- Any edit inside `trips/<id>/` (also "排順路 / 調整某天", why `check` fails) → read `trip-authoring` first.
- `@trip-comment` markers in a trip file ("套用留言") → `apply-comments`.
- "這一天 / 這個景點 / 這個" without a name → `current-trip` (re-read `node_modules/.tripcode/current.json` every turn).
- Pending inbox tiles (`trips/<id>/inbox/NN.md`, pasted posts) → `import-inbox`.
- 「幫我看看這個行程」「審稿」「出發前檢查」 → `review-trip` (read-only: at most 7 findings with evidence; start from `tripcode ready <tripId>`).
- 訂票清單：「補官方連結」「這個要預約嗎」「哪些要訂票」 → `booking-checklist` (writes `booking` on items with sourced official links, sale dates, deadlines; `tripcode bookings <tripId>`).
- 午餐／晚餐還沒決定、「這餐吃什麼」「推薦餐廳」「當地必吃」 → `fill-meals` (dish first: the city's local dishes from Wikivoyage with sources, then real places from `tripcode food near`; a map has no ratings, never invent a restaurant or a rating).
- Prices, "哪裡訂比較便宜" → `find-prices` (compares only; never books or pays).
- 「幫我盯價格」「降價通知」「開賣提醒」「好，買第二個」 → `booking-checklist` (sale-date reminders with `buy watch`; the user buys on the seller's page; never offer to pay or watch a price for a purchase).
- 「同步到 Notion」「手機看行程」 → `sync-notion` (`tripcode export notion <tripId>`; first-time setup is in the skill).
- New country, no `destinations/<country>.md` → `create-destination`.
