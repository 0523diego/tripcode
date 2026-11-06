// Test fixture only (not a real trip): a variant of the sample trip for the compare helpers.
import { defineTrip } from '../../core/types.ts';
import { sampleTrip } from './sample-trip.ts';

const [day1, day2, ...rest] = sampleTrip.days;
if (!day1 || !day2) throw new Error('sample trip needs at least two days');

export const variantFixture = defineTrip({
  ...sampleTrip,
  title: `${sampleTrip.title}・方案 B`,
  days: [
    day1,
    {
      ...day2,
      title: '改走另一條路線',
      items: [
        ...day2.items.filter((i) => i.kind !== 'poi'),
        { id: 'variant-extra', kind: 'poi', title: '多出來的景點', start: '14:00', end: '15:30', minutes: 90 },
      ],
    },
    ...rest,
  ],
  candidates: [],
});
