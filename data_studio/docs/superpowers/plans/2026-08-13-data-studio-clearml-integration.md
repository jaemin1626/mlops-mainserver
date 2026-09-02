# Data Studio × ClearML Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ClearML `:8080`에서 `/data-studio/`로 YOLO 라벨링 웹앱을 열고, 같은 서버 디스크 경로의 이미지를 편집·자동 저장한다.

**Architecture:** `data-studio` 컨테이너가 정적 UI + 파일 API를 제공하고, ClearML `webserver` nginx가 `/data-studio/`를 프록시한다. 브라우저는 Electron IPC 대신 `window.electron` 호환 HTTP 어댑터를 사용한다.

**Tech Stack:** React 18, Vite 5, Node.js (Express 파일 API), Docker Compose, nginx (ClearML webserver)

**Spec:** `/opt/data_studio/docs/superpowers/specs/2026-08-13-data-studio-clearml-integration-design.md`

## Global Constraints

- 1차 범위: **YOLO 모드만** (VLM/Polygon/OCR/Landmark UI는 숨기거나 비활성)
- Base path: Vite `base: '/data-studio/'`, 브라우저 API prefix: `/data-studio/api`
- 컨테이너 내부 포트: `8091`
- 허용 루트 env: `DATA_STUDIO_ALLOWED_ROOTS` (기본 `/data/datasets`)
- 쓰기 허용 확장자 1차: `.txt`만
- ClearML webserver 외부 포트 `:8080` 유지; data-studio 외부 포트 미공개
- 이 환경에 git이 없으면 commit 단계는 건너뛰고 파일만 남긴다

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `/opt/data_studio/server/pathGuard.js` | 허용 루트 realpath 검사 |
| `/opt/data_studio/server/fsRoutes.js` | `/api/health`, `/api/fs/*` 라우트 |
| `/opt/data_studio/server/index.js` | Express 앱: API + `dist` 정적 서빙 |
| `/opt/data_studio/tests/pathGuard.test.js` | 경로 escape 단위 테스트 |
| `/opt/data_studio/src/webFsBridge.ts` | Electron API 호환 HTTP 브리지 + `window.electron` 주입 |
| `/opt/data_studio/src/components/ServerFolderPicker.tsx` | 서버 폴더/라벨 파일 선택 모달 |
| `/opt/data_studio/src/main.tsx` | 웹 모드에서 브리지 부트스트랩 |
| `/opt/data_studio/src/App.tsx` | 웹에서도 앱 렌더; 1차 YOLO 탭만 |
| `/opt/data_studio/src/modes/YoloWorkspace.tsx` | 다이얼로그 → ServerFolderPicker 훅 연결 (최소 변경) |
| `/opt/data_studio/vite.config.ts` | `base: '/data-studio/'` |
| `/opt/data_studio/Dockerfile` | multi-stage: build UI + run Express |
| `/opt/data_studio/package.json` | `express`, `server` 스크립트 추가 |
| `/opt/clearml/nginx/default.d/data-studio.conf` | `/data-studio/` reverse proxy |
| `/opt/clearml/docker-compose.yml` | `data-studio` 서비스 + webserver 볼륨 |
| `/opt/clearml/branding/index.html` | Data Studio 플로팅 링크 주입 |
| `/opt/clearml/data/datasets/` | 호스트 데이터셋 마운트 루트 (샘플 포함) |

---

### Task 1: pathGuard + 단위 테스트

**Files:**
- Create: `/opt/data_studio/server/pathGuard.js`
- Create: `/opt/data_studio/tests/pathGuard.test.js`

**Interfaces:**
- Produces:
  - `parseAllowedRoots(envValue: string | undefined): string[]`
  - `resolveSafePath(allowedRoots: string[], requestedPath: string): { ok: true, path: string } | { ok: false, error: string, status: 400|404 }`
  - `assertWritableLabelPath(resolvedPath: string): { ok: true } | { ok: false, error: string, status: 400 }`

- [ ] **Step 1: Write the failing test**

