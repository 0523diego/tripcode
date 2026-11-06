// What the agent is told on every turn: a fixed system-prompt addendum, plus the viewer's cursor
// (which trip / day / item is on screen) so "這一天" and "這個景點" resolve without a question.
import type { AgentTurnContext } from './types.ts';

export function systemPromptAppend(askInstruction: string): string {
  return [
    '你正在 TripCode 開發伺服器的瀏覽器 agent 面板裡運作，使用者不在終端機。',
    '工作區是 TripCode 專案：行程在 trips/<id>/trip.ts（或 variant 檔），dev server 會即時重新載入，所以你每次存檔使用者都會立刻在畫面上看到。',
    '使用專案內的 skills：還沒決定去哪的人先用 find-destination（找方向）；已有目的地的新行程用 onboard-trip 再 create-trip；修改 trips/<id>/ 內任何東西先讀 trip-authoring；處理 @trip-comment 用 apply-comments；使用者說「這一天／這個景點」時用 current-trip；其餘見 CLAUDE.md。',
    '遵守 CLAUDE.md 的硬規則：不捏造價格、營業時間或交通時間；不動 locked: true 的項目（除非使用者明講）；改完行程跑 `npm run check -- <tripId>`。',
    '每個規劃請求先照 plan-trip 協議做：先跑 `npm run tripcode -- ready <tripId> --pretty` 看行程在五個步驟的第幾步，只做這一步，不要跳步，回覆用協議固定的格式（現在在第幾步、這次做了什麼、需要你決定、我沒辦法確認的、下一步）。預設工作是審稿與補強，不是重排行程：先用 `tripcode ready <tripId> --pretty` 找出風險、還沒訂的票和還沒決定的餐，附證據（審稿照 review-trip、補官方購票連結照 booking-checklist、決定吃飯地點照 fill-meals）；不要主動生成整天行程或加候選。訂票清單頁（行程標頭的「訂票清單」）是使用者買票的地方：你整理要訂什麼、官方購票連結與開賣日、取消條件，使用者自己去買。你不付款、不操作付款頁、不碰卡號，也不要求或記錄卡號與密語；要讀價格或頁面內容時用 `tripcode buy browser open/text`（會跑 JavaScript），不要用一般網頁讀取；機票不要盯，給 Google Flights 連結請使用者用它的追蹤。',
    '面板很窄：回覆簡短具體，優先直接做而不是描述，最後用一行說明改了什麼。用繁體中文。',
    askInstruction,
  ].join(' ');
}

// Trip titles and ids come from files the user (or an imported post) wrote, so they sit in their own
// tags with `<` escaped and cannot close the context block.
const escapeTag = (s: string) => s.replace(/</g, '&lt;');

export function contextLines(context: AgentTurnContext | undefined): string[] {
  if (!context?.tripId) return [];
  if (context.idea) {
    // Step 0 (找方向): there is no trip.ts yet, only trips/<id>/idea.json, which only `tripcode idea …` may change.
    return [
      `使用者正在第 0 步「找方向」：畫面是 trips/${context.tripId}/idea.json 的想法頁，還沒有行程。`,
      `照 find-destination skill 做：先跑 \`npm run tripcode -- idea show ${context.tripId} --pretty\` 看現在問到哪一步，只做這一步。`,
      'idea.json 只能用 `tripcode idea …` 指令修改，不要直接編輯檔案。',
    ];
  }
  const file = `trips/${context.tripId}/${context.file ?? 'trip.ts'}`;
  const lines = [`使用者正在檢視行程「${context.tripId}」：${file}。`];
  if (context.tripTitle) lines.push(`<trip-title>${escapeTag(context.tripTitle)}</trip-title>`);
  if (context.day) lines.push(`他們正看著第 ${context.day} 天（days 陣列的索引 ${context.day - 1}）。`);
  if (context.itemId) lines.push(`他們選了項目 id「${escapeTag(context.itemId)}」；「這個」指它。`);
  return lines;
}

export function buildTurnPrompt(text: string, context: AgentTurnContext | undefined): string {
  const lines = contextLines(context);
  if (lines.length === 0) return text;
  return `${text}\n\n<tripcode-context>\n${lines.join('\n')}\n</tripcode-context>`;
}

// For a provider whose history cannot be rewound: the edited message goes on top of the old
// conversation, so the agent is told to set that part aside.
export function editedPrompt(original: string, text: string): string {
  return `我回頭修改了之前的一則訊息。請把它之後的對話（包含你的回覆）當作作廢，改回應修改後的版本。檔案會保留已經做過的變更。\n\n<original-message>\n${escapeTag(original)}\n</original-message>\n\n${text}`;
}

// For a provider rewound to before the edited message: its history forgets the later turns, but the
// files on disk still hold what those turns wrote.
export function rewoundPrompt(text: string): string {
  return `${text}\n\n<tripcode-note>我回頭修改了這則訊息。被作廢的對話中做過的檔案變更仍然保留，編輯前請先重新讀取目前的檔案。</tripcode-note>`;
}
