import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  IdeaError,
  addPlaces,
  applyAnswer,
  choosePlace,
  ideaBriefPrefill,
  ideaSummary,
  markCreated,
  newIdea,
  nextStep,
  parseIdea,
  rejectPlace,
  rejectRound,
  roundPlaces,
  setDates,
  suggestDates,
  suggestTripId,
} from './idea.ts';
import type { Idea, IdeaAnswer, IdeaParty, IdeaPlaceInput } from './idea.ts';

const T0 = new Date('2026-11-06T10:00:00.000Z');
const T1 = new Date('2026-11-06T11:00:00.000Z');

function place(id: string, over: Partial<IdeaPlaceInput> = {}): IdeaPlaceInput {
  return { id, slug: id, name: id, kind: 'country', lat: 46.8, lng: 8.2, tz: 'Europe/Zurich', why: '山多、夏天涼，和你想看山的想法吻合', ...over };
}

function ans(idea: Idea, ...answers: IdeaAnswer[]): Idea {
  return answers.reduce((i, a) => applyAnswer(i, a, T1), idea);
}

const party: IdeaParty = { who: 'friends', adults: 3, childrenAges: [] };

/** known=no path, everything answered. */
function ready(): Idea {
  return ans(
    newIdea(T0),
    { field: 'known', value: { decided: false } },
    { field: 'origin', value: '台北' },
    { field: 'focus', value: 'both' },
    { field: 'budget', value: { amount: 60000, currency: 'TWD', per: 'person' } },
    { field: 'scenery', value: { tags: ['mountains', 'food'] } },
    { field: 'when', value: { months: [4, 5] } },
    { field: 'days', value: 5 },
    { field: 'party', value: party },
  );
}

const throwsIdea = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e) => e instanceof IdeaError && (re ? re.test(e.message) : true));

describe('nextStep: known = no', () => {
  test('follows the fixed order', () => {
    let i = newIdea(T0);
    const seq: [IdeaAnswer | null, string][] = [
      [null, 'known'],
      [{ field: 'known', value: { decided: false } }, 'origin'],
      [{ field: 'origin', value: '台北' }, 'focus'],
      [{ field: 'focus', value: 'both' }, 'budget'],
      [{ field: 'budget', value: { amount: 1, currency: 'TWD', per: 'total' } }, 'scenery'],
      [{ field: 'scenery', value: { tags: ['sea'] } }, 'when'],
      [{ field: 'when', value: { months: [7] } }, 'days'],
      [{ field: 'days', value: 4 }, 'party'],
      [{ field: 'party', value: party }, 'suggest'],
    ];
    for (const [a, want] of seq) {
      if (a) i = applyAnswer(i, a, T1);
      assert.equal(nextStep(i), want);
    }
  });

  test('focus decides which of budget / scenery is asked', () => {
    const base = ans(newIdea(T0), { field: 'known', value: { decided: false } }, { field: 'origin', value: 'x' });
    assert.equal(nextStep(ans(base, { field: 'focus', value: 'budget' })), 'budget');
    assert.equal(nextStep(ans(base, { field: 'focus', value: 'scenery' })), 'scenery');
    assert.equal(nextStep(ans(base, { field: 'focus', value: 'budget' }, { field: 'budget', value: null })), 'when');
    assert.equal(nextStep(ans(base, { field: 'focus', value: 'scenery' }, { field: 'scenery', value: null })), 'when');
  });

  test('every question can be skipped with null (null counts as answered)', () => {
    const i = ans(
      newIdea(T0),
      { field: 'known', value: null },
      { field: 'origin', value: null },
      { field: 'focus', value: null },
      { field: 'budget', value: null },
      { field: 'scenery', value: null },
      { field: 'when', value: null },
      { field: 'days', value: null },
      { field: 'party', value: null },
    );
    assert.deepEqual([i.known, i.origin, i.focus, i.budget, i.party], [{ decided: false }, null, 'both', null, null]);
    assert.equal(nextStep(i), 'suggest');
  });

  test('wantNow skips everything left before suggest, from focus on', () => {
    const atFocus = ans(newIdea(T0), { field: 'known', value: { decided: false } }, { field: 'origin', value: '台北' });
    assert.equal(nextStep(atFocus), 'focus');
    assert.equal(nextStep(ans(atFocus, { field: 'wantNow', value: true })), 'suggest');
    const mid = ans(atFocus, { field: 'focus', value: 'both' }, { field: 'budget', value: null });
    assert.equal(nextStep(ans(mid, { field: 'wantNow', value: true })), 'suggest');
    // taking it back asks the remaining questions again
    assert.equal(nextStep(ans(mid, { field: 'wantNow', value: true }, { field: 'wantNow', value: false })), 'scenery');
  });

  test('wantNow is refused before the first two questions', () => {
    throwsIdea(() => applyAnswer(newIdea(T0), { field: 'wantNow', value: true }, T1), /直接推薦/);
    const k = ans(newIdea(T0), { field: 'known', value: { decided: false } });
    throwsIdea(() => applyAnswer(k, { field: 'wantNow', value: true }, T1));
  });

  test('suggest → choose → dates → finish → done', () => {
    let i = addPlaces(ready(), [place('switzerland'), place('norway'), place('japan')], T1);
    assert.equal(nextStep(i), 'choose');
    i = choosePlace(i, 'norway', T1);
    assert.equal(nextStep(i), 'dates');
    i = setDates(i, '2027-04-03', '2027-04-07', T1);
    assert.equal(nextStep(i), 'finish');
    i = markCreated(i, 'norway-2027-04', T1);
    assert.equal(nextStep(i), 'done');
  });

  test('when every place is rejected the next step is suggest again', () => {
    let i = addPlaces(ready(), [place('a'), place('b')], T1);
    i = rejectRound(i, T1);
    assert.equal(nextStep(i), 'suggest');
  });
});

