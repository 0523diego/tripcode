// 刪除旅程: the dev server moves trips/<id>/ to .tripcode-trash/ (see the `trip-delete` endpoint). A trip's AI
// conversations go with it, so a new trip that reuses the id does not inherit the old chat.
import { post } from './api.ts';
import { getAgentState, removeSession, startAgent } from './agent/agent-store.ts';

export const deleteTrip = (tripId: string) => post('trip-delete', { tripId });

export async function dropConversations(tripId: string): Promise<void> {
  await startAgent();
  for (const s of getAgentState().sessions.filter((x) => x.tripId === tripId)) await removeSession(s.id);
}
