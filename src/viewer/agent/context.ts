// What the agent is told the user is looking at. Same cursor as node_modules/.tripcode/current.json
// (App.tsx writes that for the current-trip skill), plus a label for the panel to show.
import type { Trip } from '../../core/types.ts';
import type { AgentTurnContext } from '../../agent/types.ts';
import { findItem } from '../model.ts';
import type { Selection } from '../model.ts';

export function agentContext(trip: Trip, view: { tripId: string; file: string; dayIdx: number | null; selection: Selection | null }): { context: AgentTurnContext; label: string } {
  const { tripId, file, dayIdx, selection } = view;
  const pick = selection?.type === 'item' || selection?.type === 'candidate' ? selection : null;
  let day = dayIdx !== null ? dayIdx + 1 : undefined;
  if (day === undefined && selection?.type === 'item') {
    const ref = findItem(trip, selection.id);
    if (ref) day = ref.dayIdx + 1;
  }
  const itemTitle = pick
    ? (pick.type === 'item' ? findItem(trip, pick.id)?.item.title : trip.candidates.find((c) => c.id === pick.id)?.title)
    : undefined;
  const context: AgentTurnContext = {
    tripId,
    tripTitle: trip.title,
    ...(file !== 'trip.ts' ? { file } : {}),
    ...(day !== undefined ? { day } : {}),
    ...(pick ? { itemId: pick.id } : {}),
  };
  const label = [trip.title, day !== undefined ? `第 ${day} 天` : '全部天數', itemTitle].filter(Boolean).join(' · ');
  return { context, label };
}
