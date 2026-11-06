import { useState } from 'react';
import { GOOGLE_MAPS_KEY } from '../api.ts';
import type { MapData, MapPin } from '../model.ts';
import { GoogleMap } from './GoogleMap.tsx';
import { SvgMap } from './SvgMap.tsx';

/** Screen space covered by floating panels; the map fits its pins into the rest. */
export interface MapInset {
  left: number;
  right: number;
}

interface Props {
  data: MapData;
  selectedKey: string | null;
  onSelect: (pin: MapPin) => void;
  inset: MapInset;
}

const LEGEND: [string, string, string][] = [
  ['pin-legend day', '1', '行程點，顏色代表第幾天'],
  ['pin-legend unconfirmed', '?', '候選・未確認'],
  ['pin-legend discuss', '…', '待討論'],
  ['pin-legend accepted', '✓', '已加入，等 Claude 排進行程'],
  ['pin-legend rejected', '×', '不去'],
  ['pin-legend cluster', '5', '多個地點聚在一起，點一下放大'],
  ['pin-legend dashed', '', '虛線＝直線估算，非實際路線'],
];

const ll = (p: { lat: number; lng: number }) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/**
 * Keyless Google Maps view for the current context: the selected place, else the day's route
 * (when exactly one day is shown), else the trip's center. Returns the page URL; append
 * `&output=embed` to get the embeddable version (an unofficial but long-standing Google URL).
 */
export function googleViewUrl(data: MapData, selectedKey: string | null): string | null {
  const base = 'https://maps.google.com/maps?hl=zh-TW';
  const sel = data.pins.find((p) => p.key === selectedKey);
  if (sel) return `${base}&q=${encodeURIComponent(ll(sel))}&z=15`;
  const route = data.routes.length === 1 ? data.routes[0] : undefined;
  if (route && route.points.length >= 2) {
    const stops = route.points.slice(0, 10);
    const [first, ...rest] = stops;
    return `${base}&saddr=${encodeURIComponent(ll(first!))}&daddr=${rest.map((p) => encodeURIComponent(ll(p))).join('+to:')}`;
  }
  if (data.pins.length === 0) return null;
  const lat = data.pins.reduce((s, p) => s + p.lat, 0) / data.pins.length;
  const lng = data.pins.reduce((s, p) => s + p.lng, 0) / data.pins.length;
  return `${base}&ll=${encodeURIComponent(ll({ lat, lng }))}&z=9`;
}

export function MapPanel({ data, selectedKey, onSelect, inset }: Props) {
  const [failure, setFailure] = useState<string | null>(null);
  const [legend, setLegend] = useState(false);
  const [mode, setMode] = useState<'map' | 'google'>('map');
  const useGoogle = !!GOOGLE_MAPS_KEY && !failure;
  const viewUrl = googleViewUrl(data, selectedKey);
  const preview = !useGoogle && mode === 'google' && viewUrl;

  return (
    <section className="map-panel" aria-label="地圖">
      {useGoogle ? (
        <GoogleMap
          pins={data.pins}
          routes={data.routes}
          selectedKey={selectedKey}
          onSelect={onSelect}
          onFail={setFailure}
          inset={inset}
        />
      ) : (
        <SvgMap pins={data.pins} routes={data.routes} selectedKey={selectedKey} onSelect={onSelect} inset={inset} />
      )}

      {preview && (
        <div className="gpreview" style={{ left: inset.left }}>
          <iframe
            key={viewUrl}
            title="Google 地圖預覽"
            src={`${viewUrl}&output=embed`}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
          <div className="gpreview-bar card">
            <a className="btn" href={viewUrl} target="_blank" rel="noreferrer noopener">
              在 Google 地圖開啟 ↗
            </a>
          </div>
        </div>
      )}

      {!useGoogle && viewUrl && (
        <div className="map-mode seg" role="group" aria-label="地圖模式" style={{ left: inset.left + 12 }}>
          <button type="button" className={mode === 'map' ? 'on' : ''} aria-pressed={mode === 'map'} onClick={() => setMode('map')}>
            互動地圖
          </button>
          <button
            type="button"
            className={mode === 'google' ? 'on' : ''}
            aria-pressed={mode === 'google'}
            title="真實的 Google 地圖，顯示選取的地點或當天路線（不顯示 TripCode 圖釘，不需金鑰）"
            onClick={() => setMode('google')}
          >
            Google 預覽
          </button>
        </div>
      )}

      {failure && <div className="map-warn">{failure}，已改用離線地圖</div>}
      {!preview && (
        <div className="legend-wrap">
          {legend && (
            <ul className="legend card" id="map-legend" aria-label="圖例">
              {LEGEND.map(([cls, glyph, text]) => (
                <li key={cls}>
                  <span className={cls}>{glyph}</span>
                  {text}
                </li>
              ))}
              {data.unlocated > 0 && <li className="muted">另有 {data.unlocated} 個項目沒有座標</li>}
            </ul>
          )}
          <button
            type="button"
            className="legend-btn"
            aria-expanded={legend}
            aria-controls="map-legend"
            onClick={() => setLegend(!legend)}
          >
            圖例
          </button>
        </div>
      )}
    </section>
  );
}
