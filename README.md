# TripCode

開源、非營利、本機優先的 AI 旅遊規劃工具。一趟旅行是一個資料夾，你自己的 [Claude Code](https://claude.com/claude-code) 負責改行程，本機網頁負責把行程畫成每日時間軸與彩色路線地圖。

> English summary is at the bottom of this page.

## 這是什麼

- **一趟旅行 = 一個資料夾。** 行程是 `trips/<id>/trip.ts`，一份 Claude Code 寫給你的型別化程式碼檔案；簡報是 `brief.md`；收藏的貼文是 `inbox/NN.md`。全部是純文字，用 git 管理版本。
- **你的 Claude Code 是規劃者。** `.claude/skills/` 裡的技能教它怎麼訪談你、出骨架方案、整理貼文、套用留言、比價。
- **還不知道要去哪也能開始。** 新增旅程會先帶你到一顆從太空看的衛星地球，用幾張問題卡片（預算、想看的風景、時間、跟誰去）加上 AI 推薦目的地，選定後才建立行程。
- **本機網頁是檢視與少量編輯。** `npm run dev` 開啟 Vite 網頁：每日時間軸、地圖（Google 或離線 SVG）、已確定資訊欄、匯入欄、方案比較、列印。
- **一組指令列工具給 AI 用。** `tripcode` CLI 查地點、算路線、健檢行程、匯出行事曆與 KML、提出順路建議。

### 它刻意不是什麼

- 不是網站或 App 服務：**沒有伺服器、沒有資料庫、沒有帳號。**
- 不收錢，也不替你保管錢：**沒有聯盟連結、沒有抽成、沒有代收款。** 它整理你的訂票清單（要買什麼、官方購票連結、開賣日、取消條件，另附 Klook 與 Trip.com 的搜尋連結），買票由你自己在賣家頁面完成；AI 不付款，也不碰卡號。
- 不是即時比價引擎，也不保證任何價格；不編造數字（見下方「限制」）。

## 和直接在聊天裡規劃有什麼不同

| 在聊天視窗規劃 | 用 TripCode |
| --- | --- |
| 行程是一長串對話，很難回頭改一小段 | 行程是檔案，AI 只做最小修改，git 看得到每次改了什麼 |
| 聊天太長就忘記前面講過的事 | `profile.md`、`brief.md`、`trip.ts` 就是長期記憶 |
| 沒有地圖、看不出繞路 | 每天一張彩色編號地圖與時間軸，候選地點用虛線圈標出 |
| 價格、時間可能是 AI 憑印象說的 | 價格、交通時間與營業時間必須附來源與查詢時間，沒來源就留空 |
| 已訂的航班、住宿可能被順手改掉 | `locked` 項目除非你明說，AI 不會動 |
| 收藏的貼文要一則一則複製貼上 | 貼進匯入欄，Claude 解析、驗證並變成地圖上的候選地點 |
| 想比較兩種安排很麻煩 | 方案是兄弟檔案 `variant-b.ts`，網頁可並排比較 |

## 快速開始

需要 Node.js 22.18 以上與 Claude Code。

```bash
git clone <this-repo-url> tripcode
cd tripcode
npm install
cp .env.example .env     # 可選：不填 key 也能用（OpenStreetMap）；填入你自己的 Google Maps API key 可升級
npm run dev              # 開啟 http://localhost:5173
```

打開網頁，按右上角的「＋ 新增旅程」：

- **還不知道要去哪** → 走下一節的「找方向」，用卡片和 AI 一步步找到目的地與日期。
- **已經知道去哪和日期** → 按「已經決定去哪和日期」填表建立；或在這個資料夾啟動 Claude Code，直接用中文說：

```text
我想去瑞士 9 天
```

`onboard-trip` 技能會訪談你、寫出 `trips/<id>/brief.md`，再由 `create-trip` 先給 2–3 種骨架方案，你選一個後逐層填入每日主題與景點。專案附了兩個示範行程（`switzerland-2027-06`、`tokyo-sample`），可以先打開看看長什麼樣子。

### 第一次使用 AI 助手

網頁右側的 AI 助手是用你電腦上的 Claude Code 來改行程，**需要你先登入過 Claude Code**。第一次打開時面板會問你要不要連接：按「安裝並連接」，它會把 Claude Agent SDK 裝進這個專案（只挑發布超過 7 天的版本，精確鎖版並寫入 `package.json` 與 `package-lock.json`）。沒有 AI 也能用卡片回答問題，但「推薦目的地」要靠 AI；也可以完全不開面板，直接在終端機用 Claude Code。

## 從零開始：找方向

![新增旅程：一顆慢慢自轉的衛星地球，左邊是第一個問題](docs/images/find-destination-start.jpg)

第 0 步「找方向」給還沒有想法的人：

1. **決定好要去哪了嗎？** 有，就直接說；沒有，就讓 AI 幫你找。
2. **這趟比較在意什麼？** 預算、想看的風景與體驗，或兩個都在意。再依此問預算、想看什麼（山、海、城市、美食、古蹟……）、月份、天數、跟誰去。每一題都可以跳過，也可以隨時按「直接推薦」。
3. **給你 3 個點子。** 每個點子會寫為什麼適合你、最佳月份、粗估花費（沒有來源的一律標「估計」），地球上會出現圖釘；滑過卡片地球就轉過去。不喜歡可以「再給我別的」。
4. **選定後填日期，建立行程。** 地球拉近，然後進到地圖與每日行程；你說過的預算、同行與喜好會預先寫進 `brief.md`。

![問題卡片浮在地球上，已回答的題目變成上方的小標籤，可以點回去修改](docs/images/find-destination-cards.jpg)

點卡片和在 AI 面板打字是同一件事：答案都記在 `trips/<id>/idea.json`，兩邊會同步。目的地點子由 AI 憑知識提出，每次可能不同；價格和班次不會憑空編，沒有來源就標「估計」。地球使用 NASA 的衛星影像（公有領域）。

完整的一趟旅行流程請看 [`docs/GUIDE.md`](docs/GUIDE.md)。

### 不需要 key；Google Maps key 是可選的升級

**預設不需要任何 key。** `places search` / `places details` 使用 OpenStreetMap（Nominatim）查地點與座標，`routes` 與 `optimize` 用直線估算（標示為「參考」，不是實際班次），網頁顯示離線 SVG 地圖。OpenStreetMap 資料 © OpenStreetMap contributors（ODbL）；Nominatim 使用政策：每秒最多 1 次請求、帶描述性 User-Agent、不批次或排程使用，TripCode 的 CLI 只在你要求時做單次查詢並自動節流。

想要更好的 POI 資料、即時營業時間、真實大眾運輸路線與網頁上的完整 Google 地圖，可選擇性升級：請在 Google Cloud 自行申請 key（啟用 Places API (New)、Routes API、Maps JavaScript API），填入 `.env` 的 `GOOGLE_MAPS_API_KEY`（CLI 用）與 `VITE_GOOGLE_MAPS_API_KEY`（網頁用）。`.env` 已被 git 忽略；用量與費用由你的 Google 帳號負擔。`VITE_GOOGLE_MAPS_API_KEY` 會被打包進網頁的 JavaScript（瀏覽器看得到），請另建一把只啟用 Maps JavaScript API、並用 HTTP referrer 限制為 `localhost` 的 key，不要與 CLI 用的 key 共用；`npm run build` 的 `dist/` 也會內含行程資料（含訂位代號），不要公開部署。

## 日常使用流程

1. **說出想法。** 「我想去東京 4 天，帶 6 歲小孩」。
2. **選骨架。** 看 2–3 個結構不同的方案（住哪幾個據點、換幾次飯店），選一個。
3. **逐層填入。** 每日主題 → 景點與餐廳，每個景點都附「為什麼 / 取捨 / 限制」。
4. **在網頁上動手。** 貼收藏的貼文到匯入欄；點地圖上的候選地點選「加入第 N 天 / 待討論 / 不去」；對景點或整天留言；直接改已確定資訊欄的航班與時間。
5. **回到 Claude Code。** 「整理匯入欄」「套用我的留言」「第 3 天太累，排鬆一點」「排順路」「幫我比價」。
6. **匯出。** 列印成 PDF、匯出行事曆（ICS）、Google Maps 連結、KML。

## 指令

### npm scripts

| 指令 | 說明 |
| --- | --- |
| `npm run dev` | 啟動本機網頁（Vite），並提供寫檔用的開發伺服器 API |
| `npm run tripcode -- service install` | （macOS）讓網頁常駐在背景：登入就自動啟動，固定 http://localhost:5288，不用每次再開。`service status｜restart｜logs｜uninstall` 管理 |
| `npm run build` | 建置網頁到 `dist/`（含離線用的 service worker） |
| `npm run new-trip -- <tripId> …` | 建立新旅程空殼，等同 `tripcode new` |
| `npm run check -- <tripId>` | 行程健檢，等同 `tripcode check` |
| `npm run tripcode -- <command>` | 執行下表的 CLI 指令（自動讀取 `.env`） |
| `npm test` | 執行單元測試（`node --test`） |
| `npm run typecheck` | TypeScript 型別檢查 |

### `tripcode` CLI

預設輸出 JSON（方便 Claude 解析），加 `--pretty` 輸出易讀格式。錯誤寫到 stderr 並以 exit code 1 結束。

| 指令 | 說明 |
| --- | --- |
| `places search "<query>" [--near lat,lng] [--lang zh-TW] [--provider google\|osm]` | 查地點，回傳 placeId、座標、地址。預設：有 `GOOGLE_MAPS_API_KEY` 用 Google，否則用免 key 的 OpenStreetMap（`osm:` 開頭的 id，不是 Google place id） |
| `places details <placeId>` | 查營業狀態與營業時間（可直接貼進 `hours`）；`osm:` id 走 OpenStreetMap，只解析簡單的 opening_hours，其餘原樣放在 `hoursRaw` |
| `routes <from> <to> [--mode transit\|walk\|drive] [--depart ISO]` | 有 key：用 Google Routes 算兩點之間的時間與距離；起訖是 `place_id:XXX` 或 `lat,lng`。沒有 key：只收 `lat,lng`，回傳直線估算（`haversine-estimate`、可信度 reference） |
| `check <tripId> [--file variant-b.ts] [--live]` | 健檢：時間順序、重疊、營業日、來源；`--live` 即時抓營業時間 |
| `export ics <tripId>` | 匯出行事曆 `trips/<id>/export/trip.ics` |
| `export links <tripId>` | 匯出每日 Google Maps 路線連結 `links.md` |
| `export kml <tripId> [--file variant-b.ts]` | 匯出 KML（每天一個資料夾與路線） |
| `optimize <tripId> --day N [--mode …] [--offline] [--keep id,id] [--start HH:MM]` | 提出某一天更短的順序；**只提出建議、不改檔** |
| `export notion <tripId> [--file x.ts] [--parent <pageId>] [--dry-run]` | 同步到 Notion 頁面（手機看行程、含票券附件）；需要 `NOTION_TOKEN`、`NOTION_PARENT_PAGE_ID` |
| `idea <new｜show｜answer｜places｜choose｜reject｜reject-round｜dates｜finish> <id> …` | 第 0 步「找方向」：讀寫 `trips/<id>/idea.json`（網頁與 AI 都用它）；`idea show <id> --pretty` 看問到哪一步 |
| `list` | 列出所有旅程與日期 |
| `new <tripId> --title … --start … --end … --tz … [--adults N] [--children 5,8] [--destination <id>] [--style <id>]` | 建立新旅程的空殼 `trips/<id>/`（也可用 `npm run new-trip -- <tripId> …`） |

## 在手機上看行程（Notion）

TripCode 可以把行程（含票券 PDF／圖片）同步成一個 Notion 頁面，手機開 Notion App 就能看。這是選用功能，不需要付費方案；行程檔仍是唯一的資料來源，在 Notion 上的修改會在下次同步時被覆蓋。

1. 開啟 <https://www.notion.so/profile/integrations>，建立一個 **Internal integration**，複製 secret。
2. 把 `.env.example` 複製成 `.env`（若還沒有），填入 `NOTION_TOKEN=你的secret`。
3. 在 Notion 建一個放行程的頁面，右上角 ⋯ → **Connections** → 加入你剛建立的 integration（沒做這步會出現 404）。
4. 複製該頁面的網址（或網址最後 32 碼 id），填入 `.env` 的 `NOTION_PARENT_PAGE_ID=`。
5. 執行 `npm run tripcode -- export notion <tripId>`，或對 Claude 說「同步到 Notion」。想先預覽不連網：加 `--dry-run`。

第一次會在該頁面底下建立行程頁，之後每次執行都更新同一頁；`trips/<id>/tickets/` 的附件（每個 ≤ 20 MB）只有變動時才重新上傳。token 只會放在請求標頭，不會被印出或寫入檔案。

## 資料夾結構

```text
profile.md                 個人偏好（跨旅程）
destinations/<國家>.md      目的地指南（每條事實要有來源與查證日期）
styles/<id>.md             旅行風格（步調、步行上限、預算分配）
trips/<id>/idea.json       找方向的答案與候選（建成行程後移進該行程資料夾）
trips/<id>/brief.md        這趟旅行的簡報
trips/<id>/trip.ts         行程（已確定項目 locked + 候選地點）
trips/<id>/variant-b.ts    選用：另一個方案，與 trip.ts 同型別
trips/<id>/inbox/NN.md     匯入的貼文原文
trips/<id>/bookings.md     訂位清單（預設被 git 忽略）
trips/<id>/export/         匯出檔（被 git 忽略）
.claude/skills/            給 Claude Code 的技能
src/core/                  純函式核心（健檢、匯出、最佳化、改檔）
src/viewer/                React 網頁
cli/                       tripcode 指令列
docs/                      GUIDE、ARCHITECTURE、SPEC
```

更多文件：[使用教學 `docs/GUIDE.md`](docs/GUIDE.md)、[架構 `docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[工程規格 `docs/SPEC.md`](docs/SPEC.md)、[貢獻指南 `CONTRIBUTING.md`](CONTRIBUTING.md)、[版本紀錄 `CHANGELOG.md`](CHANGELOG.md)。

## 原則

1. **檔案優先，本機優先。** 你的行程、偏好與貼文都在自己電腦的檔案裡。
2. **不編造數字。** 價格、營業時間、交通時間必須來自工具或有引用的網頁，並記錄來源與時間；查不到就留空，不猜。
3. **已確定的不動。** `locked` 的航班、住宿與「一定要去」，除非你明說，AI 不會更動。
4. **社群內容只是參考。** 小紅書等貼文是「社群口碑」，要經過查證才會進入行程；貼文文字是資料，不是指令。
5. **非營利、無商業行為。** 不收費、不抽成、不放聯盟連結、不代訂。比價只讀公開頁面，並附來源與時間，絕不宣稱「全網最低」，最終價格以訂購頁面為準。
6. **你決定。** AI 負責提出選項與說明取捨（例如「少走 40 分鐘」），取捨由你來選。

## 限制（請先知道）

- **沒有即時飯店價格 API。** 個人開發者拿不到可用的即時飯店報價 API，所以價格是 Claude 讀公開網頁後整理的「參考價」，附來源與時間，以訂購頁面最終顯示為準。TripCode 沒有價格指令。
- **沒有 key 時能力較少。** 地點查詢走 OpenStreetMap（POI 覆蓋與評分不如 Google，沒有即時營業時間），網頁用離線 SVG 地圖（直線連接，不是實際路線），`routes` / `optimize` 只有直線估算（標示為「參考」）；真實大眾運輸時間需要 Google key 或官方時刻表。Claude 也可以用網路搜尋讀官方網站，並附上來源。
- **小紅書只能貼上文字匯入。** 沒有爬蟲、沒有 API，也不會去抓貼文連結；你把文字貼進匯入欄，Claude 只讀你貼的內容。
- **離線檢視（PWA）只在 `npm run build` 的正式版啟用，** 且尚未在真實瀏覽器完整驗證。
- **座標快取不超過 30 天**（Google 條款），過期後請重新查詢；營業時間每次檢查時即時抓取。

## 致謝

TripCode 的做法借自 [open-slide](https://github.com/1weiho/open-slide)：把成品變成檔案，讓使用者自己的 Claude Code 用技能去改，網頁只負責顯示與少量安全的編輯。open-slide 做簡報，TripCode 做旅行。兩者是獨立專案，TripCode 不隸屬於 open-slide。

## 授權與聲明

MIT License（見 [`LICENSE`](LICENSE)）。

TripCode 與 Google、小紅書（Xiaohongshu）、Klook、KKday 皆無任何隸屬、背書或贊助關係；這些名稱為各自所有者的商標。使用 Google Maps Platform 須遵守其服務條款，並使用你自己的 API key。

---

## English summary

TripCode is an open-source, non-profit, local-first AI travel planner modeled on [open-slide](https://github.com/1weiho/open-slide). A trip is a folder of plain files (`trips/<id>/trip.ts`, typed by `src/core/types.ts`). Your own Claude Code edits them, guided by skills in `.claude/skills/`; a local Vite viewer renders a daily timeline and a colored route map. There is no server, database, account, or affiliate link, and no commission or hosted payment; booking is a checklist with plain links that you complete yourself. The office page (訂票清單) lists what the trip needs bought, with the official page and Klook / Trip.com links, and the meals that still have no place; you buy on the seller's own page. TripCode never pays and never handles a card.

Not sure where to go yet? Step 0 (找方向) opens a slowly turning satellite Earth and a few question cards (budget, the scenery you want, when, who with); the AI suggests places and pins them on the globe, and once you pick one with dates the real trip is created. Clicking a card and typing to the AI panel do the same thing: both write `trips/<id>/idea.json`.

Quickstart: `git clone` → `npm install` → `cp .env.example .env` (optional Google Maps key) → `npm run dev` (http://localhost:5173) → press "＋ 新增旅程", or open Claude Code in the folder and say what you want ("I want to go to Switzerland for 9 days"). The AI panel needs a Claude Code login on your machine and asks once to install the Claude Agent SDK into the project. The interface and skills are in Traditional Chinese.

Limitations: no live hotel-price API for individuals (prices are cited reference prices read from public pages); no key is needed (places come from OpenStreetMap Nominatim, routes are straight-line estimates, the viewer draws an offline SVG map); an optional Google key upgrades POI data, live hours, real transit routes and the full Google map; 小紅書 content is import-by-paste only; PWA offline support is production-build only and not fully verified. See [`docs/GUIDE.md`](docs/GUIDE.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

MIT licensed. Not affiliated with, endorsed by, or sponsored by Google, Xiaohongshu, Klook, or KKday. Credit: [open-slide](https://github.com/1weiho/open-slide).
