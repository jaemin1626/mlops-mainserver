const path = require('node:path');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.gif', '.mkv', '.avi']);

/**
 * VLM 미디어 절대경로 → 대응 JSON 절대경로
 *   …/vlm/images/…/file.jpg      → …/vlm/images_json/…/file.json
 *   …/vlm/videos/…/file.mp4       → …/vlm/videos_json/…/file.json
 *   …/vlm/generated/clip/001.jpg  → …/vlm/images_json/generated/clip/001.json
 *   …/vlm/generated/clip.mp4      → …/vlm/videos_json/generated/clip.json
 */
function vlmJsonPathForMediaPath(mediaPath) {
  const normalized = String(mediaPath || '').replace(/\\/g, '/');
  const ext = path.extname(normalized).toLowerCase();
  const withoutExt = normalized.slice(0, normalized.length - ext.length);

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

module.exports = { vlmJsonPathForMediaPath };
