// Loads every trips/<id>/*.ts (plan + variants) and trips/<id>/inbox/*.md via Vite globs.
//
// An edit on disk (the AI changing trip.ts or brief.md, you editing a file) used to make Vite reload the whole page, because nothing
// accepted the update: whatever was open (the AI panel, a selection, a half-typed message) was lost, which looked like the AI panel
// closing by itself. This module now accepts its own updates: it computes the entries again and hands them to a store that lives in
// `import.meta.hot.data` (it survives the module being replaced), and the viewer reads the entries through `useTrips()`.
import { useSyncExternalStore } from 'react';
import type { Trip } from '../core/types.ts';
import { sampleInbox, sampleTrip } from './fixtures/sample-trip.ts';

export interface TripFile {
  file: string;
  trip: Trip;
}
export interface InboxFile {
  /** e.g. "01.md" */
  file: string;
  raw: string;
}
export interface TripEntry {
  id: string;
  files: TripFile[];
  inbox: InboxFile[];
  /** trips/<id>/brief.md, when there is one (the 盤點 step checks it for 「（待填）」). */
  brief?: string;
  /** URL of trips/<id>/cover.jpg, the photo the user chose for the home page card. */
  cover?: string;
  fixture?: boolean;
}

const tripModules = import.meta.glob<{ default?: Trip }>('/trips/*/*.ts', { eager: true });
const inboxModules = import.meta.glob<string>('/trips/*/inbox/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const briefModules = import.meta.glob<string>('/trips/*/brief.md', { query: '?raw', import: 'default', eager: true });
const coverModules = import.meta.glob<string>('/trips/*/cover.jpg', { query: '?url', import: 'default', eager: true });

function isTrip(v: unknown): v is Trip {
  return !!v && typeof v === 'object' && Array.isArray((v as Trip).days);
}

function fileRank(file: string): string {
  return file === 'trip.ts' ? '0' : `1${file}`;
}

const profileModules = import.meta.glob<string>('/profile.md', { query: '?raw', import: 'default', eager: true });

/** profile.md, when there is one (its walking limit feeds the day rules). */
export function profileText(): string | undefined {
  return store.profile;
}

export function loadTrips(): TripEntry[] {
  const byId = new Map<string, TripEntry>();
  const entry = (id: string): TripEntry => {
    let e = byId.get(id);
    if (!e) {
      e = { id, files: [], inbox: [] };
      byId.set(id, e);
    }
    return e;
  };
  for (const [path, mod] of Object.entries(tripModules)) {
    const m = /^\/trips\/([^/]+)\/([^/]+\.ts)$/.exec(path);
    if (!m || !m[1] || !m[2] || m[2].endsWith('.test.ts')) continue;
    if (isTrip(mod.default)) entry(m[1]).files.push({ file: m[2], trip: mod.default });
  }
  for (const [path, raw] of Object.entries(inboxModules)) {
    const m = /^\/trips\/([^/]+)\/inbox\/([^/]+\.md)$/.exec(path);
    if (m && m[1] && m[2]) entry(m[1]).inbox.push({ file: m[2], raw });
  }
  for (const [path, raw] of Object.entries(briefModules)) {
    const m = /^\/trips\/([^/]+)\/brief\.md$/.exec(path);
    if (m && m[1] && byId.has(m[1])) entry(m[1]).brief = raw;
  }
  for (const [path, url] of Object.entries(coverModules)) {
    const m = /^\/trips\/([^/]+)\/cover\.jpg$/.exec(path);
    if (m && m[1] && byId.has(m[1])) entry(m[1]).cover = url;
  }
  const list = [...byId.values()].filter((e) => e.files.length > 0);
  for (const e of list) {
    e.files.sort((a, b) => fileRank(a.file).localeCompare(fileRank(b.file)));
    e.inbox.sort((a, b) => a.file.localeCompare(b.file));
  }
  list.sort((a, b) => a.id.localeCompare(b.id));
  if (list.length === 0) {
    list.push({
      id: 'sample-fixture',
      fixture: true,
      files: [{ file: 'trip.ts', trip: sampleTrip }],
      inbox: sampleInbox,
    });
  }
  return list;
}

// ---------- the store the viewer reads ----------

interface Store {
  entries: TripEntry[];
  profile: string | undefined;
  listeners: Set<() => void>;
}

// (Vite only recognises a literal `import.meta.hot.accept(` / `import.meta.hot.data`; an alias would make it reload the page.)
// The first module instance makes the store; every replacement of this module reuses it, so subscribers stay subscribed.
const store: Store = (import.meta.hot?.data.tripStore as Store | undefined) ?? { entries: [], profile: undefined, listeners: new Set() };
if (import.meta.hot) import.meta.hot.data.tripStore = store;
store.entries = loadTrips();
store.profile = Object.values(profileModules)[0];
for (const l of store.listeners) l();
// Take our own updates (a changed trip.ts, a new trip folder) instead of reloading the page.
if (import.meta.hot) import.meta.hot.accept();

const subscribe = (l: () => void): (() => void) => {
  store.listeners.add(l);
  return () => void store.listeners.delete(l);
};
const snapshot = (): TripEntry[] => store.entries;

/** Every trip on disk, kept current without a page reload. */
export function useTrips(): TripEntry[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
