const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let worker = null;
let buffer = '';
let nextId = 1;
const pending = new Map();

function bundledPythonPaths() {
  const list = [];
  const devRoot = path.join(__dirname, '..');
  list.push(path.join(devRoot, 'ocr-python', 'python.exe'));
  list.push(path.join(devRoot, 'ocr-python', 'Scripts', 'python.exe'));
  if (process.resourcesPath) {
    list.push(path.join(process.resourcesPath, 'ocr-python', 'python.exe'));
    list.push(path.join(process.resourcesPath, 'ocr-python', 'Scripts', 'python.exe'));
  }
  const exeDir = path.dirname(process.execPath);
  list.push(path.join(exeDir, 'ocr-python', 'python.exe'));
  list.push(path.join(exeDir, 'ocr-python', 'Scripts', 'python.exe'));
  return list.filter((p) => fs.existsSync(p));
}

/** Electron GUI는 PATH에 WindowsApps python stub만 있을 수 있음 → 실제 설치 경로 우선 */
function candidatePythonPaths() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const list = [
    ...(process.env.OCR_PYTHON ? [process.env.OCR_PYTHON] : []),
    ...bundledPythonPaths(),
    path.join(local, 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(local, 'Programs', 'Python', 'Python311', 'python.exe'),
    path.join(local, 'Programs', 'Python', 'Python310', 'python.exe'),
    path.join(local, 'Programs', 'Python', 'Python39', 'python.exe'),
    'C:\\Python312\\python.exe',
    'C:\\Python311\\python.exe',
    'C:\\Python310\\python.exe',
  ];
  try {
    const out = execFileSync('where.exe', ['python'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    for (const line of String(out || '').split(/\r?\n/)) {
      const p = line.trim();
      if (!p) continue;
      // Microsoft Store stub 제외
      if (/\\WindowsApps\\/i.test(p)) continue;
      list.push(p);
    }
  } catch {
    /* ignore */
  }
  try {
    const out = execFileSync('py', ['-3', '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    const p = String(out || '').trim().split(/\r?\n/)[0];
    if (p && fs.existsSync(p) && !/\\WindowsApps\\/i.test(p)) list.push(p);
  } catch {
    /* ignore */
  }
  return [...new Set(list.filter((p) => p && fs.existsSync(p)))];
}

function pythonCommand() {
  const found = candidatePythonPaths();
  if (found.length > 0) return found[0];
  return process.platform === 'win32' ? 'python' : 'python3';
}

function scriptPath() {
  // Python은 app.asar 내 파일을 열 수 없음 → asarUnpack 경로로 해석
  let p = path.join(__dirname, '..', 'scripts', 'ocr_worker.py');
  if (p.includes(`${path.sep}app.asar${path.sep}`)) {
    p = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  }
  return p;
}

/** Electron GUI PATH가 빈약할 때 torch/paddle DLL 탐색용 */
function pythonDllPathExtras(pythonExe) {
  const extras = [];
  const prefix = path.dirname(pythonExe);
  const candidates = [
    path.join(prefix, 'Lib', 'site-packages', 'torch', 'lib'),
    path.join(prefix, 'Lib', 'site-packages', 'paddle', 'libs'),
    path.join(prefix, 'Library', 'bin'),
  ];
  for (const d of candidates) {
    if (fs.existsSync(d)) extras.push(d);
  }
  return extras;
}

function isPoisonWorkerError(message) {
  const m = String(message || '');
  return (
    /PDX has already been initialized/i.test(m) ||
    /WinError 127/i.test(m) ||
    /shm\.dll/i.test(m) ||
    /Error loading .*torch/i.test(m) ||
    /DLL load failed/i.test(m)
  );
}

function rejectAll(err) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(err);
  }
  pending.clear();
}

function killWorker() {
  if (!worker) return;
  try {
    worker.kill();
  } catch {
    /* ignore */
  }
  worker = null;
  buffer = '';
}

function onStdout(chunk) {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const id = msg.id;
    if (id == null || !pending.has(id)) continue;
    const entry = pending.get(id);
    pending.delete(id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg);
    else {
      const err = new Error(msg.error || 'OCR worker error');
      if (msg.fatal || isPoisonWorkerError(err.message)) {
        killWorker();
      }
      entry.reject(err);
    }
  }
}

function ensureWorker() {
  if (worker && !worker.killed) return worker;
  const cmd = pythonCommand();
  const script = scriptPath();
  if (!fs.existsSync(script)) {
    throw new Error(
      `OCR worker script not found: ${script}` +
        (script.includes('app.asar')
          ? ' (패키지 asarUnpack 누락 — scripts/ocr_worker.py를 재빌드하세요)'
          : '')
    );
  }
  const args = [script];
  const envPath = [path.dirname(cmd), ...pythonDllPathExtras(cmd), process.env.PATH || '']
    .filter(Boolean)
    .join(path.delimiter);
  worker = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      PATH: envPath,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      DISABLE_MODEL_SOURCE_CHECK: 'True',
      PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True',
      FLAGS_use_mkldnn: '0',
      OCR_DEVICE: process.env.OCR_DEVICE || 'gpu',
    },
  });
  buffer = '';
  worker.stdout.on('data', onStdout);
  worker.stderr.on('data', (d) => {
    console.error('[ocr-worker]', d.toString('utf8'));
  });
  worker.on('exit', (code) => {
    worker = null;
    rejectAll(new Error(`OCR worker exited (${code ?? 'unknown'})`));
  });
  worker.on('error', (err) => {
    worker = null;
    const hint =
      err && err.code === 'ENOENT'
        ? ` Python을 찾을 수 없습니다. OCR_PYTHON에 python.exe 경로를 지정하거나 Python 3.11을 설치하세요. (시도: ${cmd})`
        : '';
    rejectAll(new Error(`${err.message || 'spawn failed'}${hint}`));
  });
  return worker;
}