describe('nextStep: known = yes', () => {
  const known = () => ans(newIdea(T0), { field: 'known', value: { decided: true, place: '瑞士' } }, { field: 'origin', value: '台北' });

  test('skips focus / budget / scenery and goes to when, days, party, then locate', () => {
    let i = known();
    assert.equal(nextStep(i), 'when');
    i = ans(i, { field: 'when', value: null });
    assert.equal(nextStep(i), 'days');
    i = ans(i, { field: 'days', value: null });
    assert.equal(nextStep(i), 'party');
    i = ans(i, { field: 'party', value: party });
    assert.equal(nextStep(i), 'locate');
  });

  test('wantNow goes straight to locate', () => {
    assert.equal(nextStep(ans(known(), { field: 'wantNow', value: true })), 'locate');
  });

  test('one place is chosen automatically, then dates', () => {
    const i = addPlaces(ans(known(), { field: 'wantNow', value: true }), [place('switzerland')], T1);
    assert.equal(i.chosen, 'switzerland');
    assert.equal(i.places[0]!.status, 'chosen');
    assert.equal(nextStep(i), 'dates');
  });

  test('several places are shown for a choice instead', () => {
    const i = addPlaces(ans(known(), { field: 'wantNow', value: true }), [place('a'), place('b')], T1);
    assert.equal(i.chosen, undefined);
    assert.equal(nextStep(i), 'choose');
  });

  test('rejecting the located place returns to locate', () => {
    let i = addPlaces(ans(known(), { field: 'wantNow', value: true }), [place('switzerland')], T1);
    i = rejectPlace(i, 'switzerland', T1);
    assert.equal(i.chosen, undefined);
    assert.equal(nextStep(i), 'locate');
  });
});

