const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.gif', '.mkv', '.avi']);

/** VLM 미디어 절대경로 → 대응 JSON 절대경로 (server/vlmJsonPaths.js 와 동일 규칙) */
export function vlmJsonPathForMediaPath(mediaPath: string): string {
  const normalized = String(mediaPath || '').replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const lastDot = normalized.lastIndexOf('.');
  const ext = lastDot > lastSlash ? normalized.slice(lastDot).toLowerCase() : '';
  const withoutExt = lastDot > lastSlash ? normalized.slice(0, lastDot) : normalized;

  let jsonBase = withoutExt;
  if (jsonBase.includes('/images/')) {
    jsonBase = jsonBase.replace('/images/', '/images_json/');
  } else if (jsonBase.includes('/videos/')) {
    jsonBase = jsonBase.replace('/videos/', '/videos_json/');
  } else if (jsonBase.includes('/vlm/generated/')) {
    jsonBase = jsonBase.replace(
      '/vlm/generated/',
      VIDEO_EXTENSIONS.has(ext) ? '/vlm/videos_json/generated/' : '/vlm/images_json/generated/'
    );
  }

  return `${jsonBase}.json`;
}
