# VLM Web Port + YOLO detector start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web Data Studio에서 VLM 검수(Electron 동등)와 export(동일 JSON 폴더+파일명)를 가능하게 하고, YOLO 폴더 피커는 `/data/datasets/detector`부터 연다.

**Architecture:** `window.electron` HTTP 브리지를 확장하고 ServerFolderPicker에 json/save-name/initialPath를 추가한다. VlmWorkspace 본체는 유지하되 media base 자동 탐지와 웹용 `yolo://`→HTTP 미디어 URL만 보강한다.

**Tech Stack:** React, Express fs API, existing pathGuard, Docker data-studio image

**Spec:** `/opt/data_studio/docs/superpowers/specs/2026-08-13-vlm-web-port-design.md`

## Global Constraints

- Allowed root: `/data/datasets` (container); host mount `/opt/clearml/data/datasets`
- YOLO picker start: `/data/datasets/detector` (fallback `/data/datasets`)
- VLM JSON picker start: `/data/datasets/vlm` (fallback `/data/datasets`)
- Write allowlist: `.txt` and `.json`
- Export dir = `dirname(openedJsonPath)`; user supplies filename only
- Web shows YOLO + VLM tabs only
- Commits: `git -c user.email=ivx@local -c user.name=ivx commit …`
- After UI/server changes: `cd /opt/clearml && docker compose build data-studio && docker compose up -d data-studio`

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `server/pathGuard.js` | Allow `.json` writes (`assertWritableLabelPath` or rename) |
| `tests/pathGuard.test.js` | Update write-extension tests |
| `tests/fsRoutes.test.js` | PUT `.json` success; still reject other ext |
| `src/components/ServerFolderPicker.tsx` | Modes `json`/`save-name`; `initialPath` |
| `src/webFsBridge.ts` | Full VLM APIs + mediaBase + picker events |
| `src/webMediaBase.ts` | Sync mediaBase store for URL building |
| `src/vlmMedia.ts` | Web: HTTP file URL instead of `yolo://` |
| `src/App.tsx` | Show VLM tab on web |
| `src/modes/YoloWorkspace.tsx` | Pass detector initialPath on folder open |
| `src/modes/VlmWorkspace.tsx` | Auto-set media base to sibling `images/` |
| `src/components/SaveFilenameModal.tsx` | Optional separate modal for save-name (or fold into picker) |

---

### Task 1: Allow `.json` writes on server

**Files:**
- Modify: `server/pathGuard.js`
- Modify: `tests/pathGuard.test.js`
- Modify: `tests/fsRoutes.test.js`

**Interfaces:**
- `assertWritableLabelPath(path)` → allow `.txt` OR `.json` (keep function name for less churn, or rename to `assertWritableDataPath` and update all imports)

- [ ] **Step 1: Update failing/extended tests**

In `tests/pathGuard.test.js` change the write test to:

```js
test('assertWritableLabelPath allows .txt and .json only', () => {
  assert.equal(assertWritableLabelPath('/data/datasets/a.txt').ok, true);
  assert.equal(assertWritableLabelPath('/data/datasets/a.json').ok, true);
  assert.equal(assertWritableLabelPath('/data/datasets/a.png').ok, false);
});
```

Add to `tests/fsRoutes.test.js` a PUT `.json` success case under temp root (mirror existing `.txt` PUT test).

- [ ] **Step 2: Run tests — expect pathGuard write test FAIL**

Run: `node --test tests/pathGuard.test.js tests/fsRoutes.test.js`

- [ ] **Step 3: Implement allowlist**