```js
// /opt/data_studio/tests/pathGuard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseAllowedRoots, resolveSafePath, assertWritableLabelPath } = require('../server/pathGuard');

test('parseAllowedRoots splits comma and colon', () => {
  assert.deepEqual(parseAllowedRoots('/a:/b,/c'), ['/a', '/b', '/c']);
});

test('resolveSafePath rejects path outside roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-out-'));
  const res = resolveSafePath([root], path.join(outside, 'x.txt'));
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test('resolveSafePath accepts path under root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-root-'));
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, '1');
  const res = resolveSafePath([root], file);
  assert.equal(res.ok, true);
  assert.equal(res.path, fs.realpathSync(file));
});

test('assertWritableLabelPath allows only .txt', () => {
  assert.equal(assertWritableLabelPath('/data/datasets/a.txt').ok, true);
  assert.equal(assertWritableLabelPath('/data/datasets/a.json').ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /opt/data_studio && node --test tests/pathGuard.test.js`

Expected: FAIL (`Cannot find module '../server/pathGuard'`)

- [ ] **Step 3: Write minimal implementation**

```js
// /opt/data_studio/server/pathGuard.js
const fs = require('node:fs');
const path = require('node:path');

function parseAllowedRoots(envValue) {
  const raw = (envValue || '/data/datasets').trim();
  return raw
    .split(/[:,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

function resolveSafePath(allowedRoots, requestedPath) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    return { ok: false, error: 'path required', status: 400 };
  }
  let candidate;
  try {
    candidate = path.resolve(requestedPath);
  } catch {
    return { ok: false, error: 'invalid path', status: 400 };
  }

  let real;
  try {
    // 파일이 아직 없으면 부모 realpath로 검사
    if (fs.existsSync(candidate)) {
      real = fs.realpathSync(candidate);
    } else {
      const parent = path.dirname(candidate);
      if (!fs.existsSync(parent)) {
        return { ok: false, error: 'not found', status: 404 };
      }
      real = path.join(fs.realpathSync(parent), path.basename(candidate));
    }
  } catch {
    return { ok: false, error: 'not found', status: 404 };
  }

  const roots = allowedRoots.map((r) => {
    try {
      return fs.existsSync(r) ? fs.realpathSync(r) : path.resolve(r);
    } catch {
      return path.resolve(r);
    }
  });

  const under = roots.some((root) => real === root || real.startsWith(root + path.sep));
  if (!under) {
    return { ok: false, error: 'path outside allowed roots', status: 400 };
  }
  return { ok: true, path: real };
}

function assertWritableLabelPath(resolvedPath) {
  if (!resolvedPath.toLowerCase().endsWith('.txt')) {
    return { ok: false, error: 'only .txt writes allowed', status: 400 };
  }
  return { ok: true };
}

module.exports = { parseAllowedRoots, resolveSafePath, assertWritableLabelPath };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /opt/data_studio && node --test tests/pathGuard.test.js`

Expected: PASS (4 tests)

- [ ] **Step 5: Commit (optional if no git)**

```bash
cd /opt/data_studio && git add server/pathGuard.js tests/pathGuard.test.js && git commit -m "feat: add pathGuard for dataset root sandbox" || true
```

---

### Task 2: Express 파일 API 서버

**Files:**
- Create: `/opt/data_studio/server/fsRoutes.js`
- Create: `/opt/data_studio/server/index.js`
- Modify: `/opt/data_studio/package.json` (add `express` dependency and scripts)

**Interfaces:**
- Consumes: `parseAllowedRoots`, `resolveSafePath`, `assertWritableLabelPath` from Task 1
- Produces HTTP:
  - `GET /api/health` → `{ ok: true }`
  - `GET /api/fs/roots` → `{ roots: string[] }`
  - `GET /api/fs/list?path=` → `{ entries: { name, path, type: 'dir'|'file' }[] }`
  - `GET /api/fs/images?path=` → `{ items: OfflineImageItem[] }` (`imageUrl`는 `/data-studio/api/fs/file?path=...` URL)
  - `GET /api/fs/file?path=` → file bytes / text
  - `PUT /api/fs/file` body `{ path, content }` → `{ ok: true }`
  - App listens on `process.env.DATA_STUDIO_PORT || 8091`
  - Mount path: app is mounted at `/` internally; nginx strips nothing — **Express serves under `/data-studio` prefix**

Express must use base path `/data-studio` so proxied URLs match.

- [ ] **Step 1: Add express dependency**

```bash
cd /opt/data_studio && npm install express@4 --save
```

