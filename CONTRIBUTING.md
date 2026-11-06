# 貢獻指南

謝謝你願意幫忙。TripCode 是開源、非營利、本機優先的專案；以下規則的目的是讓它保持小、可靠、不編造資料。請先讀 [`CLAUDE.md`](CLAUDE.md) 與 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，工程規格在 [`docs/SPEC.md`](docs/SPEC.md)。

## 環境

需要 Node.js 22.18 以上（`package.json` 的 `engines`；這個版本起 Node 預設剝除 TypeScript 型別，CLI 才能直接執行 `.ts`）。

```bash
git clone <this-repo-url> tripcode
cd tripcode
npm install
cp .env.example .env     # 可選：Google Maps key，只在你要測 places / routes / 地圖時需要
npm run dev
```

不需要 Google key 就能跑完全部測試：CLI 的網路層是注入的，測試使用假的 `fetch`。

## 測試與型別檢查

提交前一定要通過：

```bash
npm test             # node --test，測試檔 *.test.ts 放在原始碼旁邊
npm run typecheck    # tsc --noEmit
npm run check -- <tripId>   # 改了 trips/ 裡的檔案時
```

- 測試用 `node:test` 與 `node:assert/strict`，不引入測試框架。
- 新功能要附測試；改 bug 先寫一個會失敗的測試。
- 改了網頁（`src/viewer/`）請在瀏覽器實際操作一遍。目前沒有自動化的 UI 測試，所以請在 PR 描述寫你驗證了什麼。

## 依賴政策

TripCode 刻意只有 `react`、`react-dom`、`vite`、`typescript` 與 `@types/*`。

1. **不新增依賴。** 需要新套件時，請先開 issue 討論；沒有共識前不要在 PR 裡加。優先使用標準 web / Node API。
2. **版本精確固定。** `package.json` 使用精確版本（`"vite": "8.3.4"`），不用 `^` 或 `~`。
3. **版本必須已發布至少 7 天。** 避開剛發布的版本以降低供應鏈投毒風險；最新版不到 7 天就用上一個穩定版。可用 `npm view <package> time` 查發布時間。
4. **lockfile 一定要提交。** `package-lock.json` 的變更要出現在 PR 裡。
5. 安裝前看一下套件頁面：發布時間異常、維護者變更、新增不明依賴都要在 PR 裡說明。

## 程式碼規則

- **`.ts` / `.tsx` 副檔名要寫明。** 匯入一律是 `from './check.ts'`；Node 的型別剝除與 Vite 都需要。
- **只用可剝除的 TypeScript（erasable syntax）。** 不要用 `enum`、`namespace`、參數屬性（`constructor(private x)`）。`tsconfig.json` 開了 `erasableSyntaxOnly`，型別檢查會擋下。
- **`src/core/` 必須維持純粹。** 不用 `fs`、`path`、`window`、`fetch`；需要 I/O 就用參數注入。這樣網頁、CLI 與測試都能共用。
- **不要改資料契約。** `src/core/types.ts` 的型別形狀是所有 `trip.ts`、技能與網頁共同的契約，需要改動請先開 issue。
- **網頁只能透過開發伺服器 API 改檔，** 而且只能做 `source-edit.ts` 提供的幾種外科手術式編輯（見架構文件）。不要讓網頁整檔重新序列化 `trip.ts`。
- **使用者看得到的文字用繁體中文。** 程式碼識別字用英文。
- **不編造數字。** 價格、營業時間、交通時間必須是帶 `source` 與 `fetchedAt` 的 `Sourced`；沒有來源就不要放。這條也適用於範例檔與文件。
- **沒有商業行為。** 不加帳號、聯盟連結、抽成或代收款。TripCode 不付款：`src/purchase/` 只剩價格與開賣日的監控、在 TripCode 自己的 Chrome 讀頁面；不要加任何處理卡號、密語或代為付款的程式。（2026-11-04 下架的付款層有一份備份在專案外，見 CHANGELOG。）
- 技能（`.claude/skills/*/SKILL.md`）是給模型讀的規格，描述的行為必須和程式碼一致；改了程式碼行為，同一個 PR 裡更新對應的技能與 `docs/SPEC.md`。

## 貢獻目的地指南 `destinations/<country>.md`

目的地指南是 `create-trip` 規劃前會讀的共用知識（區域、據點、交通與票券邏輯、季節限制、常見錯誤）。我們寧可有空白，也不要有看起來很有自信的錯誤。

1. 檔名是英文小寫 kebab-case 的國家名，例如 `japan.md`、`new-zealand.md`；它必須等於行程檔裡的 `destination: 'japan'`。
2. **每一條事實都要附來源網址與查證日期**，格式：

   ```md
   - 山區纜車與景點夏季開放期通常有限制，出發前以營運方官網為準。（來源：<url>，查證於 2026-10-16）
   ```

3. 優先用**官方**來源：觀光局、國家或地區的鐵路與大眾運輸業者、景點官網、政府旅遊警示。部落格與社群貼文只能啟發「常見錯誤」，並標註 `（社群/部落格經驗，未官方證實）`，不可用在價格、班次或規則上。
4. 價格會變：優先寫規則與結構，不寫數字；一定要寫時附幣別、單位、來源與日期。
5. 查不到的寫「待查證」，不要推測。
6. 結構請參考 `.claude/skills/create-destination/SKILL.md`。也可以請 Claude Code 用 `create-destination` 技能起草，但**你必須自己打開來源核對**；AI 起草的內容在你查證之前不算數。
7. 在 PR 描述列出你查證過的來源與日期。

## 貢獻範例行程

放在 `trips/<kebab-case-id>/`，通過 `npm run check -- <id>` 與 `npm run typecheck`。範例行程只能含你能查證的內容：**座標標明為約略值，不放價格、營業時間或時間長度**，除非附有來源。參考 `trips/tokyo-sample/`。不要在範例檔放真實的訂位代號、護照或付款資訊。

## Commit 與 PR

- 使用 [Conventional Commits](https://www.conventionalcommits.org/)：`feat(cli): …`、`fix(core): …`、`docs: …`、`chore: …`、`test: …`。範圍可選，用目錄名（`core`、`viewer`、`cli`、`skills`）。
- 標題用祈使句、英文或繁體中文皆可，一個 commit 做一件事。
- PR 說明請寫：改了什麼、為什麼、怎麼驗證（貼 `npm test` 與 `npm run typecheck` 結果）、沒驗證的部分。
- 小步提交；不要在同一個 PR 混入無關的格式化或重新命名。

## 行為準則

保持友善、對事不對人。這是一個義務性質的非營利專案，請對維護者與其他貢獻者多一點耐心。
