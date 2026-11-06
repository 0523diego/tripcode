# 架構概覽

給想改程式碼的人。使用者導向的說明在 [README](../README.md) 與 [GUIDE](GUIDE.md)；完整的工程規格（欄位、端點、指令細節）在 [SPEC](SPEC.md)。

## 設計取向

TripCode 沿用 open-slide 的做法：**成品是檔案，AI 用技能去改檔案，網頁只負責顯示與少量安全的編輯。** 因此沒有伺服器、資料庫與帳號；所有狀態都在 repo 裡，版本控制交給 git。

## 分層

```text
┌──────────────────────────────────────────────────────────────┐
│ Claude Code（使用者自己的）  ←  .claude/skills/*/SKILL.md      │
│   讀寫 trips/<id>/*、profile.md、destinations/*、styles/*      │
│   呼叫 tripcode CLI 取得有來源的事實                            │
└───────────────┬──────────────────────────────┬───────────────┘
                │ 改檔                          │ npm run tripcode -- …
                ▼                              ▼
        trips/<id>/trip.ts              cli/（Node 直接執行 .ts）
                ▲                              │ import
                │ Vite glob 載入                ▼
┌───────────────┴───────┐        ┌──────────────────────────────┐
│ src/viewer/（React）   │ import │ src/core/（純函式，無 I/O）      │
│ 時間軸、地圖、面板       ├───────▶│ types check links ics kml     │
└───────────────┬───────┘        │ optimize source-edit time     │
                │ POST /__tripcode/*   └──────────────────────────────┘
                ▼                              ▲
   vite-plugin-tripcode.ts ─────────────────────┘
   （開發伺服器 API：驗證輸入後呼叫 source-edit 寫檔）
```

| 層 | 位置 | 職責 | 限制 |
| --- | --- | --- | --- |
| 資料 | `trips/`、`profile.md`、`destinations/`、`styles/` | 使用者的內容 | `trip.ts` 型別由 `src/core/types.ts` 規範 |
| 核心 | `src/core/` | 健檢、時間運算、連結 / ICS / KML 產生、最佳化、改檔 | **純函式**：不用 `fs`、`window`、`fetch`，I/O 以參數注入 |
| CLI | `cli/` | 地點查詢（預設免 key 的 OpenStreetMap Nominatim，有 key 時用 Google Places）、路線（Google Routes 或直線估算）、`check`、`export`、`optimize`、`list`、`new` | 以 `node` 直接跑（Node ≥ 22.18 會剝除型別）；網路層可注入假的 `fetch` 以便測試 |
| 開發伺服器 API | `vite-plugin-tripcode.ts` | 接收網頁的編輯請求並寫檔 | 只允許寫 `trips/<tripId>/` 與 `node_modules/.tripcode/current.json` |
| 網頁 | `src/viewer/` | 顯示與少量編輯 | 只透過 API 改檔，不直接碰檔案系統 |
| 技能 | `.claude/skills/` | 教 Claude 工作流程與規則 | 是給模型讀的說明文件，描述必須與程式碼實際行為一致 |

## 資料流

1. **AI 路徑：** 使用者對 Claude 說話 → 技能規定流程 → Claude 用 CLI 取得事實（地點、路線、營業時間）→ 直接編輯 `trip.ts` → `npm run check` 驗證。
2. **網頁路徑：** 網頁用 `import.meta.glob('/trips/*/*.ts')` 與 `import.meta.glob('/trips/*/inbox/*.md', { query: '?raw' })` 載入所有旅程，檔案一變就 HMR / 重新載入。使用者在網頁上的動作（留言、改欄位、改候選狀態、貼文）以 `POST /__tripcode/<endpoint>` 送到開發伺服器。
3. **兩條路徑互相看得到對方：** 網頁寫進 `trip.ts` 的留言標記由 Claude 讀取；網頁每次選取項目會寫 `node_modules/.tripcode/current.json`，讓 `current-trip` 技能知道使用者「現在看的是哪一天」。

### 為什麼網頁不重新序列化 trip.ts（原始碼編輯寫入路徑）