Expected: `package.json` lists `"express"`.

- [ ] **Step 2: Implement fsRoutes.js**

```js
// /opt/data_studio/server/fsRoutes.js
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { parseAllowedRoots, resolveSafePath, assertWritableLabelPath } = require('./pathGuard');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
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
    } catch {
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
    res.sendFile(safe.path);
  });

  router.put('/fs/file', express.json({ limit: '5mb' }), (req, res) => {
    const safe = resolveSafePath(roots(), String(req.body?.path || ''));
    if (!safe.ok) return res.status(safe.status).json({ error: safe.error });
    const writable = assertWritableLabelPath(safe.path);
    if (!writable.ok) return res.status(writable.status).json({ error: writable.error });
    try {
      fs.mkdirSync(path.dirname(safe.path), { recursive: true });
      fs.writeFileSync(safe.path, String(req.body?.content ?? ''), 'utf8');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message || 'write failed' });
    }
  });

  return router;
}

module.exports = { createFsRouter };
```

- [ ] **Step 3: Implement server/index.js**

```js
// /opt/data_studio/server/index.js
const express = require('express');
const path = require('node:path');
const { createFsRouter } = require('./fsRoutes');

const PORT = Number(process.env.DATA_STUDIO_PORT || 8091);
const app = express();

app.use('/data-studio/api', createFsRouter());

const dist = path.join(__dirname, '..', 'dist');
app.use('/data-studio', express.static(dist, { index: false, fallthrough: true }));
app.get(['/data-studio', '/data-studio/*'], (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'));
});

app.get('/api/health', (_req, res) => res.redirect(302, '/data-studio/api/health'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`data-studio listening on ${PORT}`);
});
```

- [ ] **Step 4: Add scripts to package.json**

Add:

```json
"server": "node server/index.js",
"test:server": "node --test tests/pathGuard.test.js"
```

- [ ] **Step 5: Manual API smoke (before UI build, static 404 OK)**

```bash
mkdir -p /opt/clearml/data/datasets/sample
printf '0 0.5 0.5 0.2 0.2\n' > /opt/clearml/data/datasets/sample/demo.txt
# minimal 1x1 png
python3 - <<'PY'
import struct,zlib,pathlib
sig=b'\x89PNG\r\n\x1a\n'
def chunk(t,d):
    return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
raw=zlib.compress(b'\x00'+b'\x00\x00\x00')
png=sig+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'IDAT',raw)+chunk(b'IEND',b'')
pathlib.Path('/opt/clearml/data/datasets/sample/demo.png').write_bytes(png)
PY
DATA_STUDIO_ALLOWED_ROOTS=/opt/clearml/data/datasets DATA_STUDIO_PORT=8091 \
  node /opt/data_studio/server/index.js &
sleep 1
curl -s http://127.0.0.1:8091/data-studio/api/health
curl -s 'http://127.0.0.1:8091/data-studio/api/fs/roots'
curl -s 'http://127.0.0.1:8091/data-studio/api/fs/images?path=/opt/clearml/data/datasets/sample'
kill %1
```

Expected: `{"ok":true}`, roots include `/opt/clearml/data/datasets`, images list contains `demo.png`.

- [ ] **Step 6: Commit (optional)**

```bash
git add server package.json package-lock.json && git commit -m "feat: add Express filesystem API for data-studio" || true
```

---

### Task 3: 웹 FS 브리지 + ServerFolderPicker

**Files:**
- Create: `/opt/data_studio/src/webFsBridge.ts`
- Create: `/opt/data_studio/src/components/ServerFolderPicker.tsx`
- Modify: `/opt/data_studio/src/main.tsx`
- Modify: `/opt/data_studio/src/App.tsx`
- Modify: `/opt/data_studio/src/modes/YoloWorkspace.tsx`
- Modify: `/opt/data_studio/vite.config.ts`
- Modify: `/opt/data_studio/src/electron.d.ts` (optional: document web mode)

**Interfaces:**
- Produces: `installWebFsBridge(): void` — sets `window.electron` with YOLO-needed methods
- `openFolderDialog` / `openLabelFileDialog` open ServerFolderPicker via custom events:
  - dispatch `data-studio:pick-folder` / `data-studio:pick-label`
  - resolve Promise when picker returns path
