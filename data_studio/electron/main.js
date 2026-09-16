/**
 * Linux: Electron/Chromium이 GtkFileChooserNative를 쓸 때 GLib
 * `invalid cast from 'GtkFileChooserNative' to 'GtkWidget'` 등이 터미널에 찍히는 경우가 많음.
 * xdg-desktop-portal 경유로 완화(이미 GTK_USE_PORTAL이 있으면 그대로 둠).
 * 문제가 되면 실행 전 `GTK_USE_PORTAL=0` 으로 끄고 시험.
 */
if (process.platform === 'linux' && process.env.GTK_USE_PORTAL === undefined) {
  process.env.GTK_USE_PORTAL = '1';
}

const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const { vlmJsonPathForMediaPath } = require('../shared/vlmJsonPaths');
const { scanYoloDashboard } = require('../shared/yoloDashboardScan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ocrInit, ocrDetectRecognize, ocrBatchDetect, ocrRecognizeQuad, ocrShutdown } = require('./ocrService');

// 다른 PC에서 빈 화면이 나올 때 GPU 비활성화로 해결되는 경우가 많음
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');

/**
 * Linux: tar.gz / linux-unpacked 등에서 `chrome-sandbox`가 root·4755(setuid)가 아니면
 * Chromium이 바로 종료됨(VirtualBox·일반 우분투에서 흔함). 로컬 도구로 샌드박스 완화.
 * (패키지 설치형으로 sandbox를 쓰려면 배포 시 chrome-sandbox 권한 문서화가 필요함.)
 */
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('disable-setuid-sandbox');
  app.commandLine.appendSwitch('no-sandbox');
}

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.mkv'];
/** 재귀 스캔 시 제외할 폴더 (용량·노이즈 방지) */
const SKIP_SCAN_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.vscode']);
let mainWindow = null;
let workspaceRoot = null;
/** VLM: JSON 내 상대 경로(Event/…) 해석용 사용자 지정 기준 폴더 */
let mediaBaseRoot = null;

/** Windows: 긴 경로·괄호 포함 경로 오류 방지를 위해 확장 경로(\\?\ ) 사용 */
function toLongPath(filePath) {
  if (process.platform !== 'win32' || !filePath || typeof filePath !== 'string') return filePath;
  const normalized = path.normalize(filePath.trim());
  if (path.isAbsolute(normalized) && !normalized.startsWith('\\\\?\\')) {
    return '\\\\?\\' + normalized;
  }
  return normalized;
}

/**
 * 저장 재시도 여부: Windows UNKNOWN(-4094) 등 + Linux(VirtualBox 공유 등) ETXTBSY·EBUSY.
 */
function isTransientWriteRetryError(err) {
  if (!err) return false;
  const c = err.code;
  if (process.platform === 'linux') {
    return c === 'ETXTBSY' || c === 'EBUSY' || c === 'EPERM' || c === 'EACCES' || c === 'EIO';
  }
  if (process.platform !== 'win32') return false;
  if (err.errno === -4094) return true;
  return c === 'UNKNOWN' || c === 'EBUSY' || c === 'EPERM' || c === 'EACCES' || c === 'EIO';
}

/** 같은 파일에 대한 빠른 연속 저장을 한 줄로 직렬화 (read/write 경합 완화) */
function canonicalWriteKey(filePath) {
  let n = path.normalize(String(filePath || '').trim());
  if (process.platform === 'win32' && n.startsWith('\\\\?\\')) {
    n = n.slice(4);
    if (n.startsWith('UNC\\')) n = '\\\\' + n.slice(3);
  }
  return n.toLowerCase();
}

const writeChainTail = new Map();

/**
 * @param {string} filePath
 * @param {string} body
 * @returns {Promise<boolean>}
 */
