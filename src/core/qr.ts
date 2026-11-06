// Minimal QR encoder (byte mode, versions 1–10, EC level L/M) per ISO/IEC 18004.
//
// Why this exists: a printed itinerary is read on a street corner, and a 180-character
// Google Maps URL printed as text cannot be typed in. A QR code is the only way back
// from paper to a phone. Adding a dependency is against the project rules, and the
// encoder is small and pure, so it lives here beside ics.ts and kml.ts.
//
// Scope is deliberately narrow: byte mode only (our payloads are ASCII URLs), versions
// up to 10 (271 bytes at level L), no Kanji/alphanumeric optimisation.

export type EcLevel = 'L' | 'M';

/** Error-correction codewords per block, then [block count, data codewords per block] groups. */
interface Spec {
  ec: number;
  blocks: [number, number][];
}

/** Versions 1–10. Index 0 is version 1. */
const SPECS: Record<EcLevel, Spec[]> = {
  L: [
    { ec: 7, blocks: [[1, 19]] },
    { ec: 10, blocks: [[1, 34]] },
    { ec: 15, blocks: [[1, 55]] },
    { ec: 20, blocks: [[1, 80]] },
    { ec: 26, blocks: [[1, 108]] },
    { ec: 18, blocks: [[2, 68]] },
    { ec: 20, blocks: [[2, 78]] },
    { ec: 24, blocks: [[2, 97]] },
    { ec: 30, blocks: [[2, 116]] },
    { ec: 18, blocks: [[2, 68], [2, 69]] },
  ],
  M: [
    { ec: 10, blocks: [[1, 16]] },
    { ec: 16, blocks: [[1, 28]] },
    { ec: 26, blocks: [[1, 44]] },
    { ec: 18, blocks: [[2, 32]] },
    { ec: 24, blocks: [[2, 43]] },
    { ec: 16, blocks: [[4, 27]] },
    { ec: 18, blocks: [[4, 31]] },
    { ec: 22, blocks: [[2, 38], [2, 39]] },
    { ec: 22, blocks: [[3, 36], [2, 37]] },
    { ec: 26, blocks: [[4, 43], [1, 44]] },
  ],
};

/** Alignment-pattern centre coordinates per version (version 1 has none). */
const ALIGN: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// ---- GF(256), primitive polynomial 0x11d ---------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

/** Generator polynomial of degree `n`, highest power first. */
function genPoly(n: number): number[] {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = next[j]! ^ g[j]!;
      next[j + 1] = next[j + 1]! ^ mul(g[j]!, EXP[i]!);
    }
    g = next;
  }
  return g;
}

/** Reed–Solomon remainder: the `n` error-correction codewords for one block. */
export function ecCodewords(data: number[], n: number): number[] {
  const g = genPoly(n);
  const res = new Array<number>(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0]!;
    res.shift();
    res.push(0);
    if (factor !== 0) for (let i = 0; i < n; i++) res[i] = res[i]! ^ mul(g[i + 1]!, factor);
  }
  return res;
}

// ---- BCH codes for the format and version information --------------------------------

function bch(data: number, generator: number, dataBits: number, totalBits: number): number {
  let value = data << (totalBits - dataBits);
  const genBits = 32 - Math.clz32(generator);
  for (let i = totalBits; i >= genBits; i--) {
    if (value & (1 << (i - 1))) value ^= generator << (i - genBits);
  }
  return (data << (totalBits - dataBits)) | value;
}

/** 15-bit format information: EC level + mask, BCH(15,5), masked with 0x5412. */
export function formatBits(level: EcLevel, mask: number): number {
  const levelBits = level === 'L' ? 0b01 : 0b00;
  return bch((levelBits << 3) | mask, 0x537, 5, 15) ^ 0x5412;
}

/** 18-bit version information, BCH(18,6). Only used from version 7 up. */
export function versionBits(version: number): number {
  return bch(version, 0x1f25, 6, 18);
}

// ---- encoding ------------------------------------------------------------------------

function capacity(version: number, level: EcLevel): number {
  const spec = SPECS[level][version - 1]!;
  const data = spec.blocks.reduce((sum, [count, size]) => sum + count * size, 0);
  // Mode indicator (4 bits) plus the character count (8 bits below version 10, else 16).
  return data - (version < 10 ? 2 : 3);
}

function bitsFor(bytes: number[], version: number, level: EcLevel): number[] {
  const spec = SPECS[level][version - 1]!;
  const total = spec.blocks.reduce((sum, [count, size]) => sum + count * size, 0);
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  // Terminator, then pad to a byte boundary, then the standard alternating pad bytes.
  for (let i = 0; i < 4 && bits.length < total * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    codewords.push(byte);
  }
  for (let i = 0; codewords.length < total; i++) codewords.push(i % 2 === 0 ? 0xec : 0x11);
  return codewords;
}

/** Split into blocks, compute EC per block, then interleave data and EC as the spec requires. */
function interleave(codewords: number[], version: number, level: EcLevel): number[] {
  const spec = SPECS[level][version - 1]!;
  const data: number[][] = [];
  const ec: number[][] = [];
  let at = 0;
  for (const [count, size] of spec.blocks) {
    for (let i = 0; i < count; i++) {
      const block = codewords.slice(at, at + size);
      at += size;
      data.push(block);
      ec.push(ecCodewords(block, spec.ec));
    }
  }
  const out: number[] = [];
  const widest = Math.max(...data.map((b) => b.length));
  for (let i = 0; i < widest; i++) for (const block of data) if (i < block.length) out.push(block[i]!);
  for (let i = 0; i < spec.ec; i++) for (const block of ec) out.push(block[i]!);
  return out;
}