網頁**不會**把 `Trip` 物件轉回 JSON 再整檔寫回，那會抹掉 Claude 寫在檔案裡的註解、格式與排序，也會讓每次編輯產生巨大的 diff。取而代之，`src/core/source-edit.ts` 只提供幾個「字串進、字串出」的函式，在物件字面值內做外科手術式的修改：

- `insertComment`：在目標物件開頭那一行上方插入 `// @trip-comment(<anchor>): <text>`（anchor 為 `item | gap | leg | day`）。
- `setItemField`：只能改 `title / start / end / flightNo / bookingRef / note`，其他欄位會丟錯誤。
- `setCandidateStatus`：改候選的 `status`，並設定或移除 `day`。
- `findObjectById`：以 `id: '<id>'` 找到物件字面值，括號比對時會忽略字串、樣板字串與註解裡的大括號。

每個函式回傳新的原始碼字串，且除了目標位置之外**一個位元組都不動**。開發伺服器收到請求後：驗證 `tripId`（`^[a-z0-9-]+$`）與檔名（`^[a-z0-9-]+\.ts$`）、用 `safeJoin` 確認路徑沒有跳出 `trips/<tripId>/`、讀檔、呼叫上述函式，先寫暫存檔再 `rename` 取代（避免寫到一半的檔案）。回應是 `{ ok: true }` 或 HTTP 400 加 `{ ok: false, error }`。

另外，每個請求先過 `guardRequest`：`Host` 必須是 `localhost`、`*.localhost` 或 IP（與 Vite 的 `allowedHosts` 預設一致，防 DNS rebinding）、若帶 `Origin` 必須與 `Host` 相同、`Sec-Fetch-Site` 不可是跨站、`Content-Type` 必須是 `application/json`（讓別的網頁無法用不需預檢的 `text/plain` 表單寫你的行程）。請求本文上限 1 MB；`start` / `end` 只接受 `HH:MM`；`inbox` 不會替不存在的旅程建立資料夾。

這個設計也是為什麼 `trip-authoring` 規定：**一個物件一個項目、`id` 放第一個屬性、不用迴圈或展開語法產生項目、不計算 id**。只要違反，網頁就找不到要改的位置。

### 開發伺服器端點

| 端點 | 效果 |
| --- | --- |
| `comment` | `insertComment`，寫入 `trip.ts`（或指定的 variant 檔） |
| `item-field` | `setItemField` |
| `candidate` | `setCandidateStatus` |
| `inbox` | 寫入下一個 `inbox/NN.md`（frontmatter `status: pending`、`createdAt`） |
| `current` | 寫入 `node_modules/.tripcode/current.json`（`day` 為 1 起算） |

## 為什麼是 `trip.ts` 而不是 JSON

- **型別就是契約。** `defineTrip({...})` 讓 Claude 與編輯器都能即時得到型別檢查；歧異聯集（`kind` 決定可用欄位）能擋掉大量錯誤，例如在交通項目上放 `flightNo`。
- **註解是一等公民。** 行程的「為什麼」、待查證事項與留言標記可以直接寫在程式碼旁邊；JSON 不能有註解。
- **小而清楚的 diff。** 檔案由人與 AI 手寫，git diff 讀起來像文件修訂，而不是機器產生的資料搬家。
- **不需要建置步驟。** Vite 直接載入 `.ts`；CLI 用 Node 的型別剝除直接 `import`。
- **代價：** 檔案是程式碼，所以改檔工具必須保守（見上節）；而且可以寫出不符合約定的程式碼（迴圈、運算式），所以約定寫在技能裡、並由 `check` 與型別檢查把關。

## 健檢規則（`checkTrip`）

| 代碼 | 等級 | 說明 |
| --- | --- | --- |
| `date-range` | error | 日期格式不正確、超出 `start..end`、重複或未遞增 |
| `invalid-time` | error | `start` / `end` 不是 `HH:MM` |
| `time-order` | error | `end` 早於 `start`（航班除外，可能跨日抵達） |
| `overlap` | error | 項目早於前一個有時間的項目結束就開始（航班除外） |
| `closed` | error | 落在公休的星期，或 `closedDates` 內 |
| `outside-hours` | warn | 不在當天的營業時段內 |
| `transit-gap` | warn | 交通項目的時間窗短於其 `duration` |
| `arrival` | warn | 當天有抵達航班時，第一個非航班項目早於抵達後 60 分鐘 |
| `missing-source` | error | 價格、票價、車資、時間長度或營業時間沒有 `source` 或 `fetchedAt` 無效 |
| `duplicate-id` | error | 項目或候選的 id 重複 |