function queueUtf8Write(filePath, body) {
  const content = typeof body === 'string' ? body : '';
  const key = canonicalWriteKey(filePath);
  const prev = writeChainTail.get(key) || Promise.resolve();
  const job = prev.catch(() => {}).then(() => writeUtf8FileRobust(filePath, content));
  writeChainTail.set(key, job);
  job.finally(() => {
    if (writeChainTail.get(key) === job) writeChainTail.delete(key);
  });
  return job;
}

/** 쓰기: 일반 경로 먼저(\\?\ 는 일부 필터·백신과 충돌 보고 있음), 실패 시 긴 경로 */
function writePathVariants(filePath) {
  const normalized = path.normalize(String(filePath || '').trim());
  if (!normalized) return [];
  if (process.platform !== 'win32') return [normalized];
  const long = toLongPath(normalized);
  if (long === normalized) return [normalized];
  return [normalized, long];
}

/**
 * 임시 파일에 쓴 뒤 rename으로 교체(원자적에 가깝게).
 * VirtualBox 공유 폴더(vboxsf)·일부 네트워크 FS는 rename 덮어쓰기 시 ETXTBSY → 직접 write로 폴백.
 */
async function writeUtf8AtomicToPath(targetPath, content) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const token = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const tmpPath = path.join(dir, `${base}.${token}.tmp`);
  await fs.promises.writeFile(tmpPath, content, 'utf-8');
  const rmTmp = () => fs.promises.unlink(tmpPath).catch(() => {});

  try {
    await fs.promises.rename(tmpPath, targetPath);
    return;
  } catch (_e1) {
    try {
      try {
        await fs.promises.unlink(targetPath);
      } catch (_) {
        /* 없음 */
      }
      await fs.promises.rename(tmpPath, targetPath);
      return;
    } catch (_e2) {
      try {
        await fs.promises.writeFile(targetPath, content, 'utf-8');
        await rmTmp();
      } catch (e3) {
        await rmTmp();
        throw e3;
      }
    }
  }
}

/**
 * UTF-8 파일 쓰기: 디렉터리 생성 + 경로 변형별 재시도(간격 넉넉히).
 * @returns {Promise<boolean>}
 */
async function writeUtf8FileRobust(filePath, body) {
  const variants = writePathVariants(filePath);
  if (variants.length === 0) return false;
  const content = typeof body === 'string' ? body : '';
  let lastErr = null;
  const maxAttempts = 14;
  for (const p of variants) {
    const dir = path.dirname(p);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (e) {
      lastErr = e;
      continue;
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await writeUtf8AtomicToPath(p, content);
        return true;
      } catch (e) {
        lastErr = e;
        if (isTransientWriteRetryError(e) && attempt < maxAttempts) {
          const delay = Math.min(450, 90 + attempt * 45);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        break;
      }
    }
  }
  if (lastErr) console.error(lastErr);
  return false;
}

