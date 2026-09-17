const path = require('node:path');

/**
 * VLM media and its label live together, sharing the same stem.
 *   …/images/sample.jpg → …/images/sample.json
 *   …/videos/sample.mp4 → …/videos/sample.json
 */
function vlmJsonPathForMediaPath(mediaPath) {
  const normalized = String(mediaPath || '').replace(/\\/g, '/');
  const ext = path.extname(normalized);
  return `${normalized.slice(0, normalized.length - ext.length)}.json`;
}

module.exports = { vlmJsonPathForMediaPath };
