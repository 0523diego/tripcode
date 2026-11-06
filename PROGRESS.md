# TripCode progress board

Foreman: Opus (main session). Workers: Sonnet sub-agents with disjoint file ownership.
Rule: small steps; every finished chunk is committed; this board is updated in the same commit.

## How to resume after an interruption

1. `git log --oneline | head` and read this file.
2. Unchecked items in the current milestone are the next work. Worker notes (kept outside the repo)
   described half-finished work.
3. Verify with `npm test && npm run typecheck`, then continue.

## v0.1 — usable for one real trip

- [x] F0 Foundation: package.json (exact versions), tsconfig, types contract, SPEC, CLAUDE.md
- [x] F1 npm install (versions ≥7 days old) + first commit
- [x] W1 core: time.ts, check.ts, links.ts, ics.ts, source-edit.ts + tests
- [x] W2 viewer: layout, map (Google + SVG fallback), timeline sidebar, facts bar, inbox, candidates, comments
- [x] W3 dev-server API plugin + vite.config.ts + CLI (places, routes, check, export, list) + tests
- [x] W4 skills (onboard-trip, create-trip, trip-authoring, + v0.2 drafts), sample Switzerland trip, profile/styles/destinations, README
- [x] I1 Integration: dev server runs, sample trip renders, viewer edits write files, check passes
- [x] I2 Browser verification of the viewer

## v0.2 — refine and price

- [x] optimize command (time windows, respects locked + manual order)
- [x] variant side-by-side compare in viewer
- [x] skills: apply-comments, current-trip, import-inbox, find-prices, create-destination (finalize)
- [x] print stylesheet (PDF), KML export, PWA offline for the day view

## v1.0 — open-source release

- [x] new-trip scaffolding, docs (README/GUIDE/ARCHITECTURE/CONTRIBUTING/CHANGELOG), LICENSE, second example trip
- [x] polish pass, accessibility pass, final review (R3)
- [x] UI/UX redesign: all-black, map-first layout, one floating rail with tabs (foreman, per user feedback)
- [x] Keyless maps: OSM tiles under the interactive map, Google preview mode, OSM place search in the CLI
- [x] User sign-off on the redesign; CHANGELOG dated; `git tag v1.0.0`

## v1.6 — 訂票清單、吃飯空檔、出發準備度 (2026-11-04)

- [x] 常駐背景服務：`tripcode service install|uninstall|status|restart|logs`（macOS launchd，固定 5288 埠，只聽本機，掛掉自動重開）；在你的機器上實際安裝並殺程序測過會重開。未驗證：重新開機後自動啟動、AI 助手在背景服務下實際送出一輪（登入憑證在鑰匙圈）、Linux／Windows

- [x] 規劃協議 v1：`plan-trip` 技能、`planStages` 五個固定步驟（由檔案計算）、`tripcode ready` 與頁面步驟條、每天結構規則（依距離與時間，不是點的數量：走路距離、每個點分到的時間、沒有輕鬆的一天；`src/core/load.ts` 與 `PLAN_RULES`）；用義大利、瑞士與威尼斯行程跑過
- [ ] 協議未驗證：AI 助手是否真的照協議的回覆格式與步驟做（只有文字規則加程式檢查，沒有實際對話測過）；門檻數字（3 個預約、2 個景點、連續 5 天）是預設值，要用你實際的行程調

- [x] 下架 AI 付款（維護者決定）：付款、保管庫、購買意圖單、帳本、填卡、辦公室四位角色與 `buy-tickets` 技能整層拿掉；完整備份由維護者另存在專案外；留下開賣日提醒與讀頁面（`buy watch|scan|alerts|browser`）

- [x] M1：`Booking` 型別與來源檢查、`deriveBookingTodos` 與連結規則、`findMealGaps` 與 Google 地圖連結解析、`readiness` 與 `tripcode ready` / `bookings`、`setBooking` / `setItemLoc`、`/__tripcode/booking` 與 `/meal`（可復原）、訂票清單頁、三個技能、AI 助手提示改寫
- [x] 驗證：核心與端點有單元測試；真實義大利與威尼斯行程跑過推導（7 項待買、14 個空檔、空殼與缺住宿）；瀏覽器用 tokyo-sample 實測「貼地圖連結加進行程」寫進檔案（之後已用 git 還原範例檔）
- [ ] 未驗證：「我買好了」按鈕在真實行程上的整段流程（只有端點測試與一次 UI 的「改回待買」）；Klook／Trip.com 的商品頁連結（目前只有搜尋連結）；AI 助手照 `booking-checklist`／`review-trip` 技能的實際表現
- [ ] M2：Google Places 附近餐廳（評論數優先、評分次之，加評分與評論數下限、熱門景點旁標記）；需要維護者決定要不要申請 key 與每月上限
- [ ] M3：口味累積、Notion 匯入、行後回顧