function getIconPath() {
  const candidates = [
    path.join(__dirname, '..', 'public', 'logo.ico'),
    path.join(process.resourcesPath || __dirname, 'app.asar', 'public', 'logo.ico'),
    path.join(process.resourcesPath || __dirname, 'public', 'logo.ico'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function createWindow() {
  const iconPath = getIconPath();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: iconPath || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Intellivix Data Studio (Local)',
  });

  const useDevServer = process.env.ELECTRON_DEV === '1';
  if (useDevServer) {
    mainWindow.loadURL('http://localhost:5175/');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

function isResolvedPathInsideRoot(resolvedFile, resolvedRoot) {
  if (process.platform === 'win32') {
    const f = resolvedFile.toLowerCase();
    const r = resolvedRoot.toLowerCase();
    return f === r || f.startsWith(r + path.sep);
  }
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot + path.sep);
}

/** JSON 폴더·images/videos/media·images_vlm 등에서 미디어 파일 탐색 */
function mediaSearchRoots(rootDir) {
  const r = path.resolve(rootDir);
  const parent = path.dirname(r);
  const candidates = [
    r,
    path.join(r, 'images_vlm'),
    path.join(parent, 'images_vlm'),
    path.join(parent, 'images'),
    path.join(parent, 'videos'),
    path.join(parent, 'media'),
  ];
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const abs = path.resolve(c);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

function normalizeMediaRelativePath(raw) {
  return String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:\/+/, '')
    .replace(/^\/+/, '')
    .replace(/^datasets\/images_vlm\//i, '')
    .replace(/^datasets\//i, '')
    .replace(/^images_vlm\//i, '');
}

function resolveRelativePath(baseDir, relativePath) {
  const base = String(baseDir || '').replace(/\\/g, '/');
  const rel = String(relativePath || '').replace(/\\/g, '/');
  const isAbs = base.startsWith('/');
  const baseParts = base.split('/').filter((part, index) => part.length > 0 || (index === 0 && isAbs));
  const stack = (isAbs && baseParts[0] === '' ? baseParts.slice(1) : baseParts.filter(Boolean)).slice();
  for (const segment of rel.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return (isAbs ? '/' : '') + stack.join('/');
}

function needsRelativePathResolution(input) {
  const raw = String(input || '').trim();
  if (!raw) return false;
  if (raw.startsWith('.') || raw.startsWith('..')) return true;
  return raw.split('/').includes('..');
}

/** JSON 경로 후보 — Event/ 접두는 images_vlm 루트에 Event 폴더가 없을 때 제거해 시도 */
function vlmMediaRelativeCandidates(relativePath) {
  const rel = normalizeMediaRelativePath(relativePath);
  if (!rel || rel.includes('..')) return [];
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const key = p.toLowerCase();
    if (!p || seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  push(rel);
  if (/^event\//i.test(rel)) {
    push(rel.replace(/^event\//i, ''));
  }
  return out;
}

function collectMediaLookupRoots() {
  const seen = new Set();
  const out = [];
  const pushRoot = (rootDir) => {
    if (!rootDir) return;
    for (const root of mediaSearchRoots(rootDir)) {
      const key = process.platform === 'win32' ? root.toLowerCase() : root;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(root);
    }
  };
  pushRoot(mediaBaseRoot);
  pushRoot(workspaceRoot);
  return out;
}

function resolveMediaFileAtRoot(root, rel) {
  const resolved = path.resolve(root, rel);
  if (!isResolvedPathInsideRoot(resolved, root)) return null;
  if (fs.existsSync(resolved)) return resolved;
  return null;
}

function resolveMediaFileUnderWorkspace(relativePath) {
  if (!relativePath) return null;
  const raw = String(relativePath).trim();
  if (needsRelativePathResolution(raw)) {
    const roots = collectMediaLookupRoots();
    for (const root of roots) {
      const resolved = path.resolve(resolveRelativePath(root, raw));
      if (fs.existsSync(resolved)) return resolved;
    }
  }
  const roots = collectMediaLookupRoots();
  if (roots.length === 0) return null;
  for (const rel of vlmMediaRelativeCandidates(relativePath)) {
    for (const root of roots) {
      const hit = resolveMediaFileAtRoot(root, rel);
      if (hit) return hit;
    }
  }
  return null;
}

function registerYoloProtocol() {
  protocol.registerFileProtocol('yolo', (request, callback) => {
    if (!mediaBaseRoot && !workspaceRoot) {
      callback({ error: -2 });
      return;
    }
    const u = request.url.replace(/^yolo:\/\/workspace\/?/i, '');
    let decoded;
    try {
      decoded = decodeURIComponent(u);
    } catch {
      decoded = u;
    }
    const resolved = resolveMediaFileUnderWorkspace(decoded);
    if (!resolved) {
      callback({ error: -2 });
      return;
    }
    callback({ path: resolved });
  });
}

app.on('ready', () => {
  registerYoloProtocol();
  createWindow();
});

app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
app.on('before-quit', () => {
  void ocrShutdown();
});

ipcMain.handle('openFolderDialog', async (_, opts) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: opts?.initialPath,
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

ipcMain.handle('setWorkspaceRoot', (_, root) => {
  workspaceRoot = root || null;
  return true;
});

ipcMain.handle('setMediaBaseRoot', (_, root) => {
  mediaBaseRoot = root ? path.resolve(String(root)) : null;
  return true;
});

ipcMain.handle('getMediaBaseRoot', () => mediaBaseRoot);

function mediaKindForExt(ext, includeVideos) {
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (includeVideos && VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

function collectMediaRecursive(rootDir, currentDir, items, includeVideos, vlmSidecarJson) {
  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch (e) {
    console.error(e);
    return;
  }
  for (const e of entries) {
    const full = path.join(currentDir, e.name);
    if (e.isDirectory()) {
      if (SKIP_SCAN_DIRS.has(e.name)) continue;
      collectMediaRecursive(rootDir, full, items, includeVideos, vlmSidecarJson);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    const mediaType = mediaKindForExt(ext, includeVideos);
    if (!mediaType) continue;
    const rel = path.relative(rootDir, full);
    const relPosix = rel.split(path.sep).join('/');
    const base = e.name.slice(0, -ext.length);
    const txtPath = path.join(path.dirname(full), base + '.txt');
    const jsonPath = vlmSidecarJson ? vlmJsonPathForMediaPath(full) : path.join(path.dirname(full), base + '.json');
    const segments = relPosix.split('/').filter(Boolean);
    items.push({
      name: relPosix,
      imagePath: full,
      txtPath,
      jsonPath,
      mediaType,
      imageUrl: 'yolo://workspace/' + segments.map(encodeURIComponent).join('/'),
    });
  }
}

function collectImagesRecursive(rootDir, currentDir, items) {
  collectMediaRecursive(rootDir, currentDir, items, false, false);
}

ipcMain.handle('scanFolder', (_, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const root = path.resolve(dirPath);
  const items = [];
  collectImagesRecursive(root, root, items);
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return items;
});

ipcMain.handle('scanYoloDashboard', (_, detectorRoot) => {
  const root = path.resolve(String(detectorRoot || '/data/datasets/detector').trim());
  if (!fs.existsSync(root)) {
    return {
      scannedAt: new Date().toISOString(),
      detectorRoot: root,
      folders: [],
      recentChanges: [],
      totals: {
        totalImages: 0,
        labeledImages: 0,
        labelRate: 0,
        byStatus: { draft: 0, submitted: 0, approved: 0, rejected: 0 },
        pendingReview: 0,
        rejected: 0,
      },
    };
  }
  try {
    return scanYoloDashboard(root);
  } catch (e) {
    console.error(e);
    return {
      scannedAt: new Date().toISOString(),
      detectorRoot: root,
      folders: [],
      recentChanges: [],
      totals: {
        totalImages: 0,
        labeledImages: 0,
        labelRate: 0,
        byStatus: { draft: 0, submitted: 0, approved: 0, rejected: 0 },
        pendingReview: 0,
        rejected: 0,
      },
    };
  }
});

ipcMain.handle('scanMediaFolder', (_, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const root = path.resolve(dirPath);
  const items = [];
  collectMediaRecursive(root, root, items, true, true);
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return items;
});

ipcMain.handle('readTxt', (_, filePath) => {
  if (!filePath) return '';
  const p = toLongPath(filePath);
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf-8');
  } catch (e) {
    console.error(e);
    return '';
  }
});

ipcMain.handle('writeTxt', async (_, filePath, content) => {
  if (!filePath) return false;
  return queueUtf8Write(filePath, content || '');
});

ipcMain.handle('openLabelFileDialog', async (_, opts) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'Label file', extensions: ['txt'] }],
    properties: ['openFile'],
    defaultPath: opts?.initialPath,
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

ipcMain.handle('openJsonFileDialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  return filePaths[0];
});

ipcMain.handle('saveJsonFileDialog', async (_, defaultPath) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: typeof defaultPath === 'string' && defaultPath.trim() ? defaultPath.trim() : 'vlm_reverify.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return null;
  return filePath;
});

ipcMain.handle('readJsonFile', (_, filePath) => {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'invalid path' };
  const p = toLongPath(filePath.trim());
  try {
    if (!fs.existsSync(p)) return { ok: false, error: 'not found' };
    const text = fs.readFileSync(p, 'utf-8');
    return { ok: true, text };
  } catch (e) {
    console.error(e);
    return { ok: false, error: (e && e.message) || 'read failed' };
  }
});

ipcMain.handle('writeJsonFile', async (_, filePath, content) => {
  if (!filePath || typeof filePath !== 'string') return false;
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return queueUtf8Write(filePath, body);
});

ipcMain.handle('readLabelFile', (_, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
});

ipcMain.handle('showItemInFolder', (_, filePath) => {
  if (!filePath || typeof filePath !== 'string') return;
  const normalized = path.normalize(String(filePath).trim());
  const longPath = toLongPath(normalized);
  try {
    if (fs.existsSync(longPath)) {
      shell.showItemInFolder(normalized);
    } else {
      const dir = path.dirname(normalized);
      if (fs.existsSync(toLongPath(dir))) shell.openPath(dir);
    }
  } catch (e) {
    console.error(e);
  }
});

ipcMain.handle('deleteImageAndTxt', (_, imagePath, txtPath, jsonPath) => {
  if (!imagePath || typeof imagePath !== 'string') return { ok: false, error: 'invalid path' };
  try {
    const img = toLongPath(imagePath.trim());
    if (fs.existsSync(img)) fs.unlinkSync(img);
    if (txtPath && typeof txtPath === 'string') {
      const txt = toLongPath(txtPath.trim());
      if (fs.existsSync(txt)) fs.unlinkSync(txt);
    }
    if (jsonPath && typeof jsonPath === 'string') {
      const json = toLongPath(jsonPath.trim());
      if (fs.existsSync(json)) fs.unlinkSync(json);
    }
    return { ok: true };
  } catch (e) {
    console.error(e);
    return { ok: false, error: (e && e.message) || 'delete failed' };
  }
});

ipcMain.handle('deleteImagePolygonJson', (_, imagePath, jsonPath) => {
  if (!imagePath || typeof imagePath !== 'string') return { ok: false, error: 'invalid path' };
  try {
    const img = toLongPath(imagePath.trim());
    if (fs.existsSync(img)) fs.unlinkSync(img);
    if (jsonPath && typeof jsonPath === 'string') {
      const j = toLongPath(jsonPath.trim());
      if (fs.existsSync(j)) fs.unlinkSync(j);
    }
    return { ok: true };
  } catch (e) {
    console.error(e);
    return { ok: false, error: (e && e.message) || 'delete failed' };
  }
});

ipcMain.handle('ocrInit', async (_, lang, modelPreset, detectOptions) => {
  try {
    return await ocrInit(lang || 'korean', modelPreset || 'v6_tiny', detectOptions || null);
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ocr init failed' };
  }
});

ipcMain.handle('ocrDetectRecognize', async (_, imagePath, lang, detectOptions) => {
  try {
    return await ocrDetectRecognize(imagePath, lang || 'korean', detectOptions || null);
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ocr detect failed', boxes: [] };
  }
});

ipcMain.handle('ocrBatchDetect', async (_, imagePaths, lang, detectOptions) => {
  try {
    return await ocrBatchDetect(imagePaths || [], lang || 'korean', detectOptions || null);
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ocr batch detect failed', results: [] };
  }
});

ipcMain.handle('ocrRecognizeQuad', async (_, imagePath, points, lang) => {
  try {
    return await ocrRecognizeQuad(imagePath, points || [], lang || 'korean');
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ocr recognize failed' };
  }
});