function request(payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = ensureWorker();
    } catch (err) {
      reject(err);
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      killWorker();
      reject(new Error('OCR request timeout'));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, 'utf8', (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        killWorker();
        reject(err);
      }
    });
  });
}

async function ocrPing() {
  return request({ cmd: 'ping' }, 5000);
}

async function ocrInit(lang = 'korean', modelPreset = 'v6_tiny', detectOptions = null) {
  try {
    return await request({ cmd: 'init', lang, modelPreset, detectOptions }, 180000);
  } catch (err) {
    if (isPoisonWorkerError(err && err.message)) {
      killWorker();
      return request({ cmd: 'init', lang, modelPreset, detectOptions }, 180000);
    }
    throw err;
  }
}

async function ocrDetectRecognize(imagePath, lang = 'korean', detectOptions = null) {
  return request({ cmd: 'detect_recognize', imagePath, lang, detectOptions }, 180000);
}

async function ocrBatchDetect(imagePaths, lang = 'korean', detectOptions = null) {
  const count = Array.isArray(imagePaths) ? imagePaths.length : 0;
  const timeoutMs = Math.min(3600000, Math.max(120000, count * 3000 + 60000));
  return request({ cmd: 'batch_detect', imagePaths, lang, detectOptions }, timeoutMs);
}

async function ocrRecognizeQuad(imagePath, points, lang = 'korean') {
  return request(
    {
      cmd: 'recognize_quad',
      imagePath,
      points,
      lang,
    },
    60000
  );
}

function ocrShutdown() {
  if (!worker || worker.killed) {
    worker = null;
    return Promise.resolve();
  }
  return request({ cmd: 'shutdown' }, 5000)
    .catch(() => {})
    .finally(() => {
      killWorker();
    });
}

module.exports = {
  ocrPing,
  ocrInit,
  ocrDetectRecognize,
  ocrBatchDetect,
  ocrRecognizeQuad,
  ocrShutdown,
};