- Consumes API from Task 2

- [ ] **Step 1: Set Vite base**

In `/opt/data_studio/vite.config.ts` change:

```ts
base: '/data-studio/',
```

- [ ] **Step 2: Implement webFsBridge.ts**

```ts
// /opt/data_studio/src/webFsBridge.ts
import type { OfflineImageItem, ReadJsonFileResult } from './electron.d';

const API = '/data-studio/api';

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.error || msg;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

function pickViaEvent(eventName: string, mode: 'dir' | 'label'): Promise<string | null> {
  return new Promise((resolve) => {
    const detail = {
      mode,
      done: (path: string | null) => resolve(path),
    };
    window.dispatchEvent(new CustomEvent(eventName, { detail }));
  });
}

export function installWebFsBridge(): void {
  if (typeof window === 'undefined') return;
  if (window.electron) return; // real Electron wins

  let workspaceRoot: string | null = null;

  window.electron = {
    openFolderDialog: () => pickViaEvent('data-studio:pick-folder', 'dir'),
    openLabelFileDialog: () => pickViaEvent('data-studio:pick-label', 'label'),
    setWorkspaceRoot: async (p) => {
      workspaceRoot = p;
      return true;
    },
    setMediaBaseRoot: async () => true,
    getMediaBaseRoot: async () => null,
    scanFolder: async (dirPath) => {
      const data = await apiJson<{ items: OfflineImageItem[] }>(
        `${API}/fs/images?path=${encodeURIComponent(dirPath)}`
      );
      return data.items;
    },
    readTxt: async (filePath) => {
      const res = await fetch(`${API}/fs/file?path=${encodeURIComponent(filePath)}`);
      if (res.status === 404) return '';
      if (!res.ok) throw new Error('readTxt failed');
      return res.text();
    },
    writeTxt: async (filePath, content) => {
      const data = await apiJson<{ ok: boolean }>(`${API}/fs/file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content }),
      });
      return !!data.ok;
    },
    readLabelFile: async (filePath) => {
      const res = await fetch(`${API}/fs/file?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) throw new Error('readLabelFile failed');
      return res.text();
    },
    showItemInFolder: async () => { /* no-op on web */ },
    deleteImageAndTxt: async () => ({ ok: false, error: 'not supported in web v1' }),
    deleteImagePolygonJson: async () => ({ ok: false, error: 'not supported in web v1' }),
    openJsonFileDialog: async () => null,
    saveJsonFileDialog: async () => null,
    readJsonFile: async (): Promise<ReadJsonFileResult> => ({ ok: false, error: 'not supported in web v1' }),
    writeJsonFile: async () => false,
    ocrInit: async () => ({ ok: false, error: 'ocr not in web v1' }),
    ocrDetectRecognize: async () => ({ ok: false, error: 'ocr not in web v1' }),
    ocrBatchDetect: async () => ({ ok: false, error: 'ocr not in web v1' }),
    ocrRecognizeQuad: async () => ({ ok: false, error: 'ocr not in web v1' }),
  };

  void workspaceRoot;
}
```

- [ ] **Step 3: Implement ServerFolderPicker.tsx**

모달 UI:

- `data-studio:pick-folder` → 디렉터리만 선택 가능, 더블클릭/Enter로 하강, “이 폴더 열기” 확정
- `data-studio:pick-label` → `.txt` 파일 선택
- 시작 경로: `GET /api/fs/roots`의 첫 루트
- `GET /api/fs/list?path=`로 목록 표시
- 취소 시 `done(null)`

(구현 시 기존 glass/버튼 스타일을 `YoloWorkspace`와 맞춤.)

- [ ] **Step 4: Wire main.tsx**

```tsx
import { installWebFsBridge } from './webFsBridge';
installWebFsBridge();
```

`createRoot` 호출 **전에** 실행.

- [ ] **Step 5: App.tsx — 웹 허용 + YOLO만**

- `isElectron` 가드를 제거하거나, `window.electron`이 브리지로 채워지므로 기존 가드가 통과함 (브리지를 main에서 먼저 설치)
- 모드 탭: `yolo`만 표시 (`vlm`/`polygon`/`landmark`/`ocr` 버튼 숨김)
- Electron 전용 안내 화면 삭제 가능 (브리지 설치 후 불필요)

- [ ] **Step 6: Mount ServerFolderPicker in App**

```tsx
<ServerFolderPicker />
{mode === 'yolo' && <YoloWorkspace />}
```

- [ ] **Step 7: Build check**

```bash
cd /opt/data_studio && npm run build
```

Expected: `dist/` 생성, asset 경로가 `/data-studio/assets/...`

- [ ] **Step 8: Commit (optional)**

```bash
git add src vite.config.ts && git commit -m "feat: web FS bridge and server folder picker" || true
```

---

### Task 4: Dockerfile + compose 서비스

**Files:**
- Create: `/opt/data_studio/Dockerfile`
- Create: `/opt/data_studio/.dockerignore`
- Modify: `/opt/clearml/docker-compose.yml`

**Interfaces:**
- Service name: `data-studio`
- container_name: `clearml-data-studio`
- networks: `frontend` (webserver와 통신)
- env:
  - `DATA_STUDIO_PORT=8091`
  - `DATA_STUDIO_ALLOWED_ROOTS=/data/datasets`
- volume: `/opt/clearml/data/datasets:/data/datasets`
- **no** host ports published

- [ ] **Step 1: .dockerignore**

```
node_modules
release
dist
.git
*.swp
poly_test
```

- [ ] **Step 2: Dockerfile**

```dockerfile
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src
COPY CHANGELOG.md ./CHANGELOG.md
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    DATA_STUDIO_PORT=8091 \
    DATA_STUDIO_ALLOWED_ROOTS=/data/datasets
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install express@4 --omit=dev
COPY server ./server
COPY --from=build /app/dist ./dist
EXPOSE 8091
CMD ["node", "server/index.js"]
```

Note: `express`가 dependencies에 있으면 `npm ci --omit=dev`만으로 충분. Task 2에서 dependencies에 넣었는지 확인하고, 넣었다면 `npm install express` 줄 제거.

- [ ] **Step 3: Add compose service**

`/opt/clearml/docker-compose.yml`의 `services:`에 추가:

```yaml
  data-studio:
    build:
      context: /opt/data_studio
      dockerfile: Dockerfile
    container_name: clearml-data-studio
    restart: unless-stopped
    environment:
      DATA_STUDIO_PORT: "8091"
      DATA_STUDIO_ALLOWED_ROOTS: /data/datasets
    volumes:
      - /opt/clearml/data/datasets:/data/datasets
    networks:
      - frontend
```

- [ ] **Step 4: Build and run**

```bash
cd /opt/clearml && docker compose build data-studio && docker compose up -d data-studio
docker exec clearml-data-studio wget -qO- http://127.0.0.1:8091/data-studio/api/health
```

Expected: `{"ok":true}`

- [ ] **Step 5: Commit (optional)**

```bash
git add Dockerfile .dockerignore /opt/clearml/docker-compose.yml && git commit -m "feat: dockerize data-studio and add compose service" || true
```

---

### Task 5: nginx `/data-studio/` 프록시

**Files:**
- Create: `/opt/clearml/nginx/default.d/data-studio.conf`
- Modify: `/opt/clearml/docker-compose.yml` (`webserver` volumes)

ClearML 기본 site는 `include /etc/nginx/default.d/*.conf;` 를 참조하지만 디렉터리가 없음. 호스트 디렉터리를 `/etc/nginx/default.d`에 마운트하면 include가 동작한다.

- [ ] **Step 1: Write proxy conf**

```nginx
# /opt/clearml/nginx/default.d/data-studio.conf
location /data-studio/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_pass http://data-studio:8091/data-studio/;
}

location = /data-studio {
    return 301 /data-studio/;
}
```

- [ ] **Step 2: Mount into webserver**

`webserver` volumes에 추가:

```yaml
    - /opt/clearml/nginx/default.d:/etc/nginx/default.d:ro
```

`depends_on`에 `data-studio` 추가(선택).

- [ ] **Step 3: Recreate webserver**

```bash
cd /opt/clearml && docker compose up -d webserver
docker exec clearml-webserver nginx -t
curl -sS http://127.0.0.1:8080/data-studio/api/health
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/data-studio/
```

Expected: health `{"ok":true}`, UI `200`.

- [ ] **Step 4: Regression — ClearML still up**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
```

Expected: `200`

---

### Task 6: ClearML UI Data Studio 버튼

**Files:**
- Modify: `/opt/clearml/branding/index.html`

브랜딩 JS 청크 해시에 의존하지 않도록, `index.html` `</body>` 직전에 플로팅 링크 스크립트를 삽입한다.

- [ ] **Step 1: Inject floating button**

`</body>` 앞에 추가:

```html
<script>
(function () {
  function mount() {
    if (document.getElementById('ivx-data-studio-link')) return;
    var a = document.createElement('a');
    a.id = 'ivx-data-studio-link';
    a.href = '/data-studio/';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Data Studio';
    a.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:99999',
      'padding:10px 14px',
      'border-radius:10px',
      'background:#A8E61B',
      'color:#1A1A2E',
      'font:600 13px Heebo,sans-serif',
      'text-decoration:none',
      'box-shadow:0 4px 16px rgba(0,0,0,.25)',
    ].join(';');
    document.body.appendChild(a);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
</script>
```

- [ ] **Step 2: Verify (webserver already mounts branding index.html)**

```bash
curl -sS http://127.0.0.1:8080/ | grep -o 'ivx-data-studio-link' | head -1
```

Expected: `ivx-data-studio-link`

브라우저에서 ClearML 우측 하단 **Data Studio** → 새 탭 `/data-studio/`

---

### Task 7: E2E 스모크 (스펙 테스트 계획)

**Files:** none (검증만)

- [ ] **Step 1: Health via ClearML port**

```bash
curl -sS http://127.0.0.1:8080/data-studio/api/health
```

Expected: `{"ok":true}`

- [ ] **Step 2: Outside-root rejection**

```bash
curl -sS -o /tmp/ds_deny.json -w '%{http_code}\n' \
  'http://127.0.0.1:8080/data-studio/api/fs/list?path=/etc'
cat /tmp/ds_deny.json
```

Expected: `400` and error about allowed roots

- [ ] **Step 3: List sample images**

```bash
curl -sS 'http://127.0.0.1:8080/data-studio/api/fs/images?path=/data/datasets/sample'
```

Expected: JSON with `demo.png` (container path `/data/datasets/...`)

- [ ] **Step 4: Write label via API**

```bash
curl -sS -X PUT http://127.0.0.1:8080/data-studio/api/fs/file \
  -H 'Content-Type: application/json' \
  -d '{"path":"/data/datasets/sample/demo.txt","content":"0 0.4 0.4 0.1 0.1\n"}'
cat /opt/clearml/data/datasets/sample/demo.txt
```

Expected: `{"ok":true}` and host file updated

- [ ] **Step 5: Manual UI check**

브라우저:

1. `http://172.16.15.243:8080/` → Data Studio 버튼
2. `/data-studio/`에서 폴더 열기 → `/data/datasets/sample`
3. 박스 수정 후 `D` → `demo.txt` 내용 변경 확인

- [ ] **Step 6: Isolation check**

```bash
docker stop clearml-data-studio
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
docker start clearml-data-studio
```

Expected: ClearML still `200` while data-studio stopped

- [ ] **Step 7: Update spec status**

`/opt/data_studio/docs/superpowers/specs/2026-08-13-data-studio-clearml-integration-design.md` 상단 상태를 `구현 완료(1차)`로 변경.

---

## Spec Coverage Self-Review

| Spec requirement | Task |
|------------------|------|
| data-studio 컨테이너 + compose | Task 4 |
| nginx `/data-studio/` proxy | Task 5 |
| ClearML 버튼 | Task 6 |
| FS API + path sandbox | Task 1–2 |
| YOLO web UI + auto-save | Task 3 (+ existing YoloWorkspace save-on-nav) |
| allowed roots / .txt only writes | Task 1–2, verified Task 7 |
| Vite base `/data-studio/` | Task 3 |
| E2E checklist | Task 7 |
| VLM/OCR out of scope | Task 3 hides non-YOLO tabs |

## Placeholder / Consistency Check

- Internal port consistently `8091`
- Browser paths consistently `/data-studio/...`
- Container dataset path consistently `/data/datasets`
- Host dataset path consistently `/opt/clearml/data/datasets`
- No TBD steps remain
