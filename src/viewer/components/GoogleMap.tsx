// Google Maps JS renderer. Loaded only when VITE_GOOGLE_MAPS_API_KEY is set (plain <script> tag).
// Uses `any` for the google namespace because no type package is installed.
import { useEffect, useRef } from 'react';
import { GOOGLE_MAPS_KEY } from '../api.ts';
import { onVar, type MapPin, type MapRoute } from '../model.ts';
import type { MapInset } from './MapPanel.tsx';

interface Props {
  pins: MapPin[];
  routes: MapRoute[];
  selectedKey: string | null;
  onSelect: (pin: MapPin) => void;
  onFail: (reason: string) => void;
  inset?: MapInset;
}

/** Near-black basemap to match the viewer. */
const DARK_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#0b0b0c' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a8a90' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#000000' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#2a2a2e' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1c1c1f' }] },
  { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#202024' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#050608' }] },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
type G = any;

let loader: Promise<G> | null = null;
function loadGoogle(): Promise<G> {
  const w = window as unknown as Record<string, any>;
  if (w.google?.maps) return Promise.resolve(w.google);
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    w.__tripcodeMapsReady = () => resolve(w.google);
    w.gm_authFailure = () => reject(new Error('Google Maps 金鑰驗證失敗'));
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      GOOGLE_MAPS_KEY ?? '',
    )}&callback=__tripcodeMapsReady&language=zh-TW`;
    s.async = true;
    s.onerror = () => reject(new Error('無法載入 Google Maps'));
    document.head.appendChild(s);
  });
  loader.catch(() => {
    loader = null;
  });
  return loader;
}

function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#2563eb';
}

function pinIcon(g: G, pin: MapPin, selected: boolean) {
  const c = cssColor(pin.color);
  const candidate = pin.sel.type === 'candidate';
  const size = selected ? 44 : 36;
  const r = selected ? 15 : 13;
  const filled = pin.style !== 'unconfirmed' && pin.style !== 'rejected';
  const fill = filled ? c : '#000000';
  const text = filled ? cssColor(onVar(pin.color)) : c;
  const dash = pin.style === 'unconfirmed' ? 'stroke-dasharray="4 3"' : '';
  const shape = candidate
    ? `<rect x="${size / 2 - r}" y="${size / 2 - r}" width="${r * 2}" height="${r * 2}" rx="7" fill="${fill}" stroke="${filled ? '#000' : c}" stroke-width="2" ${dash}/>`
    : `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${fill}" stroke="#000" stroke-width="2"/>`;
  const ring = selected
    ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="none" stroke="#ffffff" stroke-width="2"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${ring}${shape}<text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="${pin.label.length > 1 ? 11 : 14}" font-weight="700" fill="${text}">${pin.label}</text></svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new g.maps.Size(size, size),
    anchor: new g.maps.Point(size / 2, size / 2),
  };
}

