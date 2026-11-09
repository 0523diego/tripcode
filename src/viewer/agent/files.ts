// Where the panel loads a picture from: the dev server's /__agent/files route, which only serves image files under trips/.
export function fileUrl(ref: string): string {
  return `/__agent/files?path=${encodeURIComponent(ref)}`;
}