describe('addPlaces', () => {
  test('is allowed only at suggest / locate', () => {
    throwsIdea(() => addPlaces(newIdea(T0), [place('a')], T1), /還不能新增/);
    const shown = addPlaces(ready(), [place('a')], T1);
    throwsIdea(() => addPlaces(shown, [place('b')], T1), /reject-round|選一個/);
  });

  test('a new round is numbered, and the second round avoids id clashes', () => {
    let i = addPlaces(ready(), [place('a'), place('b'), place('c')], T1);
    assert.deepEqual(i.places.map((p) => p.round), [1, 1, 1]);
    i = rejectRound(i, T1);
    i = addPlaces(i, [place('d')], T1);
    assert.deepEqual(roundPlaces(i).map((p) => p.id), ['d']);
    assert.equal(i.places.length, 4);
    throwsIdea(() => addPlaces(rejectRound(i, T1), [place('a')], T1), /重複/);
  });

  test('1–5 places per round', () => {
    throwsIdea(() => addPlaces(ready(), [], T1), /1–5/);
    throwsIdea(() => addPlaces(ready(), 'x', T1));
    throwsIdea(() => addPlaces(ready(), ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => place(id)), T1), /1–5/);
    assert.equal(addPlaces(ready(), ['a', 'b', 'c', 'd', 'e'].map((id) => place(id)), T1).places.length, 5);
  });

  test('field validation', () => {
    const bad: [Partial<IdeaPlaceInput> | Record<string, unknown>, RegExp][] = [
      [{ id: 'Not Kebab' }, /id/],
      [{ id: 'a_b' }, /id/],
      [{ slug: '瑞士' }, /slug/],
      [{ slug: 'a--b' }, /slug/],
      [{ lat: 91 }, /lat/],
      [{ lat: NaN }, /lat/],
      [{ lng: -181 }, /lng/],
      [{ lng: '8' }, /lng/],
      [{ tz: 'Mars/Olympus' }, /時區/],
      [{ tz: '' }, /tz/],
      [{ why: '' }, /why/],
      [{ why: '   ' }, /why/],
      [{ why: 'x'.repeat(201) }, /過長/],
      [{ why: '兩行\n字' }, /換行/],
      [{ bestMonths: [0] }, /bestMonths/],
      [{ bestMonths: [13] }, /bestMonths/],
      [{ bestMonths: [] }, /bestMonths/],
      [{ kind: 'planet' }, /kind/],
      [{ cost: { text: 'x'.repeat(121) } }, /cost/],
      [{ cost: { text: '' } }, /cost/],
      [{ cost: { text: '約 3 萬', source: 'https://example.com' } }, /fetchedAt/],
      [{ cost: { text: '約 3 萬', fetchedAt: '2026-11-01' } }, /source/],
      [{ round: 1 }, /round/],
      [{ status: 'chosen' }, /status/],
      [{ surprise: 1 }, /surprise/],
    ];
    for (const [over, re] of bad) throwsIdea(() => addPlaces(ready(), [{ ...place('a'), ...over }], T1), re);
    throwsIdea(() => addPlaces(ready(), [null], T1));
  });

  test('accepts optional fields, and months are sorted and de-duplicated', () => {
    const i = addPlaces(ready(), [place('a', { country: '瑞士', bestMonths: [6, 5, 5, 9], cost: { text: '機票約 TWD 3 萬（估計）' } })], T1);
    assert.deepEqual(i.places[0]!.bestMonths, [5, 6, 9]);
    assert.equal(i.places[0]!.cost!.source, undefined);
    const j = addPlaces(ready(), [place('b', { cost: { text: '約 3 萬', source: 'https://example.com/fares', fetchedAt: '2026-11-06T10:00:00.000Z' } })], T1);
    assert.equal(j.places[0]!.cost!.source, 'https://example.com/fares');
  });
});

