// Things the panel's agent may never do, whatever the user clicks on a permission card: read ~/.tripcode/ (it holds
// TripCode's own Chrome profile, so cookies and sessions of every site the user signed in to there). The agent is not
// even offered the chance to try, and the user is not asked to approve something they might click through by habit.
// TripCode has no payment layer (taken out 2026-11-04); the agent never pays and never needs a card.

const PRIVATE_HOME = /(~|\$HOME|\$\{HOME\}|\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+)\/\.tripcode\b|\bTRIPCODE_HOME\b|\/\.tripcode\/(vault|ledger|chrome-profile)/;

/** A Traditional Chinese reason when the tool call must be refused outright, otherwise undefined. */
export function forbiddenForAgent(toolName: string, input: Record<string, unknown>): string | undefined {
  const text = JSON.stringify(input);
  if (PRIVATE_HOME.test(text)) {
    return '~/.tripcode/（卡片保管庫、付款紀錄、付款用的瀏覽器資料）不開放給 AI 助手。';
  }
  return undefined;
}
