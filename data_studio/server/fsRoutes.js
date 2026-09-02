const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { parseAllowedRoots, resolveSafePath, assertWritableLabelPath } = require('./pathGuard');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.vscode']);

function createFsRouter() {
  const router = express.Router();
  const roots = () => parseAllowedRoots(process.env.DATA_STUDIO_ALLOWED_ROOTS);

  router.get('/health', (_req, res) => res.json({ ok: true }));

  router.get('/fs/roots', (_req, res) => {
    res.json({ roots: roots() });
  });

  router.get('/fs/list', (req, res) => {
    const safe = resolveSafePath(roots(), String(req.query.path || ''));
    if (!safe.ok) return res.status(safe.status).json({ error: safe.error });
    let entries;
    try {
      entries = fs.readdirSync(safe.path, { withFileTypes: true });
    } catch (err) {
      // /data/datasets/detector 등 아직 없는 하위 폴더 → 빈 목록 (404 대신)
      if (err && err.code === 'ENOENT') {
        return res.json({ entries: [] });
      }
      return res.status(404).json({ error: 'not found' });
    }
    const out = entries
      .filter((e) => !SKIP.has(e.name) && !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: path.join(safe.path, e.name),
        type: e.isDirectory() ? 'dir' : 'file',
      }))
      .sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name));
    res.json({ entries: out });
  });

  router.get('/fs/images', (req, res) => {
    const safe = resolveSafePath(roots(), String(req.query.path || ''));
    if (!safe.ok) return res.status(safe.status).json({ error: safe.error });
    const items = [];
    function walk(dir, relBase) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        if (e.isDirectory()) walk(full, rel);
        else if (IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
          const base = full.slice(0, -path.extname(full).length);
          const txtPath = base + '.txt';
          const jsonPath = base + '.json';
          const q = encodeURIComponent(full);
          items.push({
            name: rel.replace(/\\/g, '/'),
            imagePath: full,
            txtPath,
            jsonPath,
            imageUrl: `/data-studio/api/fs/file?path=${q}`,
          });
        }
      }
    }
    walk(safe.path, '');
    items.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ items });
  });

  router.get('/fs/file', (req, res) => {
    const safe = resolveSafePath(roots(), String(req.query.path || ''));
    if (!safe.ok) return res.status(safe.status).json({ error: safe.error });
    if (!fs.existsSync(safe.path) || !fs.statSync(safe.path).isFile()) {
      return res.status(404).json({ error: 'not found' });
    }
    const ext = path.extname(safe.path).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (mime) res.type(mime);
    if (VIDEO_EXT.has(ext)) {
      res.setHeader('Accept-Ranges', 'bytes');
    }
    res.sendFile(safe.path, { acceptRanges: true });
  });

  router.get('/fs/video', (req, res) => {
    const safe = resolveSafePath(roots(), String(req.query.path || ''));
    if (!safe.ok) return res.status(safe.status).json({ error: safe.error });
    if (!fs.existsSync(safe.path) || !fs.statSync(safe.path).isFile()) {
      return res.status(404).json({ error: 'not found' });
    }
    const ext = path.extname(safe.path).toLowerCase();
    if (!VIDEO_EXT.has(ext)) {
      return res.status(400).json({ error: 'not a video file' });
    }
    let playable;
    try {
      const { ensureWebPlayableVideo } = require('./videoServe');
      playable = ensureWebPlayableVideo(safe.path);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'video prepare failed' });
    }
    res.type('video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    if (playable.convertedFrom) {
      res.setHeader('X-Data-Studio-Video-Codec', playable.convertedFrom);
    }
    res.sendFile(playable.path, { acceptRanges: true });
  });

  router.put('/fs/file', express.json({ limit: '5mb' }), (req, res) => {
    if (typeof req.body?.path !== 'string' || req.body.path.trim().length === 0) {
      return res.status(400).json({ error: 'path required' });
    }
    if (typeof req.body?.content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    const safe = resolveSafePath(roots(), req.body.path);
    if (!safe.ok) return res.status(safe.status).json({ error: safe.error });
    const writable = assertWritableLabelPath(safe.path);
    if (!writable.ok) return res.status(writable.status).json({ error: writable.error });
    try {
      fs.mkdirSync(path.dirname(safe.path), { recursive: true });
      fs.writeFileSync(safe.path, req.body.content, 'utf8');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message || 'write failed' });
    }
  });

  return router;
}

module.exports = { createFsRouter };