describe('choose / reject', () => {
  const three = () => addPlaces(ready(), [place('a'), place('b'), place('c')], T1);

  test('choosing a different place un-chooses the previous one (back to shown)', () => {
    let i = choosePlace(three(), 'a', T1);
    i = choosePlace(i, 'b', T1);
    assert.equal(i.chosen, 'b');
    assert.deepEqual(i.places.map((p) => p.status), ['shown', 'chosen', 'shown']);
  });

  test('a rejected place can be chosen again', () => {
    let i = rejectPlace(three(), 'a', T1);
    i = choosePlace(i, 'a', T1);
    assert.equal(i.places[0]!.status, 'chosen');
  });

  test('rejecting the chosen place clears the choice', () => {
    const i = rejectPlace(choosePlace(three(), 'a', T1), 'a', T1);
    assert.equal(i.chosen, undefined);
    assert.equal(nextStep(i), 'choose');
  });

  test('unknown place ids are refused', () => {
    throwsIdea(() => choosePlace(three(), 'zzz', T1), /找不到地點/);
    throwsIdea(() => rejectPlace(three(), 'zzz', T1), /找不到地點/);
  });

  test('rejectRound rejects the shown places of the latest round only', () => {
    let i = rejectRound(three(), T1);
    assert.ok(i.places.every((p) => p.status === 'rejected'));
    i = addPlaces(i, [place('d'), place('e')], T1);
    i = choosePlace(i, 'd', T1);
    i = rejectRound(i, T1);
    assert.deepEqual(i.places.map((p) => p.status), ['rejected', 'rejected', 'rejected', 'chosen', 'rejected']);
    throwsIdea(() => rejectRound(rejectRound(three(), T1), T1), /沒有可以換掉/);
    throwsIdea(() => rejectRound(ready(), T1), /沒有可以換掉/);
  });
});

describe('dates and markCreated', () => {
  const chosen = () => choosePlace(addPlaces(ready(), [place('a')], T1), 'a', T1);

  test('needs a chosen place', () => {
    throwsIdea(() => setDates(ready(), '2027-04-03', '2027-04-07', T1), /先選好/);
  });

  test('real dates, start <= end, at most 366 days', () => {
    throwsIdea(() => setDates(chosen(), '2027-02-30', '2027-03-02', T1), /真實存在/);
    throwsIdea(() => setDates(chosen(), '2027-4-3', '2027-04-07', T1), /YYYY-MM-DD/);
    throwsIdea(() => setDates(chosen(), '2027-04-08', '2027-04-07', T1), /不可晚於/);
    throwsIdea(() => setDates(chosen(), '2027-01-01', '2028-01-02', T1), /366/);
    assert.deepEqual(setDates(chosen(), '2027-01-01', '2027-12-31', T1).dates, { start: '2027-01-01', end: '2027-12-31' });
    assert.deepEqual(setDates(chosen(), '2027-04-03', '2027-04-03', T1).dates, { start: '2027-04-03', end: '2027-04-03' });
  });

  test('markCreated only at finish; afterwards nothing can change', () => {
    throwsIdea(() => markCreated(chosen(), 'a-2027-04', T1), /設定日期/);
    const done = markCreated(setDates(chosen(), '2027-04-03', '2027-04-07', T1), 'a-2027-04', T1);
    assert.equal(done.tripId, 'a-2027-04');
    throwsIdea(() => applyAnswer(done, { field: 'origin', value: 'x' }, T1), /已經建立/);
    throwsIdea(() => choosePlace(done, 'a', T1), /已經建立/);
    throwsIdea(() => rejectRound(done, T1), /已經建立/);
    throwsIdea(() => markCreated(setDates(chosen(), '2027-04-03', '2027-04-07', T1), 'Bad Id', T1), /kebab/);
  });
});