## v1.5 — watch and buy (2026-11-03；付款部分已於 2026-11-04 下架，只剩盯價與讀頁面)

- [x] src/purchase/：price、store（驗證）、scan（監控與提醒）、vault（AES-256-GCM + scrypt）、prompt（只接受真終端機）、policy（預算／網域／頁面總額／ledger）、cdp + checkout（Chrome DevTools Protocol 填卡）、pay
- [x] CLI `tripcode buy …`（watch / scan / alerts / intent / vault / pay / ledger）、skill `buy-tickets`、AI 助手面板的硬性拒絕（`src/agent/guard.ts`）、CLAUDE.md／README／CONTRIBUTING／相關 skills 的規則改寫
- [x] 單元與整合測試：價格抽取、排程與提醒、保管庫、政策、付款流程、CLI；真實 headless Chrome 對假結帳頁（含跨程序 iframe）填卡、總額不符拒填、host 不允許不填
- [x] 自動付款（2026-11-03）：`buy vault autopilot on|off|status`（使用者在終端機輸入一次密語，金鑰存 `~/.tripcode/autopilot.key`）、`buy pay … --auto`（不問密語與確認、自動按付款，仍受預算／單筆／網域／頁面總額限制）、`buy browser open|tabs|text|links|click|type|press|shot`（AI 走到付款頁）；AI 面板只拒絕 `buy vault`、沒有 `--auto` 的 `buy pay` 與 `~/.tripcode/`；真實 Chrome 測試走完 瀏覽 → 結帳 → 自動付款
- [x] 採購辦公室（2026-11-03）：`#/trip/<id>/office`（四位角色、看板、提醒、即時動態、開張準備引導、AI 面板停靠）、`/__buy` 唯讀快照與安全按鈕、`activity.jsonl`；瀏覽器驗證過桌面與手機版面（當時用暫時的範例資料，之後已移除），後端與狀態推導有單元測試
- [ ] 未驗證：辦公室對真實掃描／付款資料的畫面（只看過空白狀態）；真實商家（Klook、Trip.com）的付款頁；有頭 Chrome 在使用者機器上的完整流程；Windows（密語提示、Chrome 路徑）
- [ ] 未做：viewer 裡的提醒與意圖單畫面（目前用 `buy alerts --pretty`）；自動寄／推通知；歐洲發卡方的實測（ether.fi 等，需先確認所在國家可申請）

## v1.4 — AI 助手 panel (2026-10-31)

- [x] src/agent/：store、runner、Claude provider（Agent SDK 於執行時從 workspace 匯入）、prompt、install（≥7 天精確版本）、`/__agent` 路由（REST + SSE）
- [x] src/viewer/agent/：store、AgentPanel（連接頁、歷史、串流對話、權限／提問卡、編輯重送）、context、agent.css；桌面佔用詳細卡位置，手機全螢幕
- [x] 單元測試：store/runner/claude mapper/routes（真實 http server）/install/viewer store；瀏覽器以假 SDK 走完整流程驗證，並用真實 registry 在暫存資料夾驗證安裝
- [ ] 未驗證：真正呼叫 Claude Code 的一輪（用假 SDK 驗證 UI 與協定；SDK 選項名稱已對照 0.3.310 型別）
- [x] 視覺化編輯補強：行程清單雙擊（或 F2）直接改名稱／開始時間；復原／重做（⌘Z／⇧⌘Z + 標頭按鈕），`src/core/history.ts` + `undo`/`redo`/`history` 端點；瀏覽器驗證改名、改時間、undo、redo、跳回被改的項目
- [ ] 未做：復原不涵蓋上傳票券、收件匣、新增旅程（寫的不是 trip 檔）；伺服器重啟後歷史清空

## v1.3 — UI/UX pass (2026-10-17)

