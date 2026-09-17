/** VLM media and label JSON share one directory and one filename stem. */
export function vlmJsonPathForMediaPath(mediaPath: string): string {
  const normalized = String(mediaPath || '').replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const lastDot = normalized.lastIndexOf('.');
  const withoutExt = lastDot > lastSlash ? normalized.slice(0, lastDot) : normalized;
  return `${withoutExt}.json`;
}