describe('answer validation', () => {
  const bad: [IdeaAnswer | { field: string; value: unknown }, RegExp][] = [
    [{ field: 'known', value: { decided: true } }, /known\.place/],
    [{ field: 'known', value: { decided: true, place: '  ' } }, /known\.place/],
    [{ field: 'known', value: { decided: false, place: 'x' } }, /place/],
    [{ field: 'known', value: { decided: 'yes' } }, /decided/],
    [{ field: 'origin', value: '' }, /origin/],
    [{ field: 'origin', value: 5 }, /origin/],
    [{ field: 'origin', value: 'a\nb' }, /換行/],
    [{ field: 'focus', value: 'fun' }, /focus/],
    [{ field: 'budget', value: { amount: 0, currency: 'TWD', per: 'person' } }, /amount/],
    [{ field: 'budget', value: { amount: 5, currency: 'twd', per: 'person' } }, /currency/],
    [{ field: 'budget', value: { amount: 5, currency: 'TWD', per: 'family' } }, /per/],
    [{ field: 'scenery', value: { tags: ['volcano'] } }, /tags/],
    [{ field: 'scenery', value: { tags: [] } }, /至少/],
    [{ field: 'scenery', value: { tags: ['sea'], extra: 1 } }, /extra/],
    [{ field: 'when', value: { months: [13] } }, /months/],
    [{ field: 'when', value: { months: [] } }, /至少/],
    [{ field: 'days', value: 0 }, /days/],
    [{ field: 'days', value: 2.5 }, /days/],
    [{ field: 'days', value: '5' }, /days/],
    [{ field: 'party', value: { who: 'friends', adults: 0, childrenAges: [] } }, /adults/],
    [{ field: 'party', value: { who: 'family', adults: 2, childrenAges: [18] } }, /childrenAges/],
    [{ field: 'party', value: { who: 'solo', adults: 2, childrenAges: [] } }, /一個人/],
    [{ field: 'party', value: { who: 'pets', adults: 1, childrenAges: [] } }, /who/],
    [{ field: 'wantNow', value: 'yes' }, /wantNow/],
    [{ field: 'colour', value: 'red' }, /不認得/],
  ];
  test('rejects malformed answers', () => {
    const base = ans(newIdea(T0), { field: 'known', value: { decided: false } }, { field: 'origin', value: 'x' });
    for (const [a, re] of bad) throwsIdea(() => applyAnswer(base, a as IdeaAnswer, T1), re);
  });

  test('normalises: trims, sorts and de-duplicates', () => {
    const i = ans(
      newIdea(T0),
      { field: 'origin', value: '  台北  ' },
      { field: 'when', value: { months: [5, 4, 4], text: ' 連假 ' } },
      { field: 'scenery', value: { tags: ['sea', 'sea', 'food'] } },
    );
    assert.equal(i.origin, '台北');
    assert.deepEqual(i.when, { months: [4, 5], text: '連假' });
    assert.deepEqual(i.scenery, { tags: ['sea', 'food'] });
  });

  test('an answer can be overwritten and updatedAt moves', () => {
    const i = ans(newIdea(T0), { field: 'origin', value: '台北' }, { field: 'origin', value: '高雄' });
    assert.equal(i.origin, '高雄');
    assert.equal(i.updatedAt, T1.toISOString());
    assert.equal(i.createdAt, T0.toISOString());
  });
});

describe('immutability', () => {
  test('no operation mutates its input or shares objects with it', () => {
    const start = addPlaces(ready(), [place('a'), place('b')], T1);
    const frozen = JSON.stringify(start);
    const deepFreeze = (o: unknown): void => {
      if (o && typeof o === 'object') {
        Object.freeze(o);
        Object.values(o).forEach(deepFreeze);
      }
    };
    deepFreeze(start);
    const outs = [
      applyAnswer(start, { field: 'origin', value: 'x' }, T1),
      choosePlace(start, 'a', T1),
      rejectPlace(start, 'a', T1),
      rejectRound(start, T1),
      setDates(choosePlace(start, 'a', T1), '2027-04-03', '2027-04-07', T1),
    ];
    assert.equal(JSON.stringify(start), frozen);
    for (const o of outs) assert.notEqual(o, start);
    const chosen = choosePlace(start, 'a', T1);
    assert.notEqual(chosen.places[1], start.places[1]);
  });
});