- [x] 樣式拆檔：styles.css 留 tokens/shell/共用控制項，各分區移到 src/viewer/styles/（讓四個 worker 平行工作不互撞）
- [x] 地圖：總覽分群、標籤預算、選取不暴衝、虛線＝直線估算、回到這一天、手機不吃滾輪、圖磚離線快取
- [x] 行程清單：交通時長與距離（有查證用實值，否則標「約」）、locked 視覺權重、空檔入口放寬、日期條可捲提示、候選來源連結
- [x] 核心：remove-item / set-locked / optimize 端點，missing-transit 與 day-overload 兩條健檢
- [x] 外框：手機單一三段式 sheet、落在今天、留言追蹤、詳細卡直接編輯、順路建議入口、footer 重排
- [ ] 未驗證：方案比較視圖（沒有 variant 檔可測）、Google 地圖分支（沒有金鑰）、PWA 離線（只在 prod build）

## Log

- 2026-10-16 F0 done (foreman).
- 2026-10-16 W4 done: 8 skills, Switzerland sample trip (9 days), README (foreman reviewed: candidate→item handoff removes candidate in same edit; current.day is 1-based).
- 2026-10-16 W3 done: dev-server API (5 endpoints), CLI (places/routes/check/export/list), 50 tests pass; JSX via Vite 8 oxc automatic runtime, no React plugin.
- 2026-10-16 W1 done: core (time/check/links/ics/source-edit), 91 tests; full suite 141/141, typecheck clean. Flights exempt from overlap; added invalid-time check.
- 2026-10-16 W2 done: viewer (top bar, facts bar, inbox, SVG/Google map, timeline, detail panel); smoke-tested in browser, real writes untested.
- 2026-10-16 I1/I2 done (foreman): dev server on :5288; browser-verified inbox write, candidate accept (minimal diff), comment marker, facts edit → check warning; CLI check passes. **v0.1 complete.**
- 2026-10-16 V2 done: variant compare view, print/PDF layout, PWA (manifest + network-first sw, prod only; real SW registration unverified).
- 2026-10-16 V3 done: all 8 skills cross-checked against real code (marker format, current.json, inbox statuses, CLI shapes, check codes).
- 2026-10-16 V1 done: optimize (exact ≤8 stops, NN+2-opt above; read-only proposal), Google route matrix + haversine fallback, KML export. Suite 181/181, typecheck + build clean. **v0.2 complete.**
- 2026-10-16 R1 done: `tripcode new` / `npm run new-trip` scaffolds trip.ts + brief.md + inbox; 201 tests.
- 2026-10-16 R2 done: README (zh-TW + EN), GUIDE, ARCHITECTURE, CONTRIBUTING, CHANGELOG, tokyo-sample trip.
- 2026-10-16 R3 done: security (request guard, 1 MB cap, HH:MM validation), sw cache fixes, ICS/a11y fixes; 211 tests, typecheck/build/check clean. Remaining: browser acceptance + tag v1.0.0 (paused at usage limit).
- 2026-10-16 Redesign (foreman): all-black map-first viewer, rail tabs (行程/已確定/匯入), itinerary list, floating detail card, label collision layout; fixed pin click loss on hover/touch and tmp-file race; 213 tests, typecheck + build clean, browser-verified desktop + mobile.
- 2026-10-16 Keyless maps (foreman + OSM worker): Mercator SVG map on darkened OSM tiles, Google preview iframe mode, Nominatim places provider, haversine routes without key, osm: ids never sent to Google; 235 tests.
- 2026-10-16 v1.0.0 released (user signed off on design and maps).
- 2026-10-16 v1.1 (foreman + B1 + N1): home page with trip cards and new-trip form, manual add place (OSM/Google search → candidate), ticket attachments (upload/open/remove), dev-server endpoints, Notion export; browser-verified; Notion untested against a real workspace.
- 2026-10-17 v1.3 UI/UX pass (foreman + 4 Sonnet workers，檔案所有權不重疊，worker 不 commit)：
  地圖／行程清單／核心／外框四塊平行完成，374 tests、typecheck、build 全綠，三趟行程 check 0 warnings。
  foreman 退回一輪：missing-transit 原本在一趟真實行程上誤報 4 次（已訂的巴士團）並印出
  367 分鐘的假交通時間（巴斯→倫敦實際約 100 分鐘），改為 30 公里外只講距離、locked 不報。