```js
function assertWritableLabelPath(resolvedPath) {
  const lower = resolvedPath.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.json')) {
    return { ok: true };
  }
  return { ok: false, error: 'only .txt/.json writes allowed', status: 400 };
}
```

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add server/pathGuard.js tests/pathGuard.test.js tests/fsRoutes.test.js
git -c user.email=ivx@local -c user.name=ivx commit -m "feat: allow JSON writes for VLM web save/export"
```

---

### Task 2: ServerFolderPicker modes + initialPath

**Files:**
- Modify: `src/components/ServerFolderPicker.tsx`

**Interfaces:**
- CustomEvent `data-studio:pick-folder` detail:
  ```ts
  { mode: 'dir' | 'label' | 'json'; initialPath?: string; done: (path: string | null) => void }
  ```
- CustomEvent `data-studio:save-filename` detail:
  ```ts
  { directory: string; defaultName?: string; done: (fullPath: string | null) => void }
  ```
  Or reuse picker with `mode: 'save-name'` + `directory` + `defaultName`.

- [ ] **Step 1: Extend types**

```ts
type PickerMode = 'dir' | 'label' | 'json' | 'save-name';

interface PickerRequest {
  mode: PickerMode;
  initialPath?: string;
  directory?: string; // save-name
  defaultName?: string; // save-name
  done: (path: string | null) => void;
}
```

- [ ] **Step 2: On open, resolve start path**

```ts
async function resolveStartPath(preferred: string | undefined, roots: string[]): Promise<string> {
  const candidates = [preferred, ...roots].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      await apiJson(`${API}/fs/list?path=${encodeURIComponent(c)}`);
      return c;
    } catch { /* try next */ }
  }
  return roots[0] || '/data/datasets';
}
```

- [ ] **Step 3: Filter entries by mode**

- `json`: show dirs + files ending `.json`
- `label`: dirs + `.txt`
- `dir`: dirs (and optionally files disabled)
- `save-name`: show current directory read-only path + text input for filename; confirm builds `directory + '/' + name` (append `.json` if missing); if file exists in listing, `window.confirm` overwrite

- [ ] **Step 4: Manual sanity** — not required in CI; build must succeed later

- [ ] **Step 5: Commit**

```bash
git add src/components/ServerFolderPicker.tsx
git -c user.email=ivx@local -c user.name=ivx commit -m "feat: extend server folder picker for JSON and save-name"
```

---

### Task 3: webMediaBase + vlmMedia HTTP URLs

**Files:**
- Create: `src/webMediaBase.ts`
- Modify: `src/vlmMedia.ts`

**Interfaces:**
- `setWebMediaBaseRoot(path: string | null): void`
- `getWebMediaBaseRoot(): string | null`
- `buildWebFsFileUrl(absolutePath: string): string` → `/data-studio/api/fs/file?path=`
- `joinMediaPath(base: string, rel: string): string` — POSIX join, normalize `\`

- [ ] **Step 1: Implement webMediaBase.ts**

```ts
let mediaBaseRoot: string | null = null;

export function setWebMediaBaseRoot(path: string | null): void {
  mediaBaseRoot = path ? String(path) : null;
}

export function getWebMediaBaseRoot(): string | null {
  return mediaBaseRoot;
}

export function joinUnderBase(base: string, rel: string): string {
  const b = base.replace(/[\\/]+$/, '');
  const r = rel.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return `${b}/${r}`;
}

export function buildWebFsFileUrl(absolutePath: string): string {
  return `/data-studio/api/fs/file?path=${encodeURIComponent(absolutePath)}`;
}
```

- [ ] **Step 2: Patch normalizeVlmMediaLocalSrc**

At start of `normalizeVlmMediaLocalSrc`:

```ts
const isWeb = typeof window !== 'undefined' && window.__DATA_STUDIO_WEB__ === true;
if (isWeb) {
  const cleaned = stripVlmMediaPathToRelative(raw);
  // absolute server path?
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    return buildWebFsFileUrl(raw);
  }
  const base = getWebMediaBaseRoot();
  if (!base || !cleaned) return '';
  return buildWebFsFileUrl(joinUnderBase(base, cleaned));
}
```

Keep Electron `yolo://` path unchanged when not web.

- [ ] **Step 3: Commit**

