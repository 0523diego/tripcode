// The hidden print layer on the trip page: invisible on screen, the only thing shown by the browser's print.
// No ticket pages here (they have to be converted first and this layer exists on every trip page load): the
// 列印行程 page prints those.
import { useMemo } from 'react';
import type { Trip } from '../../core/types.ts';
import { PrintDocumentView } from './PrintDocumentView.tsx';
import { buildPrintDocument } from './print-model.ts';
import { loadPrefs, mergeOptions } from './print-options.ts';

export function PrintLayer({ trip }: { trip: Trip }) {
  const doc = useMemo(() => buildPrintDocument(trip, mergeOptions(loadPrefs(), { tickets: false }), { now: new Date() }), [trip]);
  return (
    <div className="print-root" aria-hidden="true">
      <PrintDocumentView doc={doc} />
    </div>
  );
}
