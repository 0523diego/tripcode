import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { countBlocks, formatDay, renderTrip, richText, stripMarkers } from './notion-render.ts';
import type { Trip } from '../src/core/types.ts';

const trip: Trip = {
  title: '瑞士',
  start: '2026-05-02',
  end: '2026-05-03',
  tz: 'Europe/Zurich',
  party: { adults: 2, childrenAges: [5] },
  days: [
    {
      date: '2026-05-02',
      title: '露臺恩',
      items: [
        { id: 'bridge', kind: 'poi', title: '卡貝爾橋', start: '09:30', note: '拍照', attachments: [{ file: 'tickets/a.pdf', label: '票' }, { file: 'tickets/b.png', label: '圖' }, { file: 'tickets/c.pkpass', label: '卡' }] },
        { id: 't', kind: 'transit', mode: 'train', title: '火車', start: '10:30' },
      ],
    },
    { date: '2026-05-03', items: [] },
  ],
  candidates: [{ id: 'c', title: '獅子碑', status: 'accepted', day: 2, sources: ['manual'], why: '值得' }],
};

describe('richText', () => {
  test('splits at 2000 characters and keeps link/annotations on each piece', () => {
    const rt = richText('字'.repeat(4500), { link: 'https://x.test', bold: true });
    assert.deepEqual(rt.map((r) => r.text.content.length), [2000, 2000, 500]);
    assert.ok(rt.every((r) => r.text.link?.url === 'https://x.test' && r.annotations?.bold));
  });
  test('does not cut surrogate pairs; over-long links become plain text', () => {
    const rt = richText('😀'.repeat(2001), { link: 'https://x.test/' + 'a'.repeat(2000) });
    assert.equal(Array.from(rt[0]!.text.content).length, 2000);
    assert.equal(rt[0]!.text.link, undefined);
  });
});

describe('renderTrip', () => {
  const blocks = renderTrip({ trip, issues: [{ level: 'warn', code: 'x', message: 'm' }], mapsLinks: (d) => (d.items.length ? ['https://maps.test/1'] : []), syncedAt: '2026-05-01 18:00' });
  test('structure', () => {
    assert.deepEqual(blocks.map((b) => b.type), ['callout', 'heading_2', 'paragraph', 'bulleted_list_item', 'bulleted_list_item', 'heading_2', 'heading_2', 'bulleted_list_item']);
    const summary = (blocks[0] as any).callout.rich_text[0].text.content;
    assert.match(summary, /1 個警告/);
    assert.match(summary, /最後同步：2026-05-01 18:00/);
    assert.match(summary, /5 歲/);
    assert.equal((blocks[1] as any).heading_2.rich_text[0].text.content, 'Day 1 · 05/02（六） 露臺恩');
    assert.equal((blocks[6] as any).heading_2.rich_text[0].text.content, '候選景點');
  });
  test('item row, note child, attachments by extension, transit gray', () => {
    const li = (blocks[3] as any).bulleted_list_item;
    assert.equal(li.rich_text.map((r: any) => r.text.content).join(''), '09:30 卡貝爾橋');
    assert.deepEqual(li.children.map((c: any) => c.type), ['paragraph', 'pdf', 'image', 'file']);
    assert.equal(li.children[1]._attach.file, 'tickets/a.pdf');
    assert.ok((blocks[4] as any).bulleted_list_item.rich_text.every((r: any) => r.annotations.color === 'gray'));
  });
  test('stripMarkers and countBlocks', () => {
    assert.equal(countBlocks(blocks), 8 + 4 + 1);
    assert.ok(!JSON.stringify(stripMarkers(blocks)).includes('_attach'));
  });
  test('formatDay', () => assert.equal(formatDay('2027-06-12', 1), 'Day 1 · 06/12（六）'));
});