```bash
git add src/webMediaBase.ts src/vlmMedia.ts
git -c user.email=ivx@local -c user.name=ivx commit -m "feat: resolve VLM media via HTTP file API on web"
```

---

### Task 4: webFsBridge VLM APIs

**Files:**
- Modify: `src/webFsBridge.ts`

**Interfaces:** Produce full implementations for openJson/saveJson/read/write/setMediaBase matching electron.d.ts.

- [ ] **Step 1: pick helpers**

```ts
function pickFolder(initialPath?: string): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent('data-studio:pick-folder', {
      detail: { mode: 'dir', initialPath, done: resolve },
    }));
  });
}

function pickJson(initialPath?: string): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent('data-studio:pick-folder', {
      detail: { mode: 'json', initialPath, done: resolve },
    }));
  });
}

function pickSaveName(directory: string, defaultName?: string): Promise<string | null> {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent('data-studio:pick-folder', {
      detail: { mode: 'save-name', directory, defaultName, done: resolve },
    }));
  });
}
```

Expose module setters for default folder starts used by YOLO/VLM:

```ts
let nextFolderInitialPath: string | undefined;
export function setNextOpenFolderInitialPath(p?: string) {
  nextFolderInitialPath = p;
}
```

Or pass via `openFolderDialog` by changing electron.d.ts to optional arg — **prefer optional arg** if call sites can be updated:

```ts
openFolderDialog: (opts?: { initialPath?: string }) => Promise<string | null>
```

Update `electron.d.ts` accordingly; Electron preload can ignore opts.

- [ ] **Step 2: Implement readJsonFile / writeJsonFile**

```ts
readJsonFile: async (filePath) => {
  try {
    const res = await fetch(`${API}/fs/file?path=${encodeURIComponent(filePath)}`);
    if (!res.ok) return { ok: false, error: res.statusText };
    return { ok: true, text: await res.text() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
},
writeJsonFile: async (filePath, content) => {
  try {
    const data = await apiJson<{ ok: boolean }>(`${API}/fs/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    });
    return Boolean(data.ok);
  } catch {
    return false;
  }
},
```

- [ ] **Step 3: setMediaBaseRoot calls setWebMediaBaseRoot**

- [ ] **Step 4: openJsonFileDialog** → `pickJson('/data/datasets/vlm')`

- [ ] **Step 5: saveJsonFileDialog(defaultPath)**

```ts
saveJsonFileDialog: async (defaultPath) => {
  const full = String(defaultPath || '');
  const i = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
  const directory = i >= 0 ? full.slice(0, i) : '/data/datasets';
  const defaultName = i >= 0 ? full.slice(i + 1) : 'export.json';
  return pickSaveName(directory, defaultName);
},
```

- [ ] **Step 6: Commit**

```bash
git add src/webFsBridge.ts src/electron.d.ts
git -c user.email=ivx@local -c user.name=ivx commit -m "feat: wire VLM JSON IO through web filesystem bridge"
```

---

### Task 5: App VLM tab + YOLO/VLM entry paths + media auto-detect

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/modes/YoloWorkspace.tsx`
- Modify: `src/modes/VlmWorkspace.tsx`
- Modify: `src/electron/preload.js` only if openFolderDialog signature changes (forward optional arg)

- [ ] **Step 1: App.tsx — show VLM on web**

```tsx
{( !isWeb || true ) /* show YOLO always */}
// Change: render VLM tab when isWeb OR always for yolo+vlm:
<button … VLM …>  // remove from inside {!isWeb && (…)} 
// Keep polygon/landmark/ocr inside {!isWeb && …}
```

Structure:

```tsx
{/* YOLO always */}
{/* VLM always (web + electron) */}
{!isWeb && ( <> polygon landmark ocr </> )}
```

- [ ] **Step 2: YoloWorkspace handleOpenFolder**

```ts
const path = await window.electron.openFolderDialog({ initialPath: '/data/datasets/detector' });
```