`closed` 與 `outside-hours` 需要營業時間資料：來自檔案內的 `hours`，或 `check --live` 向 Google 即時抓取（需要 `placeId` 與 API key）。沒有資料時，這兩條規則會被略過而不是亂猜。

## 不需要 key：OpenStreetMap 與 Google 的分工

預設路徑不需要任何 API key：`places` 用 Nominatim（`cli/osm.ts`），`routes` / `optimize` 用直線估算（`src/core/optimize.ts`），網頁用離線 SVG 地圖。Google key 是可選升級（較好的 POI 資料、即時營業時間、真實大眾運輸路線、網頁上的完整 Google 地圖）。選擇邏輯：有 `GOOGLE_MAPS_API_KEY` 就用 Google，否則用 OSM；`--provider google|osm` 可強制指定。

- 資料 © OpenStreetMap contributors（ODbL）；OSM 結果的 `source` 為 `openstreetmap-nominatim`，可信度 `reference`。
- 遵守 Nominatim 使用政策：描述性 User-Agent、每秒最多 1 次（行程內節流）、只做使用者要求的單次查詢，不批次、不排程。
- OSM id 形如 `osm:node/123`，**不是** Google place id；`dayMapsLinks` 會把 `placeId` 當 Google 的 `*_place_id` 送出，所以行程檔不要把 `osm:` id 寫進項目的 `placeId`（只保留 `loc`）。CLI 的 `check --live` 與 `optimize` 會略過 `osm:` id。

## Google Maps 服務條款的限制（使用 Google key 時）

TripCode 設計成可以合規地使用 Google Maps Platform（使用你自己的 API key）：

- **儲存 `placeId`。** Place ID 可以長期儲存，是項目與候選的穩定識別。
- **座標最多快取 30 天。** `LatLng.fetchedAt` 記錄抓取時間；超過 30 天的座標要重新查詢。範例行程的座標是人工填的約略值，並在檔案中明確標註。
- **營業時間即時抓。** `hours` 不存進檔案（除非來自官網等非 Google 來源，並附來源）；`check --live` 在檢查當下才向 Places 抓取。
- **不批次抓取。** 工具只做使用者要求的個別查詢；離線 SVG 地圖只畫行程檔裡自己的座標，不使用 Google 圖磚。
- **用量與費用在使用者。** key 放在使用者自己的 `.env`（已被 git 忽略）。

這是工程上的設計意圖，不是法律意見；實際條款以 Google 為準。

## 其他設計決定

- **候選與已排程分開。** `candidates` 是地圖上「還沒排進日子」的地點，狀態由使用者決定；Claude 不替使用者設定 `accepted` / `rejected`。
- **變體是兄弟檔案，不是分支。** `variant-b.ts` 與 `trip.ts` 同型別，網頁並排比較，`check` / `export` / `optimize` 以 `--file` 指定。
- **`optimize` 唯讀。** 它只輸出建議（順序、省下的分鐘、移動說明、信心等級），由 Claude 手動套用成最小修改。有 key 時用 Routes 矩陣；沒有時用直線估算，信心標為 `reference`。8 個以下停靠點用精確搜尋，更多則用最近鄰加 2-opt。
- **CLI 輸出 JSON。** 讓 Claude 能解析；`--pretty` 給人看。可貼進檔案的值（`duration`、`hours`）已經是 `Sourced` 結構。
- **PWA 只在正式版。** `public/sw.js` 為手寫的 network-first service worker，只在 `import.meta.env.PROD` 時註冊。

## 測試

`node:test` + `node:assert/strict`，測試檔 `*.test.ts` 與原始碼放在一起，`npm test` 執行；`npm run typecheck` 跑 `tsc --noEmit`。核心與 CLI 為純函式或可注入 I/O，所以不需要瀏覽器或網路就能測。網頁的互動是以瀏覽器手動驗證，沒有自動化 UI 測試。
