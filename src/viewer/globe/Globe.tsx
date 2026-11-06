import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './globe.css';
import { createGlobeEngine, type Engine, type EnginePin } from './globe-engine.ts';
import dayUrl from './textures/earth-day.jpg?url';
import nightUrl from './textures/earth-night.jpg?url';

export interface GlobePin {
  id: string;
  label: string;
  lat: number;
  lng: number;
  state?: 'normal' | 'active' | 'dim';
}

export interface GlobeProps {
  pins?: GlobePin[];
  /** Turn to this point and stop auto-rotation; null/undefined = keep turning. */
  focus?: { lat: number; lng: number } | null;
  /** Fly the camera in toward focus (used right before switching to the map). */
  zoomIn?: boolean;
  onZoomDone?: () => void;
  onPinClick?: (id: string) => void;
  className?: string;
}

const NO_PINS: GlobePin[] = [];

/**
 * A satellite Earth seen from space: fills its container, turns slowly, drag to spin. Pins are HTML buttons laid over
 * the canvas and moved from the animation loop (no React render per frame).
 */
export function Globe({ pins = NO_PINS, focus, zoomIn = false, onZoomDone, onPinClick, className }: GlobeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const pinEls = useRef(new Map<string, HTMLButtonElement>());
  const [supported, setSupported] = useState(true);

  // Latest props, read from the engine's callbacks without re-creating the engine.
  const live = useRef({ pins, onZoomDone });
  useLayoutEffect(() => {
    live.current = { pins, onZoomDone };
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!supported || !canvas || !root) return;
    const buffer: EnginePin[] = [];
    const engine = createGlobeEngine({
      canvas,
      root,
      dayUrl,
      nightUrl,
      getPins: () => {
        buffer.length = 0;
        for (const p of live.current.pins) {
          const el = pinEls.current.get(p.id);
          if (el) buffer.push({ id: p.id, lat: p.lat, lng: p.lng, el });
        }
        return buffer;
      },
      onZoomDone: () => live.current.onZoomDone?.(),
      onUnsupported: () => setSupported(false),
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [supported]);

  const focusLat = focus?.lat;
  const focusLng = focus?.lng;
  useEffect(() => {
    engineRef.current?.setFocus(focusLat === undefined || focusLng === undefined ? null : { lat: focusLat, lng: focusLng });
    // `supported` is a dependency so a freshly re-created engine (after a remount) receives the current focus/zoom.
  }, [focusLat, focusLng, supported]);

  useEffect(() => {
    engineRef.current?.setZoom(zoomIn);
  }, [zoomIn, supported]);

  // Without WebGL there is nothing to fly through: report the zoom as done right away so the page can move on.
  useEffect(() => {
    if (supported || !zoomIn) return;
    const t = setTimeout(() => live.current.onZoomDone?.(), 0);
    return () => clearTimeout(t);
  }, [supported, zoomIn]);

  // New / changed pins need one more frame so they get positioned.
  useEffect(() => {
    engineRef.current?.invalidate();
  }, [pins]);

  const cls = ['globe', supported ? '' : 'globe--still', className ?? ''].filter(Boolean).join(' ');

  return (
    <div ref={rootRef} className={cls} role="group" aria-label="地球">
      {supported ? (
        <>
          <canvas ref={canvasRef} className="globe-canvas" aria-hidden="true" />
          <div className="globe-pins">
            {pins.map((p) => (
              <button
                key={p.id}
                type="button"
                className="globe-pin"
                data-state={p.state ?? 'normal'}
                aria-label={p.label}
                ref={(el) => {
                  if (el) pinEls.current.set(p.id, el);
                  else pinEls.current.delete(p.id);
                }}
                onClick={() => onPinClick?.(p.id)}
              >
                <span className="globe-pin__pulse" />
                <span className="globe-pin__dot" />
                <span className="globe-pin__label">{p.label}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="globe-fallback" style={{ backgroundImage: `url(${dayUrl})` }} aria-hidden="true" />
      )}
      <span className="globe-credit">衛星影像：NASA</span>
    </div>
  );
}
