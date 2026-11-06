# Changelog

格式參考 [Keep a Changelog](https://keepachangelog.com/)。版本號對應 `PROGRESS.md` 的里程碑；日期為 git tag 當日。

## Unreleased

### Added (找方向、封面、訂票清單卡片、每個行程各自的 AI 對話，2026-11)

- **第 0 步「找方向」**：新增旅程先進到一顆從太空看的衛星地球（NASA 影像，原生 WebGL、沒有新增套件），用問題卡片與 AI 面板找到目的地與日期。答案與候選存在 `trips/<id>/idea.json`（`src/core/idea.ts`：純函式、有驗證、下一步由檔案算出）；網頁與 AI 共用同一份檔案，頁面透過 HMR 事件更新、不會整頁重載。選定後建立行程，並把預算、同行、喜好預先寫進 `brief.md`。新增 `tripcode idea …` 指令、`find-destination` 技能與 `docs/FIND-DESTINATION.md`；舊的「新增旅程」表單保留為「已經決定去哪和日期」。
- **自訂封面照片**：首頁每張行程卡可以換成自己的照片（瀏覽器縮成 ≤ 1200 px 的 JPEG，存成 `trips/<id>/cover.jpg`，不離開你的電腦）。
- **訂票清單改成卡片**：依城市分組（`Day.city`，沒有就用當晚住宿），緊急程度用左邊色條，細節收在「更多」裡。
- **每個行程各自的 AI 對話**：AI 面板依目前行程挑對話，歷史只列這個行程的。

### Removed (下架 AI 付款，2026-11-04)

- **AI 付款整層下架**：`tripcode buy pay`、`buy vault`（卡片保管庫、自動付款）、購買意圖單、付款帳本、Chrome 填卡、採購辦公室的四位角色與看板、`buy-tickets` 技能，以及 AI 助手面板對 `buy pay` 的攔截，全部從 tripcode 拿掉。TripCode 現在專注在整理訂票清單、官方連結與推薦訂什麼，買票由使用者在賣家頁面自己完成；AI 不付款、不碰卡號。
- **完整備份在專案外**：維護者另存的整份專案快照（加上只含付款相關檔案的資料夾，附 README 說明怎麼放回去）。
- **留下來的不是付款**：`buy watch` / `scan` / `alerts`（開賣日提醒、價格監控，`--render` 讀 JavaScript 頁面）、`buy browser`（在 TripCode 自己的 Chrome 讀頁面，`booking-checklist` 用）。辦公室頁面底部的「盯價與開賣提醒」區顯示這些。
- 下面「Added (盯價、開賣提醒、購買意圖單與付款)」記的是 11/03 做的、現已下架的功能，保留作為歷史紀錄。

### Added (常駐背景服務)

- `tripcode service install`：把 TripCode 的開發伺服器裝成 macOS 的背景服務（launchd），登入電腦就自動啟動、掛掉會自動重開，固定在 `http://localhost:5288`，不用再開終端機或請 AI 幫忙開。`service status | restart | logs | uninstall` 管理它。只聽本機（localhost），不要加 `--host`：這個伺服器能改你的行程檔、也跑 AI 面板的工具。必須是開發伺服器而不是建置後的版本，因為編輯、復原、AI 助手和訂票清單的按鈕都靠它。目前只支援 macOS。

### Added (規劃協議 v1：固定的五個步驟與規則)

- **固定的五個步驟**：盤點 → 排行程 → 審稿 → 訂票 → 出發前。「現在在第幾步」由檔案計算，不是 AI 或人宣告：前面的步驟都完成、而且這一步自己的條件成立，才算完成。`tripcode ready <旅程> --pretty` 會印出五個步驟、現在在哪一步、下一步和該用的技能；訂票清單頁頂端有同樣的步驟條，以及「請 AI 做這一步」按鈕。
- **每天一定要有住宿點**：每一晚都要有住宿（每天地圖與清單的起點和終點都是住宿），所以這一條放在第 2 步「排行程」，沒有住宿的夜晚會擋住這一步。還沒訂也要先放一個「住宿（待選）」，這樣那天才有起點和終點，訂票清單會把它列成還沒訂。
- **`plan-trip` 技能（協議本體）**：每個規劃請求先走它。固定的有：流程（不跳步）、衝突時的優先序（已鎖定 > 有預約時段 > 營業時間 > 順路 > 口味）、資訊來源優先序（官方 > 官方授權票務 > 轉售商 > 部落格）、決定卡（最多 3 個選項，同樣的欄位，附建議與理由）、固定的回覆格式（現在在第幾步／這次做了什麼／需要你決定／我沒辦法確認的／下一步）、完成前的自我檢查。不固定的是選哪些景點、節奏、口味，這些永遠由你決定。
- **「這天就這樣」**：看過提醒、就是想這樣排的日子，按一下就會在那天寫上 `accepted`，那一條提醒不再出現，也不會卡住「審稿」這一步；可以 ⌘Z 復原。
- **每天結構的規則變成程式檢查**（只有提醒，不是錯誤；數字集中在 `PLAN_RULES`）。一開始我用「點的數量」當門檻，被你指出不對：兩個景點相隔 200 公尺和相隔 8 公里負擔完全不同。改成看**距離與時間**，不需要地圖服務：用每個地點已有的座標算相鄰兩點的直線距離（乘 1.3 當街道的繞路），超過每天走路上限（`profile.md` 寫的，沒寫就 8 公里）提醒；一天的白天扣掉航班（加落地後一小時）、固定的火車時間、移動與走路後，平均每個點不到約 50 分鐘提醒；連續 5 天都用掉上限的 75% 以上提醒「沒有輕鬆的一天」。超過 3 公里的兩點不算走路，沒安排交通就照直線估算並明說。每個估算都會寫出它沒算到什麼（沒座標的地點、沒填起訖時間的航班）。每一項要預約的都要有確認過的官方連結或明說找不到。

### Added (訂票清單、吃飯空檔、出發準備度)

- **採購辦公室改成「訂票清單」**（行程標頭的「訂票清單」按鈕）：從行程自動推導要買的東西（機票、住宿、城際交通、備註寫著「尚未訂票」「要預約」的景點、沒有住宿的夜晚），每一列說明為什麼列出，並依急迫度分成「現在就要處理／這個月內／之後」。每列三個購買連結：**官方**（確認過的購票頁、官網首頁，或標明是搜尋的連結）、**Klook**、**Trip.com**；Klook 與 Trip.com 預設是帶 `site:` 的 Google 搜尋，只有 AI 讀過具體商品頁才會是商品連結。轉售商不會被當成官方，連結一律沒有追蹤或聯盟參數。按「我買好了」（可記下在哪裡買、入場時間）會把該項標成已買並鎖定，一次 ⌘Z 全部復原。
- **吃飯空檔**：找出還沒決定的午餐與晚餐（缺這一餐，或只有「待選」佔位），顯示前後景點與住宿，一鍵開 Google 地圖搜尋附近餐廳；選好後貼回地圖連結（或店名），就補進行程（填進佔位或新增一餐，含座標）。排序與評分要用 Google Places 資料，放下一階段。
- **出發準備度**：`tripcode ready <tripId>` 與頁面頂端的卡片。空殼行程、空白的一天、必須預約還沒買、開賣與截止日逼近、沒有住宿的夜晚、還沒決定的餐、沒有座標或交通時間沒查證，都會被點出來（只有警告與提醒，不影響健檢結果）。`tripcode bookings <tripId>` 輸出訂票清單。
- `Booking` 型別（`trip.ts` 的項目上的 `booking` 欄位）與三個新技能：`booking-checklist`（補官方連結與開賣日、截止日、取消條件，附來源）、`review-trip`（審稿：最多 7 條，附證據、信心與不處理的代價）、`fill-meals`。AI 助手的預設工作改成審稿與補強；價格監控與代付只在你明講時才用，原本的角色、看板與保管庫收進頁面的「進階」區。
- 以你的義大利行程驗證：訂票清單剛好列出 7 項待買（米蘭大教堂、萬神殿、競技場、學院美術館、佛羅倫斯圓頂、烏菲茲、最後的晚餐），機票、住宿、火車、La Scala、梵蒂岡列為已買；吃飯空檔 14 個；威尼斯顯示「空殼」且缺 3 晚住宿。

### Added (盯價格、開賣提醒、購買意圖單與付款)

- 新增可選的本機「購買」功能，`tripcode buy …`（沒有任何新依賴、帳號或伺服器）。**盯價格**：`buy watch add` 指定網址與目標價／降幅，`buy scan`（`--all`、`--loop`，或自己排 cron／launchd）依各自的間隔（至少 60 分鐘）讀頁面，從 JSON-LD、商品 meta 或你給的 regex 取價，絕不從零散文字猜價格；達到目標價、降價、「現在可以買了」、開賣前 24 小時與開賣當下、連續讀不到都會產生提醒（`buy alerts`）。
- **購買意圖單**：你說「好，買第二個」，AI 用 `buy intent add` 記下商家、含稅總價與條件（預設 48 小時有效），不能付款。**付款只有你能做**：在自己的終端機執行 `tripcode buy pay <tripId> <意圖單>`，輸入保管庫密語、看到商家／金額／卡末四碼／剩餘預算後輸入「付款」，TripCode 開啟專用的 Chrome，等你走到付款頁，核對頁面總額和你同意的價格一致（不一致就什麼都不填），再把卡號填進去（支援 Stripe 這類跨程序 iframe）。預設由你按最後一下並完成 3-D Secure；`buy vault policy --auto-submit` 才會自動按。
- **卡片保管庫**：卡號與花費規則（總預算、單筆上限、允許的網域、價格容許誤差）用密語加密（AES-256-GCM + scrypt）存在 `~/.tripcode/`，不在專案資料夾、不進 git、不進 AI 的對話。密語只能在真正的終端機輸入，AI 透過工具執行指令時沒有終端機，所以打不開。AI 助手面板另外直接拒絕 `buy pay`、`buy vault` 與讀取 `~/.tripcode/`。
- **自動付款（Autopilot）**：你在自己的終端機執行一次 `tripcode buy vault autopilot on`（輸入密語），之後 AI 可以用 `tripcode buy pay <旅程> <意圖單> --auto` 自己付款，不需要密語與確認，並會自動按付款鈕；仍受總預算、單筆上限、允許網域與付款頁總額核對限制。卡號由 TripCode 自己的程式填入，AI 不會看到。`buy vault autopilot off` 隨時關閉。新增 `tripcode buy browser open|tabs|text|links|click|type|press|shot`，讓 AI 操作 TripCode 自己的 Chrome 走到付款頁。AI 助手面板仍然拒絕 `buy vault`、沒有 `--auto` 的 `buy pay` 與讀取 `~/.tripcode/`。
- **採購辦公室**（`#/trip/<id>/office`，行程頁標頭的「採購辦公室」按鈕）：一個跳出地圖的專屬頁面，盯價員、瀏覽員、採購員、帳房四位角色依真實資料顯示狀態（待命／工作中／需要你／完成／卡住了）和對話泡泡，下面是看板（盯價中 → 等你決定 → 付款中 → 已付款）、提醒、即時動態，右側是「開張準備」引導（保管庫、Chrome、第一個盯價、選用的自動付款；完成會自動打勾，並附上可複製的終端機指令）與 AI 助手。按鈕只有「現在看一次」、全部已讀、取消尚未付款的購買單、關閉自動付款；兩種用法都支援：只請 AI 找、自己結帳（只要前兩步，沒有保管庫就不會出現帳房，購買單改成「前往結帳頁」和「我買好了」），或也請 AI 結帳（再做選用的第 3、4 步：保管庫、自動付款）。沒在工作的角色會閉眼睡覺、變暗並飄 z。沒有任何會付款或動到預算的入口；只顯示真實資料，沒有範例模式。動態來自 `~/.tripcode/activity.jsonl`（只記主機名稱、按鈕文字、金額，不記輸入內容或卡號）。`buy browser shot` 在填過卡號後 10 分鐘內拒絕截圖。
- **用 Chrome 讀價格**：`buy watch add … --render` 讓定時掃描用 TripCode 自己的 Chrome 載入頁面（背景分頁、讀完就關；Chrome 沒開時用無頭模式啟動、結束後關掉），等 JavaScript 跑完再讀價格，所以由 JavaScript 產生價格的頁面也能盯。同意頁由你在 Chrome 視窗自己點一次，之後會記住。價格讀不到時，錯誤訊息會告訴你該加 `--render` 或去點同意。技能同步修正：讀價格一律用 `buy browser` 而不是一般網頁讀取；**機票不再叫 AI 去盯**，改給 Google Flights 連結請你用它內建的「追蹤價格」。
- 新技能 `buy-tickets`；`CLAUDE.md`、`CONTRIBUTING.md`、`README`、`find-prices` 等原本寫「不做付款」的地方改成「不代收款、不抽成、AI 不碰卡」。詳見 `docs/SPEC.md` 的 v1.5。**已驗證**：價格抽取、排程與提醒、保管庫加解密、政策與預算、付款流程、CLI，以及在真實 Chrome（headless）對假結帳頁（含跨程序 iframe）填卡；**未驗證**：真實商家（Klook、Trip.com 等）的付款頁、有頭 Chrome 的實際操作、Windows。

### Added (直接改文字、復原／重做)

- 行程清單的項目可以就地編輯：雙擊名稱（或選到那一列按 F2）改名稱，雙擊左邊的時間改開始時間。Enter 或點到別處儲存，Esc 取消；時間可以打 `930`、`9:30`、全形數字，自動整理成 `09:30`；名稱不可為空、最多 120 字。寫入沿用 `item-field`，所以 trip.ts 只會多一行最小的 diff。
- 標頭多了復原／重做按鈕，也支援 ⌘Z／⇧⌘Z（Ctrl+Z／Ctrl+Y）；在輸入框裡仍是瀏覽器自己的打字復原。復原會把畫面帶回被改的那一天與項目。涵蓋改名稱／時間／欄位、移動、排入行程、刪除、上鎖、候選狀態、留言、新增景點。
- 安全的復原：伺服器記下每次寫入前後的檔案全文，只有在檔案「還是那次編輯的結果」時才還原。如果 AI 助手或編輯器在這之後改過檔案，不會蓋掉它們，而是告知並清掉過期的歷史。歷史存在 dev server 記憶體，重啟後清空；上傳票券、收件匣、新增旅程不在復原範圍。新端點：`undo`、`redo`、`history`（見 docs/SPEC.md）。

### Added (AI 助手面板)

- viewer 左上角多一顆「AI 助手」：在網頁裡直接跟 Claude Code 對話，請它改這趟行程。它看得到你正在看的行程、第幾天、選了哪個景點（「把這一天排鬆一點」不用再說是哪天），改的是 `trips/` 底下的檔案，畫面隨即更新。技術做法跟 open-slide 的 agent 面板一致：dev server 的 `/__agent` 路由（REST + SSE）、用 Claude Agent SDK 驅動本機的 Claude Code、對話存在 `node_modules/.tripcode/`。
- 面板會串流顯示回覆（Markdown）、每個工具呼叫、Claude 反問的選項卡與權限卡；可停止、可編輯先前訊息重來（回到那則訊息之前）、可切換歷史對話、選模型與思考程度。改 `trips/`、`destinations/` 不用問，其他動作（指令、上網等）要你按允許，除非開「自動允許」。
- SDK 不是預設依賴：第一次開面板會看到「安裝並連接」，按下才會用 `npm install --save-exact` 裝發布超過 7 天的最新版本。只服務本機（loopback）、套用既有的跨來源防護，正式 build 不含此功能。`TRIPCODE_AGENT=0` 可關閉。

### Changed (viewer UI/UX pass)

- 地圖在整趟的尺度下可讀：「全部」檢視把螢幕上相近的圖釘聚合成一顆（同一天用該天顏色，跨天用中性色），不再把每個標籤往外推成放射狀；文字標籤只畫在單日檢視與被選取的圖釘上，並有數量上限。選取某個停靠點不再拉到街道級，只做最小幅度平移，最多納入前後一站。沒有真實路徑資料的路線改畫虛線，圖例說明「虛線＝直線估算，非實際路線」。地圖被平移或縮放後浮出「回到這一天」。
- 手機（≤900px 或粗指標）上地圖不再吃掉單指滑動與滾輪，捲動頁面時地圖不動；要縮放用兩指或 +/− 按鈕。
- 手機版改成單一 sheet：地圖在上，行程卡片有可拖曳把手與 peek／half／full 三段高度，詳細資料改為推進 sheet 內一層（「‹ 返回行程」返回），不再用浮動卡片疊在會捲動的面板上。
- 行程清單顯示交通時長：優先用項目上已查證的 `duration`，沒有時用前後停靠點的直線估算並標成「約」，title 說明是直線估算而非實際班次。已鎖定的停靠點有實心色條，沒有時間的項目不再留空白時間欄。
- 日期條兩側加漸層與 ‹ › 按鈕（11 天的行程原本有 4 天藏在看不出來的捲動區裡）。
- rail footer 改為「還有 N 件事沒定」，底下列出已確定／候選／提醒。
- `styles.css`（2035 行）拆成 `src/viewer/styles/` 底下的分區樣式檔，由 main.tsx 依串接順序匯入；`:root` 仍留在 styles.css（model.test.ts 會讀它做對比度檢查）。樣式規則本身沒有變動。

### Changed (列印行程)

- 列印版重做。每個有座標的停靠點都附一個 QR，用手機相機掃描就會在地圖開啟該地點 —— 紙上的網址沒辦法在路邊輸入，QR 是從紙回到手機的唯一方式。
- 第一頁改為「住宿與已訂項目」：每筆住宿與已訂交通的日期、航班號、訂位代號與位置 QR，這是出狀況時會翻的那一頁。每天的標題也重複當晚住哪。
- 每一段交通顯示移動時間，與螢幕版共用同一個 `src/viewer/travel.ts`，兩邊對同一段路的說法一致，估算值一律標「約」。
- 移除列印版的路線示意圖：沒有街道也沒有可用的比例尺，印在紙上無法導航。也沒有「整天路線」的 QR —— 在路邊需要的是下一站（每一列都有），而十個途經點的 QR 要佔掉每天標題 26mm 才掃得動。
- 日期可跨頁接續（原本每天強制另起一頁，十一天印成十頁半空白），單一列不會被分頁切斷，已訂項目改用左側黑線而非顏色標示，時間區間改成起訖兩行以免壓到停靠點名稱。十一天約七頁。

### Added (viewer)

- 旅行期間打開行程會直接落在今天那一天並捲到下一個行程，另有「回到今天」；只有在不在行程日期區間內才還原上次的檢視狀態。
- 本次 session 送出的留言會被記錄，footer 顯示則數並可展開清單（檔案被改寫後標示「可能已套用」）。
- 詳細資料卡可以直接改開始／結束時間、鎖定或解除、從行程刪除（二次確認），不必每次都留言等 Claude。
- 單日檢視提供順路建議入口（唯讀），明確標示數字來自 Google Routes 或直線估算；永遠不會自動套用順序。
- 候選景點的來源若是網址即可點開。
- service worker 以 cache-first 快取 OSM 圖磚（有筆數上限），離線時地圖不再空白；仍只在正式建置啟用。

### Added (core / dev server)

- `src/core/qr.ts`：不依賴任何套件的 QR 編碼器（byte 模式、版本 1–10、EC 等級 L/M），供列印版使用。撰寫時以瀏覽器的 BarcodeDetector 實際解碼驗證。
- 純函式 `removeItem`、`setLocked` 與對應端點 `remove-item`、`set-locked`（沿用既有 guard、驗證與錯誤格式）。刪除會一併移除項目上方的 `@trip-comment`；`locked: false` 會把欄位移除而不是寫入 false。
- 唯讀端點 `optimize`：包裝既有的 `optimizeDay`，回傳目前／建議的分鐘數與順序，並標示 `source` 是 `google-routes` 還是 `haversine-estimate`。
- `check` 新增兩條提醒，兩條都刻意偏向沉默：
  - `missing-transit` —— 同一天相鄰的兩個有座標的停靠點之間沒有交通項目。直線距離超過 30 公里時只講公里數，不給分鐘數（市區速度估城際距離會算出假的交通時間）；兩端或中間有 `locked` 項目就跳過；沒有座標的 locked 項目（已訂的一日團）視為當天後續的交通。
  - `day-overload` —— 已知的停留時間加上估算移動時間超過當天第一個到最後一個有時間項目的區間。只在資訊足夠時才判斷。

### Added (viewer)

- 首頁：所有旅程以卡片列出（路線縮圖、日期、已確定／候選／待解析數量），點擊進入；左上角「‹ TripCode」或瀏覽器上一頁回到首頁。首頁可用表單直接建立新旅程。
- 手動加入景點：「行程」分頁的「＋ 加入景點」用 OpenStreetMap（有 Google 金鑰時用 Google）搜尋，選擇後成為候選景點或直接指定第幾天。
- 票券與文件：已確定項目與詳細資料卡可上傳 PDF／圖片／pkpass（≤ 15 MB），存於 `trips/<id>/tickets/`（不進 git），可開啟與移除；`export notion` 會一起同步到 Notion。
- dev server 新增 `search`、`add-candidate`、`attach`、`detach`、`new-trip` 端點。

### Added (reorder and schedule, dev-server)

- 新端點 `move-item`（同日換順序、跨日搬移，保留項目上方的 `@trip-comment`）與 `schedule-candidate`（候選地點直接排入某天）；`source-edit` 新增 `moveItem`、`insertItem`、`scheduleCandidate`。
- 變更：`add-candidate` 帶 `day` 時改為直接在該天最後加入一個 `poi` 項目（回傳 `scheduled: true`），不再建立 accepted 候選。

### Added

- `tripcode export notion <tripId> [--file x.ts] [--parent <pageId>] [--dry-run]`：把行程同步成 Notion 頁面，手機上就能看（每日標題、時間列、備註、Google 地圖路線連結、候選景點，以及用 Notion File Upload API 上傳的票券附件）。可重複執行：同一頁面會被改寫，未變動的附件不重傳；頁面 id 與附件雜湊存在 `trips/<id>/.notion.json`（已被 git 忽略）。需要 `NOTION_TOKEN` 與 `NOTION_PARENT_PAGE_ID`（見 `.env.example`、README）。使用 Notion-Version 2026-03-11；尚未用真實 Notion 帳號驗證。新增 `sync-notion` 技能。

## v1.0.0 — 2026-10-16

首個開源釋出版本。

### Added

- 檢視器不需金鑰也有真實地圖：互動地圖改用 Web Mercator 並疊上 OpenStreetMap 圖磚（瀏覽器端轉為深色，標示來源；`VITE_MAP_TILES` 可改為 `none` 或其他圖磚網址）。新增「Google 預覽」模式，以 Google 嵌入網址顯示選取地點或當天路線，並可在 Google 地圖開啟；這是 Google 未正式公開的嵌入方式，不顯示 TripCode 圖釘。
- 有 Google 金鑰時仍自動切換為完整的 Google 地圖整合。
- `osm:` 等非 Google 的地點 id 不再被當成 Google place_id 送出（地圖連結與 .ics 改用座標）。
- 免 API key 路徑：`places search`／`places details` 預設改用 OpenStreetMap Nominatim（沒有 `GOOGLE_MAPS_API_KEY` 時；`--provider google|osm` 可指定），遵守使用政策（描述性 User-Agent、每秒最多 1 次）。結果 `source` 為 `openstreetmap-nominatim`，id 形如 `osm:way/123`（不是 Google place id）；`osm:` 的 opening_hours 只解析簡單格式，其餘放 `hoursRaw`。沒有 key 的 `routes` 回傳標示為 `haversine-estimate` 的直線估算。缺 key 改為資訊提示，不再是錯誤。Google key 變成可選升級。資料 © OpenStreetMap contributors。
- `tripcode new <tripId> --title … --start … --end … --tz …`（`npm run new-trip`）：建立新旅程的空殼 `trips/<id>/`（`trip.ts`、`brief.md`、`inbox/`），驗證 id、真實日期、時區與人數，已存在時拒絕覆寫。`onboard-trip` 與 `create-trip` 技能改為使用它。
- 第二個示範行程 `trips/tokyo-sample/`：東京 4 天、2 位成人加 1 位 6 歲小孩，含 2 個候選地點與 1 則待解析的匯入方塊。座標為約略值，刻意不含價格、營業時間與時間長度。
- 文件：重寫 `README.md`（繁體中文為主，附英文摘要）、`docs/GUIDE.md`（端到端教學）、`docs/ARCHITECTURE.md`（架構與設計決定）、`CONTRIBUTING.md`、本檔 `CHANGELOG.md`。

### Changed

- 檢視器重新設計為全黑、以地圖為主的介面：地圖鋪滿整個畫面，左側一張浮動卡片收納「行程／已確定／匯入」三個分頁，取代原本同時攤開的資訊表格、匯入欄、時間軸與圖例。詳細資料在選取時才從右側浮出；圖例收成按鈕；健檢結果改為卡片底部的狀態點。
- 時間軸改為單一行程清單（時間・連線節點・名稱），交通段縮成細行，只列 1 小時以上的空檔；拿掉與清單重複的時間條圖。分頁底部列出候選景點。
- 地圖保留浮動卡片的空間來置中，選取時不再重新縮放；地名標籤自動避讓、靠右緣時改放左側，點標籤也能選取。Google 地圖改用深色底圖。
- 只保留單一深色主題（列印版仍為白底 A4），所有文字顏色在各層底色上對比度 ≥ 4.5:1，並有測試把關。

### Fixed

- 地圖圖釘在滑鼠移入時重新排序 DOM，導致按下與放開之間節點被移動、點擊遺失（觸控裝置必定發生）。
- 檢視器同時送出多個 `current` 請求時，dev server 的暫存檔名可能相撞而回 400；暫存檔名加上隨機字尾，前端也改為去抖動並略過重複內容。

## v0.2.0 — 2026-10-16

方案比較、順路建議、列印與離線。

### Added

- `tripcode optimize <tripId> --day N`：提出某一天更短的拜訪順序，只輸出建議、不改檔。8 個以下停靠點用精確搜尋，更多用最近鄰加 2-opt；有 Google key 時用 Routes 矩陣，沒有時用直線估算（標示為參考）。已鎖定的停靠點留在原位，同時有開始與結束時間的項目視為時間窗。
- `tripcode export kml <tripId>`：匯出 KML 2.2，每天一個資料夾與路線，另有「候選景點」資料夾。
- 網頁：方案並排比較（`variant-*.ts`），顯示天數、景點、換飯店、交通段與候選數並標出差異。
- 網頁：列印版型（瀏覽器列印存成 PDF），每天含編號地圖、時間表與 Google 地圖路線連結。
- PWA：manifest 與手寫的 network-first service worker，只在正式建置（`npm run build`）啟用。
- 技能：`apply-comments`、`current-trip`、`import-inbox`、`find-prices`、`create-destination`（並與實際程式碼逐項核對）。

### Known limitations

- Service worker 邏輯以模擬環境驗證，尚未在真實瀏覽器完整驗證。

## v0.1.0 — 2026-10-16

第一個可以完成一趟真實旅行的版本。

### Added

- 資料契約 `src/core/types.ts` 與 `defineTrip`；已鎖定項目、候選地點、`Sourced` 來源值。
- 核心函式庫 `src/core/`：時間工具、行程健檢 `checkTrip`、Google Maps 路線連結、ICS 行事曆匯出、以及保守的原始碼編輯（`insertComment`、`setItemField`、`setCandidateStatus`）。
- 本機網頁：頂列與日期分頁、已確定資訊欄（可直接編輯並即時重跑健檢）、匯入欄、Google 地圖或離線 SVG 地圖（候選圖釘四種狀態）、時間軸、詳細面板與留言。
- 開發伺服器 API（`comment`、`item-field`、`candidate`、`inbox`、`current`），只允許寫入 `trips/<tripId>/`。
- CLI：`places search|details`、`routes`、`check`（含 `--live`）、`export ics|links`、`list`。
- 技能：`onboard-trip`、`create-trip`、`trip-authoring`。
- 示範行程 `trips/switzerland-2027-06/`、`profile.md`、`styles/default.md`、`destinations/switzerland.md`（結構範本，未查證）。
- 依賴以精確版本固定並提交 lockfile。
