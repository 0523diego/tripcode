/** Display name for a trip file: trip.ts → 主方案, variant-b.ts → 方案 B. */
export function variantName(file: string): string {
  if (file === 'trip.ts') return '主方案';
  const m = /^variant-(.+)\.ts$/.exec(file);
  return m?.[1] ? `方案 ${m[1].toUpperCase()}` : file;
}