export function GoogleMap({ pins, routes, selectedKey, onSelect, onFail, inset }: Props) {
  const el = useRef<HTMLDivElement | null>(null);
  const state = useRef<{ g: G; map: G; markers: Map<string, G>; lines: G[]; fitKey: string; selKey: string | null } | null>(null);
  const latest = useRef({ pins, routes, selectedKey, onSelect, inset });
  latest.current = { pins, routes, selectedKey, onSelect, inset };

  const draw = () => {
    const st = state.current;
    if (!st) return;
    const { g, map } = st;
    const { pins, routes, selectedKey, onSelect, inset } = latest.current;
    st.markers.forEach((m) => m.setMap(null));
    st.markers.clear();
    st.lines.forEach((l) => l.setMap(null));
    st.lines = [];
    const bounds = new g.maps.LatLngBounds();
    for (const r of routes) {
      st.lines.push(
        new g.maps.Polyline({
          map,
          path: r.points,
          strokeColor: cssColor(r.color),
          // Routes are straight-line estimates between stops: draw them dashed (an invisible line carrying dash icons).
          strokeOpacity: 0,
          icons: [
            {
              icon: { path: 'M 0,-1 0,1', strokeOpacity: 0.9, strokeColor: cssColor(r.color), strokeWeight: 3, scale: 3 },
              offset: '0',
              repeat: '14px',
            },
          ],
        }),
      );
    }
    for (const pin of pins) {
      const selected = pin.key === selectedKey;
      const marker = new g.maps.Marker({
        map,
        position: { lat: pin.lat, lng: pin.lng },
        title: pin.title,
        icon: pinIcon(g, pin, selected),
        opacity: pin.style === 'rejected' ? 0.45 : 1,
        zIndex: selected ? 1000 : 1,
      });
      marker.addListener('click', () => onSelect(pin));
      st.markers.set(pin.key, marker);
      // Candidates stay out of the fit so one in another city does not keep the whole trip in frame.
      if (pin.sel.type !== 'candidate' || pins.every((p) => p.sel.type === 'candidate')) bounds.extend(marker.getPosition());
    }
    const fitKey = pins.filter((p) => p.sel.type !== 'candidate').map((p) => p.key).join('|');
    if (fitKey !== st.fitKey && pins.length > 0) {
      st.fitKey = fitKey;
      map.fitBounds(bounds, { top: 60, bottom: 60, left: (inset?.left ?? 0) + 60, right: (inset?.right ?? 0) + 60 });
      if (pins.length === 1) map.setZoom(14);
    }
    // Selecting a stop keeps the day in frame: already in view → only nudge it clear of the panels; out of view →
    // frame previous stop → this stop → next stop (never closer than street level).
    if (selectedKey !== st.selKey) {
      st.selKey = selectedKey;
      const i = selectedKey ? pins.findIndex((p) => p.key === selectedKey) : -1;
      const pin = pins[i];
      if (pin) {
        const proj = map.getProjection();
        const b = map.getBounds();
        const box = el.current;
        if (proj && b && box && b.contains({ lat: pin.lat, lng: pin.lng })) {
          const scale = 2 ** (map.getZoom() ?? 0);
          const ne = proj.fromLatLngToPoint(b.getNorthEast());
          const sw = proj.fromLatLngToPoint(b.getSouthWest());
          const pt = proj.fromLatLngToPoint(new g.maps.LatLng(pin.lat, pin.lng));
          const x = (pt.x - sw.x) * scale;
          const y = (pt.y - ne.y) * scale;
          const left = (inset?.left ?? 0) + 56;
          const right = box.clientWidth - (inset?.right ?? 0) - 56;
          const dx = x < left ? x - left : x > right ? x - right : 0;
          const dy = y < 56 ? y - 56 : y > box.clientHeight - 56 ? y - (box.clientHeight - 56) : 0;
          if (dx || dy) map.panBy(dx, dy);
        } else {
          const near = (q: MapPin | undefined) => !!q && pin.sel.type === 'item' && q.sel.type === 'item' && q.color === pin.color;
          const around = [pins[i - 1], pin, pins[i + 1]].filter((q): q is MapPin => q === pin || near(q));
          const fit = new g.maps.LatLngBounds();
          for (const q of around) fit.extend({ lat: q.lat, lng: q.lng });
          const keep = map.getZoom() ?? 15;
          map.fitBounds(fit, { top: 60, bottom: 60, left: (inset?.left ?? 0) + 60, right: (inset?.right ?? 0) + 60 });
          g.maps.event.addListenerOnce(map, 'idle', () => {
            const z = map.getZoom() ?? 15;
            if (z > Math.min(keep, 15)) map.setZoom(Math.min(keep, 15));
          });
        }
      }
    }
  };

  useEffect(() => {
    let dead = false;
    loadGoogle()
      .then((g) => {
        if (dead || !el.current) return;
        const touchy = window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
        const map = new g.maps.Map(el.current, {
          center: { lat: 47, lng: 8 },
          zoom: 8,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          // Touch/narrow screens: one finger scrolls the page, two fingers move the map (and +/- are shown).
          zoomControl: touchy,
          gestureHandling: touchy ? 'cooperative' : 'greedy',
          backgroundColor: '#000000',
          styles: DARK_STYLE,
        });
        state.current = { g, map, markers: new Map(), lines: [], fitKey: '', selKey: null };
        draw();
      })
      .catch((e: Error) => onFail(e.message));
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(draw, [pins, routes, selectedKey]);

  return <div className="gmap" ref={el} />;
}