describe('parseIdea', () => {
  test('round-trips what the operations produce', () => {
    const i = setDates(choosePlace(addPlaces(ready(), [place('a', { bestMonths: [4] })], T1), 'a', T1), '2027-04-03', '2027-04-07', T1);
    assert.deepEqual(parseIdea(JSON.parse(JSON.stringify(i))), i);
    assert.deepEqual(parseIdea(parseIdea(i)), i);
  });

  test('rejects unknown keys, bad version and inconsistent files', () => {
    const base = newIdea(T0);
    throwsIdea(() => parseIdea({ ...base, mood: 'happy' }), /mood/);
    throwsIdea(() => parseIdea({ ...base, version: 2 }), /version/);
    throwsIdea(() => parseIdea(null));
    throwsIdea(() => parseIdea([]));
    throwsIdea(() => parseIdea({ ...base, createdAt: 'yesterday' }), /createdAt/);
    throwsIdea(() => parseIdea({ ...base, places: 'none' }), /places/);
    throwsIdea(() => parseIdea({ ...base, chosen: 'a' }), /chosen/);
    throwsIdea(() => parseIdea({ ...base, tripId: 'x-2027-04' }), /tripId/);
    const withPlaces = addPlaces(ready(), [place('a'), place('b')], T1);
    throwsIdea(() => parseIdea({ ...withPlaces, places: [withPlaces.places[0], withPlaces.places[0]] }), /重複/);
    const two = { ...withPlaces, places: withPlaces.places.map((p) => ({ ...p, status: 'chosen' })), chosen: 'a' };
    throwsIdea(() => parseIdea(two), /只能有一個/);
    throwsIdea(() => parseIdea({ ...withPlaces, places: [{ ...withPlaces.places[0], status: 'chosen' }, withPlaces.places[1]] }), /chosen/);
    throwsIdea(() => parseIdea({ ...withPlaces, places: [{ ...withPlaces.places[0], extra: 1 }] }), /extra/);
  });

  test('parse errors are IdeaError with Chinese messages', () => {
    try {
      parseIdea({ version: 1 });
      assert.fail('should throw');
    } catch (e) {
      assert.ok(e instanceof IdeaError);
      assert.match((e as Error).message, /[一-鿿]/);
    }
  });
});

describe('ideaSummary', () => {
  test('short zh lines per answer', () => {
    const lines = ideaSummary(ready());
    assert.deepEqual(lines, ['目的地：還沒決定', '出發地：台北', '在意：預算和風景', '預算：每人 TWD 60000', '想看：山、美食', '時間：4–5 月', '5 天', '跟朋友，3 位成人']);
  });

  test('skips, text, family with children, solo, wantNow, chosen and dates', () => {
    let i = ans(
      newIdea(T0),
      { field: 'known', value: { decided: true, place: '瑞士' } },
      { field: 'origin', value: null },
      { field: 'when', value: { months: [1, 2, 12], text: '跨年' } },
      { field: 'days', value: null },
      { field: 'party', value: { who: 'family', adults: 2, childrenAges: [5, 8] } },
    );
    assert.deepEqual(ideaSummary(i), ['目的地：瑞士', '出發地：跳過', '時間：1–2、12 月（跨年）', '天數：跳過', '跟家人，2 位成人、2 位小孩（5、8 歲）']);
    i = ans(i, { field: 'party', value: { who: 'solo', adults: 1, childrenAges: [] } }, { field: 'budget', value: { amount: 900, currency: 'EUR', per: 'total' } }, { field: 'scenery', value: { tags: [], text: '泡溫泉' } }, { field: 'wantNow', value: true });
    const s = ideaSummary(i);
    assert.ok(s.includes('一個人') && s.includes('預算：總共 EUR 900') && s.includes('想看：泡溫泉') && s.includes('直接推薦'));
    const done = setDates(addPlaces(i, [place('switzerland', { name: '瑞士' })], T1), '2027-06-01', '2027-06-05', T1);
    assert.deepEqual(ideaSummary(done).slice(-2), ['選了：瑞士', '日期：2027-06-01 ~ 2027-06-05']);
  });

  test('brief prefill carries what was answered and leaves skipped questions out', () => {
    const i = choosePlace(addPlaces(ready(), [place('a', { name: '瑞士' })], T1), 'a', T1);
    assert.deepEqual(ideaBriefPrefill(i), { destination: '瑞士', origin: '台北', party: '跟朋友，3 位成人', budget: '每人 TWD 60000', preferences: ['想看：山、美食'] });
    const skipped = ans(newIdea(T0), { field: 'origin', value: null }, { field: 'budget', value: null });
    assert.deepEqual(ideaBriefPrefill(skipped), { preferences: [] });
  });
});

