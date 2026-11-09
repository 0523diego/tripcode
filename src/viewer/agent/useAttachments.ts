// The pictures waiting in the composer: each is scaled in the browser and uploaded as soon as it is added, so
// pressing 送出 only has to send their paths. Previews are local object URLs (instant, nothing to fetch back).
import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadImage } from './agent-store.ts';
import { blobToBase64, prepareImage } from './image-prep.ts';

export const MAX_ATTACHMENTS = 4;

export interface Attachment {
  key: string;
  preview: string;
  /** Set once the upload finished. */
  ref: string | null;
  error: string | null;
}

export interface Attachments {
  items: Attachment[];
  /** Server paths of the finished uploads, in order. */
  refs: string[];
  /** Something is still being scaled or uploaded. */
  busy: boolean;
  notice: string | null;
  add: (files: Iterable<File>) => void;
  remove: (key: string) => void;
  clear: () => void;
}

export function useAttachments(tripId: string | null): Attachments {
  const [items, setItems] = useState<Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(items);
  latest.current = items;
  const counter = useRef(0);

  const patch = useCallback((key: string, changes: Partial<Attachment>) => {
    setItems((list) => list.map((a) => (a.key === key ? { ...a, ...changes } : a)));
  }, []);

  const add = useCallback(
    (files: Iterable<File>) => {
      const images = [...files].filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) return;
      const room = Math.max(0, MAX_ATTACHMENTS - latest.current.length);
      setNotice(images.length > room ? `一則訊息最多附 ${MAX_ATTACHMENTS} 張圖片` : null);
      for (const file of images.slice(0, room)) {
        const key = `a${counter.current++}`;
        setItems((list) => [...list, { key, preview: URL.createObjectURL(file), ref: null, error: null }]);
        void (async () => {
          try {
            const ref = await uploadImage(await blobToBase64(await prepareImage(file)), tripId);
            patch(key, { ref });
          } catch (e) {
            patch(key, { error: e instanceof Error ? e.message : String(e) });
          }
        })();
      }
    },
    [tripId, patch],
  );

  const remove = useCallback((key: string) => {
    setItems((list) => {
      const gone = list.find((a) => a.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return list.filter((a) => a.key !== key);
    });
    setNotice(null);
  }, []);

  const clear = useCallback(() => {
    for (const a of latest.current) URL.revokeObjectURL(a.preview);
    setItems([]);
    setNotice(null);
  }, []);

  // Uploads belong to a trip's folder: switching trips (or closing the panel) drops what was waiting.
  useEffect(() => clear, [tripId, clear]);

  return {
    items,
    refs: items.flatMap((a) => (a.ref ? [a.ref] : [])),
    busy: items.some((a) => !a.ref && !a.error),
    notice,
    add,
    remove,
    clear,
  };
}
