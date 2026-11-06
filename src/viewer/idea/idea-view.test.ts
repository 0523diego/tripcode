import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addPlaces, applyAnswer, choosePlace, newIdea, rejectPlace, rejectRound, setDates } from '../../core/idea.ts';
import type { Idea, IdeaAnswer } from '../../core/idea.ts';
import {
  adultsFor,
  bestMonthsText,
  canWantNow,
  cardFor,
  chipTarget,
  chipsFor,
  costView,
  dayCount,
  defaultParty,
  defaultTitle,
  ideaFocus,
  ideaPins,
  newIdeaId,
  parseAges,
  placeMeta,
  safeHref,
} from './idea-view.ts';

const now = new Date('2026-11-06T10:00:00Z');
const answer = (idea: Idea, field: string, value: unknown): Idea => applyAnswer(idea, { field, value } as IdeaAnswer, now);
const place = (id: string, extra: object = {}) => ({ id, slug: id, name: id.toUpperCase(), kind: 'country', lat: 10, lng: 20, tz: 'Europe/Zurich', why: 'w', ...extra });

function answered(): Idea {
  let i = newIdea(now);
  for (const [f, v] of [['known', { decided: false }], ['origin', '台北'], ['focus', 'scenery'], ['scenery', null], ['when', { months: [6] }], ['days', 5], ['party', null]] as const) i = answer(i, f, v);
  return i;
}

test('cardFor: the computed next step, unless a chip reopened another card', () => {
  const idea = answered();
  assert.equal(cardFor(idea, null), 'suggest');
  assert.equal(cardFor(idea, 'when'), 'when');
  assert.equal(cardFor(newIdea(now), null), 'known');
});

test('cardFor: a finished idea has no card', () => {
  const finished: Idea = { ...newIdea(now), tripId: 'x-2027-06' };
  assert.equal(cardFor(finished, null), 'done');
  assert.equal(cardFor(finished, 'when'), 'done');
});

test('canWantNow starts at focus', () => {
  assert.equal(canWantNow('known'), false);
  assert.equal(canWantNow('origin'), false);
  assert.equal(canWantNow('focus'), true);
  assert.equal(canWantNow('party'), true);
  assert.equal(canWantNow('suggest'), false);
});

test('pins: latest round without rejected places; hover and chosen decide the state', () => {
  let idea = addPlaces(answered(), [place('a'), place('b', { lat: 1, lng: 2 }), place('c')], now);
  assert.deepEqual(ideaPins(idea, null).map((p) => [p.id, p.state]), [['a', 'normal'], ['b', 'normal'], ['c', 'normal']]);
  assert.deepEqual(ideaPins(idea, 'b').map((p) => p.state), ['dim', 'active', 'dim']);
  assert.deepEqual(ideaFocus(idea, 'b'), { lat: 1, lng: 2 });
  assert.equal(ideaFocus(idea, null), null);

  idea = choosePlace(idea, 'c', now);
  assert.deepEqual(ideaPins(idea, null).map((p) => p.state), ['dim', 'dim', 'active']);
  assert.deepEqual(ideaFocus(idea, null), { lat: 10, lng: 20 });
  assert.deepEqual(ideaFocus(idea, 'b'), { lat: 1, lng: 2 }); // hover wins while the pointer is on a card
});

test('pins: hovering a place that was just rejected does nothing', () => {
  let idea = addPlaces(answered(), [place('a'), place('b', { lat: 1, lng: 2 })], now);
  idea = rejectPlace(idea, 'b', now);
  assert.deepEqual(ideaPins(idea, 'b').map((p) => [p.id, p.state]), [['a', 'normal']]);
  assert.equal(ideaFocus(idea, 'b'), null);
});

test('pins: a new round replaces the old pins; rejected ones disappear', () => {
  let idea = addPlaces(answered(), [place('a'), place('b')], now);
  idea = rejectRound(idea, now);
  assert.deepEqual(ideaPins(idea, null), []);
  idea = addPlaces(idea, [place('d'), place('e')], now);
  assert.deepEqual(ideaPins(idea, null).map((p) => p.id), ['d', 'e']);
});

test('chips: known is fixed once places exist; a chosen typed destination is not editable', () => {
  const idea = addPlaces(answered(), [place('a'), place('b')], now);
  const known = chipsFor(idea).find((c) => c.text.startsWith('目的地'))!;
  assert.equal(known.target, null);
  assert.equal(chipsFor(answered()).find((c) => c.text.startsWith('目的地'))!.target, 'known');

  let typed = answer(newIdea(now), 'known', { decided: true, place: '瑞士' });
  typed = answer(typed, 'origin', null);
  typed = answer(typed, 'wantNow', true);
  typed = addPlaces(typed, [place('ch')], now);
  const chosen = chipsFor(typed).find((c) => c.text.startsWith('選了'))!;
  assert.equal(chosen.target, null);
  assert.equal(chipTarget(idea, { step: 'when', text: 'x' }), 'when');
});

test('defaults: party, ages, title, day count', () => {
  assert.equal(adultsFor('solo'), 1);
  assert.equal(adultsFor('partner'), 2);
  assert.deepEqual(defaultParty('friends'), { who: 'friends', adults: 3, childrenAges: [] });
  assert.deepEqual(parseAges('5, 8'), [5, 8]);
  assert.deepEqual(parseAges('5、8，10'), [5, 8, 10]);
  assert.deepEqual(parseAges(''), []);
  assert.equal(parseAges('18'), null);
  assert.equal(parseAges('abc'), null);
  assert.equal(parseAges('-1'), null);
  assert.equal(dayCount('2027-06-05', '2027-06-09'), 5);
  assert.equal(dayCount('2027-06-09', '2027-06-05'), undefined);
  assert.equal(dayCount('x', '2027-06-05'), undefined);

  let idea = addPlaces(answered(), [place('ch', { name: '瑞士' })], now);
  idea = choosePlace(idea, 'ch', now);
  assert.equal(defaultTitle(idea), '瑞士');
  idea = setDates(idea, '2027-06-05', '2027-06-09', now);
  assert.equal(defaultTitle(idea), '瑞士 5 天');
  assert.equal(defaultTitle(answered()), '');
});

test('place card text: months, meta, cost badge, safe links', () => {
  const idea = addPlaces(answered(), [place('a', { bestMonths: [6, 7, 8], kind: 'region', country: '義大利', cost: { text: '約 3 萬（估計）' } }), place('b', { cost: { text: 'x', source: 'https://example.com/p?a=1', fetchedAt: '2026-11-06' } })], now);
  const [a, b] = idea.places;
  assert.equal(bestMonthsText(a!), '最適合：6–8 月');
  assert.equal(bestMonthsText(b!), undefined);
  assert.equal(placeMeta(a!), '地區 · 義大利');
  assert.equal(placeMeta(b!), '國家');
  assert.deepEqual(costView(a!), { text: '約 3 萬', estimate: true });
  assert.deepEqual(costView(b!), { text: 'x', estimate: false, source: 'https://example.com/p?a=1' });
  assert.equal(safeHref('https://example.com/p'), 'https://example.com/p');
  assert.equal(safeHref('javascript:alert(1)'), undefined);
  assert.equal(safeHref('Skyscanner'), undefined);
});

test('newIdeaId: idea-<yyyymmdd>-<4 base36>', () => {
  assert.match(newIdeaId(now), /^idea-20261106-[a-z0-9]{4}$/);
  assert.equal(newIdeaId(now, () => 0), 'idea-20261106-0000');
  assert.equal(newIdeaId(now, () => 0.9999), 'idea-20261106-zzzz');
});