describe('suggestTripId', () => {
  const withDates = (start = '2027-06-01') => setDates(choosePlace(addPlaces(ready(), [place('a', { slug: 'switzerland' })], T1), 'a', T1), start, '2027-08-09', T1);

  test('a 366-day trip is accepted', () => {
    assert.ok(setDates(choosePlace(addPlaces(ready(), [place('a')], T1), 'a', T1), '2027-01-01', '2028-01-01', T1).dates);
  });

  test('<slug>-<YYYY-MM>, then -2, -3 when taken', () => {
    assert.equal(suggestTripId(withDates(), new Set()), 'switzerland-2027-06');
    assert.equal(suggestTripId(withDates(), new Set(['switzerland-2027-06'])), 'switzerland-2027-06-2');
    assert.equal(suggestTripId(withDates(), new Set(['switzerland-2027-06', 'switzerland-2027-06-2'])), 'switzerland-2027-06-3');
    assert.equal(suggestTripId(withDates('2027-07-30'), new Set(['switzerland-2027-06'])), 'switzerland-2027-07');
  });

  test('needs a place and dates', () => {
    throwsIdea(() => suggestTripId(ready(), new Set()));
  });
});

describe('suggestDates', () => {
  const with_ = (months: number[] | null, days: number | null) => ans(newIdea(T0), { field: 'when', value: months ? { months } : null }, { field: 'days', value: days });

  test('the first listed month ahead, on a Saturday, for `days` days', () => {
    // today is Fri 2026-11-06; April 2027's first Saturday is the 3rd
    assert.deepEqual(suggestDates(with_([4, 5], 5), new Date('2026-11-06T00:00:00Z')), { start: '2027-04-03', end: '2027-04-07' });
  });

  test('picks the earliest candidate among the months, rolling into next year', () => {
    assert.deepEqual(suggestDates(with_([1, 12], 3), new Date('2026-11-06T00:00:00Z')), { start: '2026-12-05', end: '2026-12-07' });
    assert.deepEqual(suggestDates(with_([3], 2), new Date('2026-11-06T00:00:00Z')), { start: '2027-03-06', end: '2027-03-07' });
  });

  test('keeps 14 days of lead time, using a later Saturday of the current month when there is one', () => {
    // 2026-11-06 + 14 = 2026-11-20 → Saturday 11-21
    assert.deepEqual(suggestDates(with_([11], 3), new Date('2026-11-06T00:00:00Z')), { start: '2026-11-21', end: '2026-11-23' });
    // too late in November: next year
    assert.equal(suggestDates(with_([11], 3), new Date('2026-11-25T00:00:00Z'))!.start.slice(0, 4), '2027');
  });

  test('undefined without months or days', () => {
    assert.equal(suggestDates(with_(null, 5), new Date('2026-11-06T00:00:00Z')), undefined);
    assert.equal(suggestDates(with_([4], null), new Date('2026-11-06T00:00:00Z')), undefined);
    assert.equal(suggestDates(newIdea(T0), new Date('2026-11-06T00:00:00Z')), undefined);
  });
});
