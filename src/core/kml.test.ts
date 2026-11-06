import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tripToKml, xmlEscape } from './kml.ts';
import type { Trip } from './types.ts';

const trip: Trip = {
  title: 'Swiss & <Alps> "Trip"',
  start: '2027-06-12',
  end: '2027-06-13',
  tz: 'Europe/Zurich',
  party: { adults: 2, childrenAges: [] },
  days: [
    {
      date: '2027-06-12',
      title: '抵達 & 老城',
      items: [
        { id: 'a', kind: 'poi', title: '卡貝爾橋 <A&B>', start: '10:30', end: '11:30', loc: { lat: 47.0516, lng: 8.3075 }, note: '備註 "引號" & 符號' },
        { id: 't', kind: 'transit', mode: 'walk', title: '步行' },
        { id: 'b', kind: 'meal', title: "Café d'Or", loc: { lat: 47.0521, lng: 8.3059 } },
      ],
    },
    { date: '2027-06-13', items: [{ id: 'c', kind: 'poi', title: '單點', loc: { lat: 46.9, lng: 8.2 } }] },
  ],
  candidates: [
    { id: 'k1', title: '鐵力士山', loc: { lat: 46.77, lng: 8.43 }, status: 'discuss', sources: ['inbox/01.md'], why: '雪山 & 纜車' },
    { id: 'k2', title: '沒座標', status: 'unconfirmed', sources: [] },
  ],
};

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

test('xmlEscape handles the five entities and strips control characters', () => {
  assert.equal(xmlEscape(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  assert.equal(xmlEscape('a\u0000b\u0008c\nd'), 'abc\nd');
});

test('document skeleton and escaping of every text field', () => {
  const kml = tripToKml(trip);
  assert.ok(kml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">'));
  assert.ok(kml.endsWith('</kml>\n'));
  assert.ok(kml.includes('<name>Swiss &amp; &lt;Alps&gt; &quot;Trip&quot;</name>'));
  assert.ok(kml.includes('卡貝爾橋 &lt;A&amp;B&gt;'));
  assert.ok(kml.includes('備註 &quot;引號&quot; &amp; 符號'));
  assert.ok(kml.includes('Café d&apos;Or'));
  assert.ok(kml.includes('雪山 &amp; 纜車'));
  // no raw user-provided markup survived
  assert.ok(!kml.includes('<A&B>'));
  assert.ok(!kml.includes('<Alps>'));
});

test('one Folder per day plus one for located candidates, with the specified names', () => {
  const kml = tripToKml(trip);
  assert.equal(count(kml, /<Folder>/g), 3);
  assert.equal(count(kml, /<\/Folder>/g), 3);
  assert.ok(kml.includes('<name>Day 1 · 06/12 抵達 &amp; 老城</name>'));
  assert.ok(kml.includes('<name>Day 2 · 06/13</name>'));
  assert.ok(kml.includes('<name>候選景點</name>'));
  assert.ok(kml.includes('<name>鐵力士山（待討論）</name>'));
  assert.ok(!kml.includes('沒座標'), 'candidates without coordinates are skipped');
});

test('no candidate folder when no candidate has coordinates', () => {
  const kml = tripToKml({ ...trip, candidates: [trip.candidates[1]!] });
  assert.equal(count(kml, /<Folder>/g), 2);
  assert.ok(!kml.includes('候選景點'));
});

test('coordinates are lng,lat,0 and the LineString follows item order', () => {
  const kml = tripToKml(trip);
  assert.ok(kml.includes('<Point><coordinates>8.3075,47.0516,0</coordinates></Point>'));
  assert.ok(kml.includes('<coordinates>8.3075,47.0516,0 8.3059,47.0521,0</coordinates>'));
  // two located items on day 1 → a line; one on day 2 → no line
  assert.equal(count(kml, /<LineString>/g), 1);
  // transit without loc is not a placemark
  assert.ok(!kml.includes('<name>步行</name>'));
});

test('placemark description carries time and note', () => {
  const kml = tripToKml(trip);
  assert.ok(kml.includes('時間：10:30–11:30'));
});

test('is well-formed: balanced tags', () => {
  const kml = tripToKml(trip);
  for (const tag of ['Document', 'Placemark', 'Folder', 'Style']) {
    assert.equal(count(kml, new RegExp(`<${tag}[ >]`, 'g')), count(kml, new RegExp(`</${tag}>`, 'g')), tag);
  }
});

test('empty trip still yields a valid document', () => {
  const kml = tripToKml({ ...trip, days: [], candidates: [] });
  assert.equal(count(kml, /<Folder>/g), 0);
  assert.ok(kml.includes('</Document>'));
});
