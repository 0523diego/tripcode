// KML 2.2 export (Google My Maps / Google Earth / Organic Maps). Pure string building.
// Coordinates are written as "lng,lat,0" as KML requires.
import { dayColorSlots } from './day-colors.ts';
import type { Candidate, CandidateStatus, Item, Trip } from './types.ts';

const STATUS_LABEL: Record<CandidateStatus, string> = {
  unconfirmed: '未確認',
  accepted: '已加入',
  discuss: '待討論',
  rejected: '不去',
};

/** Same 8 colors as the viewer's --day-N variables; converted to KML aabbggrr. */
const DAY_COLORS = ['#2563eb', '#ea580c', '#15a05a', '#db2777', '#0d9488', '#b7860b', '#6d4fd8', '#b83232'];

/** Escapes text for XML and drops characters that are illegal in XML 1.0. */
export function xmlEscape(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function kmlColor(hex: string, alpha = 'ff'): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `${alpha}${b}${g}${r}`;
}

function coord(loc: { lat: number; lng: number }): string {
  return `${loc.lng},${loc.lat},0`;
}

function itemDescription(it: Item): string {
  const lines: string[] = [];
  if (it.start || it.end) lines.push(`時間：${it.start ?? ''}${it.end ? `–${it.end}` : ''}`);
  if (it.locked) lines.push('已確定（locked）');
  if (it.note) lines.push(it.note);
  return lines.join('\n');
}

function candidateDescription(c: Candidate): string {
  const lines: string[] = [`狀態：${STATUS_LABEL[c.status]}`];
  if (c.day !== undefined) lines.push(`預計第 ${c.day} 天`);
  if (c.why) lines.push(c.why);
  if (c.sources.length) lines.push(`來源：${c.sources.join('、')}`);
  return lines.join('\n');
}

function point(name: string, description: string, styleId: string, loc: { lat: number; lng: number }): string {
  return (
    '      <Placemark>\n' +
    `        <name>${xmlEscape(name)}</name>\n` +
    (description ? `        <description>${xmlEscape(description)}</description>\n` : '') +
    `        <styleUrl>#${styleId}</styleUrl>\n` +
    `        <Point><coordinates>${coord(loc)}</coordinates></Point>\n` +
    '      </Placemark>\n'
  );
}

export function tripToKml(trip: Trip): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  out.push('<kml xmlns="http://www.opengis.net/kml/2.2">\n');
  out.push('  <Document>\n');
  out.push(`    <name>${xmlEscape(trip.title)}</name>\n`);
  out.push(`    <description>${xmlEscape(`${trip.start} ~ ${trip.end}（${trip.tz}）`)}</description>\n`);

  const slots = dayColorSlots(trip);
  for (const slot of [...new Set(slots)].sort((a, b) => a - b)) {
    const color = DAY_COLORS[slot - 1]!;
    out.push(
      `    <Style id="day${slot}"><IconStyle><color>${kmlColor(color)}</color></IconStyle>` +
        `<LineStyle><color>${kmlColor(color, 'cc')}</color><width>4</width></LineStyle></Style>\n`,
    );
  }
  out.push(
    `    <Style id="candidate"><IconStyle><color>${kmlColor('#888888')}</color></IconStyle></Style>\n`,
  );

  trip.days.forEach((day, i) => {
    const n = i + 1;
    const styleId = `day${slots[i]}`;
    const mmdd = day.date.slice(5).replace('-', '/');
    const name = `Day ${n} · ${mmdd}${day.title ? ` ${day.title}` : ''}`;
    out.push('    <Folder>\n');
    out.push(`      <name>${xmlEscape(name)}</name>\n`);
    const located = day.items.filter((it) => it.loc !== undefined);
    for (const it of located) out.push(point(it.title, itemDescription(it), styleId, it.loc!));
    if (located.length >= 2) {
      out.push(
        '      <Placemark>\n' +
          `        <name>${xmlEscape(`Day ${n} 路線`)}</name>\n` +
          `        <styleUrl>#${styleId}</styleUrl>\n` +
          '        <LineString><tessellate>1</tessellate><coordinates>' +
          located.map((it) => coord(it.loc!)).join(' ') +
          '</coordinates></LineString>\n' +
          '      </Placemark>\n',
      );
    }
    out.push('    </Folder>\n');
  });

  const cands = trip.candidates.filter((c) => c.loc !== undefined);
  if (cands.length > 0) {
    out.push('    <Folder>\n      <name>候選景點</name>\n');
    for (const c of cands) {
      out.push(point(`${c.title}（${STATUS_LABEL[c.status]}）`, candidateDescription(c), 'candidate', c.loc!));
    }
    out.push('    </Folder>\n');
  }

  out.push('  </Document>\n</kml>\n');
  return out.join('');
}
