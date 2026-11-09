// 行程 beside the booking list: the day-by-day plan, read-only, so you can see what a ticket is for while you buy it.
// It is the same list as on the map page (hotels, times, colors) with the editing taken out.
import { useState } from 'react';
import type { Trip } from '../../core/types.ts';
import { Itinerary } from '../components/Itinerary.tsx';
import { DayStrip } from '../components/RailHeader.tsx';
import type { Selection } from '../model.ts';

export function TripSide({ trip, onClose }: { trip: Trip; onClose: () => void }) {
  const [dayIdx, setDayIdx] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  return (
    <aside className="of-trip" aria-label="行程">
      <header className="of-trip-head">
        <div>
          <b>行程</b>
          <span className="muted">{trip.title}</span>
        </div>
        <button type="button" className="ag-icon" onClick={onClose} aria-label="關閉行程" title="關閉">
          ×
        </button>
      </header>
      <DayStrip trip={trip} dayIdx={dayIdx} onDay={setDayIdx} />
      <div className="of-trip-body">
        <Itinerary trip={trip} dayIdx={dayIdx} selection={selection} onSelect={setSelection} readOnly />
      </div>
    </aside>
  );
}
