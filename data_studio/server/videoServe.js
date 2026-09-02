const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WEB_SAFE_VIDEO_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1']);
const CACHE_DIR = process.env.DATA_STUDIO_VIDEO_CACHE || '/tmp/data-studio-video-cache';

function readTailBytes(filePath, maxBytes = 65536) {
  const stat = fs.statSync(filePath);
  const size = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(size);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buf, 0, size, stat.size - size);
  } finally {
    fs.closeSync(fd);
  }
  return buf;
}

/** stsd sample entry fourcc — mp4v 등 브라우저 비호환 코덱 감지 */
function detectMp4VideoCodec(filePath) {
  const tail = readTailBytes(filePath);
  for (const codec of ['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v']) {
    if (tail.includes(Buffer.from(codec))) {
      return codec;
    }
  }
  return 'unknown';
}

function cacheKeyForSource(sourcePath) {
  const stat = fs.statSync(sourcePath);
  return crypto
    .createHash('sha1')
    .update(`${sourcePath}:${stat.size}:${stat.mtimeMs}`)
    .digest('hex');
}

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-4).join('\n');
    throw new Error(detail || 'ffmpeg failed');
  }
}

function transcodeToWebH264(sourcePath, outputPath) {
  const tmp = `${outputPath}.work.mp4`;
  runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    sourcePath,
    '-map',
    '0:v:0',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-map',
    '0:a?',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-f',
    'mp4',
    tmp,
  ]);
  fs.renameSync(tmp, outputPath);
}

function remuxFaststart(sourcePath, outputPath) {
  const tmp = `${outputPath}.work.mp4`;
  runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    sourcePath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    tmp,
  ]);
  fs.renameSync(tmp, outputPath);
}

function moovNearEnd(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const firstType = head.slice(4, 8).toString('latin1');
    return firstType === 'ftyp' && !readTailBytes(filePath, 256 * 1024).includes(Buffer.from('moov'));
  } finally {
    fs.closeSync(fd);
  }
}

/** 브라우저 <video> 재생 가능한 MP4 경로 (필요 시 H.264 변환·캐시) */
function ensureWebPlayableVideo(sourcePath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error('not found');
  }
  const codec = detectMp4VideoCodec(sourcePath);
  const needsTranscode = !WEB_SAFE_VIDEO_CODECS.has(codec);
  const needsRemux = !needsTranscode && moovNearEnd(sourcePath);
  if (!needsTranscode && !needsRemux) {
    return { path: sourcePath, cached: false, codec };
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const suffix = needsTranscode ? 'h264' : 'faststart';
  const cached = path.join(CACHE_DIR, `${cacheKeyForSource(sourcePath)}.${suffix}.mp4`);
  if (fs.existsSync(cached)) {
    return { path: cached, cached: true, codec, convertedFrom: codec };
  }

  if (needsTranscode) {
    transcodeToWebH264(sourcePath, cached);
  } else {
    remuxFaststart(sourcePath, cached);
  }
  return { path: cached, cached: true, codec, convertedFrom: codec };
}

module.exports = {
  CACHE_DIR,
  WEB_SAFE_VIDEO_CODECS,
  detectMp4VideoCodec,
  ensureWebPlayableVideo,
};
