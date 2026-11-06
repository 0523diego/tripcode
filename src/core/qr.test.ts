import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ecCodewords, formatBits, qrMatrix, qrPath, versionBits } from './qr.ts';

/** Multiply two polynomials over GF(256) (highest power first). */
function polyMul(a: number[], b: number[]): number[] {
  const EXP: number[] = [];
  const LOG: number[] = [];
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  const mul = (p: number, q: number) => (p === 0 || q === 0 ? 0 : EXP[(LOG[p]! + LOG[q]!) % 255]!);
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] = out[i + j]! ^ mul(a[i]!, b[j]!);
  return out;
}

test('ecCodewords: data followed by its EC codewords is divisible by the generator', () => {
  // A Reed-Solomon codeword is a multiple of the generator polynomial, so dividing it by the
  // generator must leave no remainder. That holds for any data, which makes it a real check
  // of the arithmetic rather than a restatement of the implementation.
  const data = [...new TextEncoder().encode('TripCode 列印行程的 QR 測試向量')];
  for (const n of [7, 10, 15, 18, 22, 26, 30]) {
    const full = [...data, ...ecCodewords(data, n)];
    // Long division by the generator, which ecCodewords builds the same way.
    let g = [1];
    for (let i = 0; i < n; i++) g = polyMul(g, [1, [1, 2, 4, 8, 16, 32, 64, 128, 29, 58, 116, 232, 205, 135, 19, 38, 76, 152, 45, 90, 180, 117, 234, 201, 143, 3, 6, 12, 24, 48][i]!]);
    const rem = [...full];
    for (let i = 0; i <= rem.length - g.length; i++) {
      const factor = rem[i]!;
      if (factor === 0) continue;
      const scaled = polyMul(g, [factor]);
      for (let j = 0; j < scaled.length; j++) rem[i + j] = rem[i + j]! ^ scaled[j]!;
    }
    assert.ok(rem.every((v) => v === 0), `${n} 個 EC 碼字應整除`);
  }
});

test('formatBits / versionBits match the values printed in ISO/IEC 18004', () => {
  assert.equal(formatBits('M', 0), 0b101010000010010);
  assert.equal(versionBits(7), 0x07c94);
  assert.equal(versionBits(10), 0x0a4d3);
  // Every format string differs from every other in at least 3 bits (the BCH code's distance is 7).
  const all: number[] = [];
  for (const level of ['L', 'M'] as const) for (let m = 0; m < 8; m++) all.push(formatBits(level, m));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      let bits = 0;
      for (let b = 0; b < 15; b++) if (((all[i]! ^ all[j]!) >> b) & 1) bits++;
      assert.ok(bits >= 3, `${i}/${j} 的格式碼只差 ${bits} 個位元`);
    }
  }
});

test('qrMatrix: size, finder patterns, timing and the dark module are where the spec puts them', () => {
  const m = qrMatrix('https://maps.google.com/?q=51.49082,-0.19322');
  const size = m.length;
  assert.equal(size % 4, 1);
  assert.ok(m.every((row) => row.length === size));
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]] as [number, number][]) {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        assert.equal(m[top + r]![left + c], ring !== 2, `定位圖案 ${top},${left} 的 ${r},${c}`);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(m[6]![i], i % 2 === 0, `水平 timing ${i}`);
    assert.equal(m[i]![6], i % 2 === 0, `垂直 timing ${i}`);
  }
  assert.equal(m[size - 8]![8], true, '固定的暗模組');
});

test('qrMatrix: version grows with the payload and stops at 10', () => {
  assert.equal(qrMatrix('geo:51.5,-0.19').length, 21); // version 1
  assert.equal(qrMatrix('x'.repeat(271), 'L').length, 57); // version 10, full
  assert.throws(() => qrMatrix('x'.repeat(272), 'L'), /超過版本 10/);
  assert.throws(() => qrMatrix('x'.repeat(214), 'M'), /超過版本 10/);
});

test('qrPath: every dark module is covered exactly once by a horizontal run', () => {
  const m = qrMatrix('https://www.google.com/maps/dir/51.49082,-0.19322/51.46927,-0.45180');
  const dark = m.flat().filter(Boolean).length;
  let covered = 0;
  for (const [, run] of [...qrPath(m).matchAll(/h(\d+)v1/g)]) covered += Number(run);
  assert.equal(covered, dark);
});

test('qrMatrix: both format copies read back most-significant first and agree', () => {
  // The bit order here is the one a real decoder accepts (verified against the browser's
  // BarcodeDetector); writing it the other way round produces a symbol no scanner can read.
  for (const level of ['L', 'M'] as const) {
    const m = qrMatrix('https://maps.google.com/?q=51.49082,-0.19322', level);
    const size = m.length;
    const copyA: [number, number][] = [];
    for (let i = 0; i <= 5; i++) copyA.push([8, i]);
    copyA.push([8, 7], [8, 8], [7, 8]);
    for (let i = 9; i <= 14; i++) copyA.push([14 - i, 8]);
    const copyB: [number, number][] = [];
    for (let i = 0; i <= 6; i++) copyB.push([size - 1 - i, 8]);
    for (let i = 7; i <= 14; i++) copyB.push([8, size - 15 + i]);

    const read = (cells: [number, number][]) =>
      cells.reduce((acc, [r, c], i) => acc | ((m[r]![c] ? 1 : 0) << (14 - i)), 0);
    const value = read(copyA);
    assert.equal(read(copyB), value, '兩份格式資訊複本應一致');
    const mask = [0, 1, 2, 3, 4, 5, 6, 7].find((k) => formatBits(level, k) === value);
    assert.notEqual(mask, undefined, `格式資訊 ${value.toString(2)} 應對應某個遮罩`);
  }
});