- [ ] **Step 3: VlmWorkspace — after successful JSON open, auto media base**

Add helper:

```ts
async function siblingImagesDir(jsonPath: string): Promise<string | null> {
  const dir = dirnameOfFile(jsonPath); // …/json
  const parent = dirnameOfFile(dir);   // …/task
  const images = `${parent}/images`;
  // Probe via list API through bridge: try setMediaBaseRoot after HEAD/list
  // Simplest: fetch `/data-studio/api/fs/list?path=` 
  try {
    const res = await fetch(`/data-studio/api/fs/list?path=${encodeURIComponent(images)}`);
    if (res.ok) return images;
  } catch { /* ignore */ }
  return null;
}
```

In `loadJsonFromPath` after parse, if web or always:

```ts
const auto = await siblingImagesDir(filePath);
if (auto) {
  await window.electron.setMediaBaseRoot(auto);
  setMediaBasePath(auto);
  localStorage.setItem(VLM_MEDIA_BASE_STORAGE_KEY, auto);
} else {
  await syncMediaRoots(jsonDir); // existing
}
```

Also pass `initialPath: '/data/datasets/vlm'` when picking media folder if desired.

- [ ] **Step 4: `npm run build` succeeds**

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/modes/YoloWorkspace.tsx src/modes/VlmWorkspace.tsx electron/preload.js
git -c user.email=ivx@local -c user.name=ivx commit -m "feat: enable VLM tab on web with dataset entry paths"
```

---

### Task 6: Rebuild container + E2E smoke

**Files:** none required (ops + optional sample data under `/opt/clearml/data/datasets`)

- [ ] **Step 1: Ensure sample tree (minimal)**

```bash
mkdir -p /opt/clearml/data/datasets/detector/sample \
  /opt/clearml/data/datasets/vlm/Cigarette/images/Negative \
  /opt/clearml/data/datasets/vlm/Cigarette/json
# copy or create tiny png + 1-item VLM json array with image: Negative/demo.png
```

Minimal JSON:

```json
[
  {
    "index": "0000000",
    "image": "Negative/demo.png",
    "conversations": [
      { "from": "human", "value": "<image>\n질문" },
      { "from": "gpt", "value": "아니오, 설명" }
    ]
  }
]
```

- [ ] **Step 2: Rebuild**

```bash
cd /opt/clearml && docker compose build data-studio && docker compose up -d data-studio
```

- [ ] **Step 3: API checks**

```bash
curl -sS http://127.0.0.1:8080/data-studio/api/health
curl -sS -X PUT http://127.0.0.1:8080/data-studio/api/fs/file \
  -H 'Content-Type: application/json' \
  -d '{"path":"/data/datasets/vlm/Cigarette/json/_ping.json","content":"{\"ok\":true}"}'
```

- [ ] **Step 4: Bundle checks**

```bash
curl -sS http://127.0.0.1:8080/data-studio/ | grep -o 'VLM 검수' | head -1
```

- [ ] **Step 5: Manual UI checklist** (record in report)

- VLM tab visible
- Open JSON under vlm/, image loads
- Save updates file
- Export asks filename, writes beside JSON
- YOLO folder picker starts at detector/

- [ ] **Step 6: Update spec status** to `구현 완료(1차)` and commit

```bash
git add docs/superpowers/specs/2026-08-13-vlm-web-port-design.md
git -c user.email=ivx@local -c user.name=ivx commit -m "docs: mark VLM web port implemented"
```

---

## Spec Coverage Self-Review

| Spec item | Task |
|-----------|------|
| `.json` writes | Task 1 |
| Picker json/save-name/initialPath | Task 2 |
| Media HTTP URLs | Task 3 |
| Bridge VLM APIs | Task 4 |
| App VLM tab, detector/vlm starts, auto images/ | Task 5 |
| Export same folder + filename | Task 4 save-name + Task 5/6 |
| E2E | Task 6 |

## Placeholder scan

No TBD steps. Exact paths and commands included.
