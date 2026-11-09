import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Item, Photo } from '../../core/types.ts';
import type { Send } from '../api.ts';

// An item's photos (trips/<id>/photos/, see cli/photo-service.ts): a strip of thumbnails at the top of the detail, 「＋ 加照片」,
// drop or paste a picture onto the panel, and a lightbox. The server decides the type from the bytes and names the file; the
// page only reads the file and, when the browser can, turns an iPhone HEIC or an oversized picture into a JPEG first.

const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic';
const MAX_BYTES = 8 * 1024 * 1024;
/** Long edge of a picture the page has to re-encode (HEIC, or over 8 MB). */
const MAX_EDGE = 2560;

export const photoUrl = (tripId: string, p: Photo): string => `/trips/${tripId}/${p.file}`;

const isHeicFile = (f: File) => /^image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name);
const isImageFile = (f: File) => f.type.startsWith('image/') || isHeicFile(f);

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('讀取檔案失敗'));
    r.readAsDataURL(blob);
  });
}

/** Re-encodes a picture the browser can decode as a JPEG of at most MAX_EDGE pixels; null when it cannot decode it. */
async function asJpeg(file: File): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.88));
  } catch {
    return null;
  }
}

/** Image files from a drop or a paste (other files and plain text are left alone). */
function imagesOf(list: DataTransfer | null): File[] {
  return list ? [...list.files].filter(isImageFile) : [];
}

interface Props {
  tripId: string;
  item: Item;
  send: Send;
}

export function PhotoStrip({ tripId, item, send }: Props) {
  const photos = item.photos ?? [];
  const input = useRef<HTMLInputElement | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    setOpen(null);
    setError(null);
  }, [item.id]);

  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || busy) return;
      setBusy(true);
      setError(null);
      try {
        for (const file of files) {
          let blob: Blob = file;
          if (isHeicFile(file) || file.size > MAX_BYTES) {
            const jpeg = await asJpeg(file);
            if (!jpeg) {
              setError(isHeicFile(file) ? `「${file.name}」是 HEIC，這個瀏覽器讀不了：請先轉成 JPEG（iPhone 設定 › 相機 › 格式選「最相容」）` : `「${file.name}」超過 8 MB`);
              continue;
            }
            blob = jpeg;
          }
          await send('photo-add', { itemId: item.id, filename: file.name, dataBase64: await toBase64(blob) }, files.length > 1 ? `已加入照片「${file.name}」` : '已加入照片');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        if (input.current) input.current.value = '';
      }
    },
    [busy, item.id, send],
  );

  // Drop onto, or paste into, the whole detail panel (paste only while focus is inside it, and only when the clipboard holds a picture).
  useEffect(() => {
    const panel = strip.current?.closest<HTMLElement>('.detail');
    if (!panel) return;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!panel.contains(e.relatedTarget as Node | null)) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragOver(false);
      const files = imagesOf(e.dataTransfer);
      if (files.length) void upload(files);
      else setError('只能放入照片（JPEG、PNG、WebP 或 HEIC）');
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = imagesOf(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      void upload(files);
    };
    panel.addEventListener('dragover', onOver);
    panel.addEventListener('dragleave', onLeave);
    panel.addEventListener('drop', onDrop);
    panel.addEventListener('paste', onPaste);
    return () => {
      panel.removeEventListener('dragover', onOver);
      panel.removeEventListener('dragleave', onLeave);
      panel.removeEventListener('drop', onDrop);
      panel.removeEventListener('paste', onPaste);
    };
  }, [upload]);

  return (
    <div ref={strip} className={`photo-strip${dragOver ? ' drop' : ''}${photos.length ? '' : ' empty'}`}>
      {photos.length > 0 && (
        <ul className="ph-list" aria-label={`${item.title} 的照片`}>
          {photos.map((p, i) => (
            <li key={p.file}>
              <button type="button" className="ph-thumb" onClick={() => setOpen(i)} aria-label={`放大第 ${i + 1} 張照片${p.caption ? `：${p.caption}` : ''}`}>
                <img src={photoUrl(tripId, p)} alt={p.caption ?? item.title} loading="lazy" decoding="async" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ph-add">
        <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? '上傳中…' : '＋ 加照片'}
        </button>
        {photos.length === 0 && <span className="ph-hint">也可以把照片拖進來或貼上</span>}
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            if (files.length) void upload(files);
          }}
        />
      </div>
      {error && <p className="form-error">{error}</p>}
      {open !== null && photos[open] && (
        <Lightbox
          tripId={tripId}
          title={item.title}
          photos={photos}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          onRemove={async (p) => {
            const ok = await send('photo-remove', { itemId: item.id, photoFile: p.file }, '已移除照片');
            if (ok) setOpen(photos.length > 1 ? Math.min(open, photos.length - 2) : null);
          }}
        />
      )}
    </div>
  );
}

function Lightbox({
  tripId,
  title,
  photos,
  index,
  onIndex,
  onClose,
  onRemove,
}: {
  tripId: string;
  title: string;
  photos: Photo[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  onRemove: (p: Photo) => Promise<void>;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [removing, setRemoving] = useState(false);
  const p = photos[index]!;
  const many = photos.length > 1;
  const go = (d: number) => onIndex((index + d + photos.length) % photos.length);

  // Focus moves into the dialog and goes back to what had it (the thumbnail) when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('.lb-close')?.focus();
    return () => before?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowRight' && many) {
      e.preventDefault();
      go(1);
    } else if (e.key === 'ArrowLeft' && many) {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'Tab') {
      const items = [...(box.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]') ?? [])];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div className="lb-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="lb" role="dialog" aria-modal="true" aria-label={`${title} 的照片 ${index + 1} / ${photos.length}`} onKeyDown={onKeyDown}>
        <div className="lb-top">
          <span className="lb-count">
            {title} · {index + 1} / {photos.length}
          </span>
          <button type="button" className="lb-close close-x" onClick={onClose} aria-label="關閉照片">
            ×
          </button>
        </div>
        <div className="lb-stage">
          {many && (
            <button type="button" className="lb-nav prev" onClick={() => go(-1)} aria-label="上一張">
              ‹
            </button>
          )}
          <img key={p.file} src={photoUrl(tripId, p)} alt={p.caption ?? title} />
          {many && (
            <button type="button" className="lb-nav next" onClick={() => go(1)} aria-label="下一張">
              ›
            </button>
          )}
        </div>
        <div className="lb-foot">
          <div className="lb-text">
            {p.caption && <p className="lb-caption">{p.caption}</p>}
            {p.source && (
              <p className="lb-source">
                來源：
                <a href={p.source.url} target="_blank" rel="noreferrer noopener">
                  {p.source.label} ↗
                </a>
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn danger"
            disabled={removing}
            onClick={async () => {
              setRemoving(true);
              await onRemove(p);
              setRemoving(false);
            }}
          >
            {removing ? '移除中…' : '移除'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