// ---- matrix --------------------------------------------------------------------------

type Grid = { on: boolean; fixed: boolean }[][];

function blank(size: number): Grid {
  return Array.from({ length: size }, () => Array.from({ length: size }, () => ({ on: false, fixed: false })));
}

function setFixed(grid: Grid, row: number, col: number, on: boolean): void {
  const cell = grid[row]?.[col];
  if (cell) {
    cell.on = on;
    cell.fixed = true;
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const size = grid.length;
  // Finder patterns and their separators.
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]] as [number, number][]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        setFixed(grid, top + r, left + c, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
      }
    }
  }
  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    setFixed(grid, 6, i, i % 2 === 0);
    setFixed(grid, i, 6, i % 2 === 0);
  }
  // Alignment patterns, skipping the three that would sit on a finder pattern.
  const centres = ALIGN[version - 1]!;
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFixed(grid, r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }
  // Reserve the format areas so data skips them. The second copy is 8 modules along row 8
  // but only 7 up column 8, because the module above it is the fixed dark one.
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      setFixed(grid, 8, i, false);
      setFixed(grid, i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) setFixed(grid, 8, size - 1 - i, false);
  for (let i = 0; i < 7; i++) setFixed(grid, size - 1 - i, 8, false);
  setFixed(grid, size - 8, 8, true);
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const on = ((bits >> i) & 1) === 1;
      setFixed(grid, Math.floor(i / 3), size - 11 + (i % 3), on);
      setFixed(grid, size - 11 + (i % 3), Math.floor(i / 3), on);
    }
  }
}

function placeData(grid: Grid, codewords: number[]): void {
  const size = grid.length;
  let bit = 0;
  const next = (): boolean => {
    const byte = codewords[bit >> 3];
    const on = byte !== undefined && ((byte >> (7 - (bit & 7))) & 1) === 1;
    bit++;
    return on;
  };
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--; // the vertical timing pattern is never a data column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        const cell = grid[row]![col]!;
        if (!cell.fixed) cell.on = next();
      }
    }
    upward = !upward;
  }
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The four penalty rules of §7.8.3; a lower score masks the data more evenly. */
function penalty(grid: Grid): number {
  const size = grid.length;
  const at = (r: number, c: number) => grid[r]![c]!.on;
  let score = 0;
  const runs = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  runs(at);
  runs((a, b) => at(b, a));
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }
  const finder = [true, false, true, true, true, false, true];
  const quiet = [false, false, false, false];
  const matches = (get: (i: number) => boolean, start: number, pattern: boolean[]) =>
    pattern.every((want, i) => get(start + i) === want);
  for (let a = 0; a < size; a++) {
    for (const get of [(i: number) => (i >= 0 && i < size ? at(a, i) : false), (i: number) => (i >= 0 && i < size ? at(i, a) : false)]) {
      for (let b = 0; b <= size - 7; b++) {
        if (!matches(get, b, finder)) continue;
        if (matches(get, b - 4, quiet) || matches(get, b + 7, quiet)) score += 40;
      }
    }
  }
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (at(r, c)) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

function writeFormat(grid: Grid, level: EcLevel, mask: number): void {
  const size = grid.length;
  const bits = formatBits(level, mask);
  // Format bits go out most-significant first: bit 14 lands on the module next to the
  // top-left finder pattern. Writing them the other way round encodes a valid-looking
  // symbol that no scanner can read, so this order is checked against a real decoder.
  const on = (i: number) => ((bits >> (14 - i)) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFixed(grid, 8, i, on(i));
  setFixed(grid, 8, 7, on(6));
  setFixed(grid, 8, 8, on(7));
  setFixed(grid, 7, 8, on(8));
  for (let i = 9; i <= 14; i++) setFixed(grid, 14 - i, 8, on(i));
  for (let i = 0; i <= 6; i++) setFixed(grid, size - 1 - i, 8, on(i));
  for (let i = 7; i <= 14; i++) setFixed(grid, 8, size - 15 + i, on(i));
}

/**
 * Encode `text` as a QR matrix: `true` is a dark module. Throws when the text does not fit
 * in version 10 (271 bytes at level L, 213 at level M).
 */
export function qrMatrix(text: string, level: EcLevel = 'M'): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  const version = SPECS[level].findIndex((_, i) => bytes.length <= capacity(i + 1, level)) + 1;
  if (version === 0) throw new Error(`QR：${bytes.length} 個位元組超過版本 10（${capacity(10, level)}）的容量`);

  const codewords = interleave(bitsFor(bytes, version, level), version, level);
  const size = version * 4 + 17;
  let best: Grid | undefined;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = blank(size);
    drawFunctionPatterns(grid, version);
    placeData(grid, codewords);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const cell = grid[r]![c]!;
        if (!cell.fixed && MASKS[mask]!(r, c)) cell.on = !cell.on;
      }
    }
    writeFormat(grid, level, mask);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
    }
  }
  return best!.map((row) => row.map((cell) => cell.on));
}

/**
 * The dark modules of `qrMatrix` as one SVG path, horizontal runs merged. The path is drawn
 * in a `0 0 size size` user space; callers add the four-module quiet zone around it.
 */
export function qrPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r]!;
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c++;
        continue;
      }
      let run = 0;
      while (row[c + run]) run++;
      parts.push(`M${c} ${r}h${run}v1h-${run}z`);
      c += run;
    }
  }
  return parts.join('');
}
