const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('web bridge marks web mode and writeTxt resolves false on request errors', () => {
  const source = readProjectFile('src/webFsBridge.ts');

  assert.match(source, /window\.__DATA_STUDIO_WEB__\s*=\s*true/);
  assert.match(
    source,
    /writeTxt:[\s\S]*?try\s*\{[\s\S]*?apiJson[\s\S]*?catch\s*\{[\s\S]*?return false/
  );
});

test('web bridge exposes VLM JSON IO and media-root APIs', () => {
  const bridge = readProjectFile('src/webFsBridge.ts');
  const electronTypes = readProjectFile('src/electron.d.ts');
  const preload = readProjectFile('electron/preload.js');

  assert.match(
    electronTypes,
    /openFolderDialog:\s*\(opts\?:\s*\{\s*initialPath\?:\s*string\s*\}\)/
  );
  assert.match(
    preload,
    /openFolderDialog:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\('openFolderDialog',\s*opts\)/
  );
  assert.match(bridge, /import\s*\{\s*getWebMediaBaseRoot,\s*setWebMediaBaseRoot\s*\}/);
  assert.match(bridge, /openFolderDialog:\s*\(opts\)\s*=>\s*pickFolder\(opts\?\.initialPath\)/);
  assert.match(bridge, /openJsonFileDialog:\s*\(\)\s*=>\s*pickJson\('\/data\/datasets\/vlm'\)/);
  assert.match(bridge, /mode:\s*'save-name'[\s\S]*?directory[\s\S]*?defaultName/);
  assert.match(bridge, /readJsonFile:[\s\S]*?\/fs\/file\?path=/);
  assert.match(bridge, /writeJsonFile:[\s\S]*?method:\s*'PUT'/);
  assert.match(bridge, /setMediaBaseRoot:[\s\S]*?setWebMediaBaseRoot\(path\)/);
  assert.match(bridge, /getMediaBaseRoot:[\s\S]*?getWebMediaBaseRoot\(\)/);
});

test('App keeps Electron-only annotation modes available', () => {
  const source = readProjectFile('src/App.tsx');

  for (const workspace of [
    'VlmWorkspace',
    'PolygonWorkspace',
    'LandmarkWorkspace',
    'OcrLabelWorkspace',
  ]) {
    assert.match(source, new RegExp(`import ${workspace}`));
    assert.match(source, new RegExp(`<${workspace} />`));
  }
  assert.match(source, /const isWeb\s*=\s*window\.__DATA_STUDIO_WEB__\s*===\s*true/);
});

test('web app exposes VLM while keeping annotation tabs Electron-only', () => {
  const source = readProjectFile('src/App.tsx');
  const electronOnlyStart = source.indexOf('{!isWeb && (');
  const vlmButton = source.indexOf("aria-selected={mode === 'vlm'}");
  const polygonButton = source.indexOf("aria-selected={mode === 'polygon'}");

  assert.ok(vlmButton >= 0 && vlmButton < electronOnlyStart);
  assert.ok(polygonButton > electronOnlyStart);
});

test('dataset entry paths and VLM sibling media auto-detection are configured', () => {
  const yolo = readProjectFile('src/modes/YoloWorkspace.tsx');
  const vlm = readProjectFile('src/modes/VlmWorkspace.tsx');
  const electronMain = readProjectFile('electron/main.js');

  assert.match(
    yolo,
    /openFolderDialog\(\{\s*initialPath:\s*'\/data\/datasets\/detector'\s*\}\)/
  );
  assert.match(
    electronMain,
    /openFolderDialog',\s*async\s*\(_,\s*opts\)[\s\S]*?defaultPath:\s*opts\?\.initialPath/
  );
  assert.match(vlm, /folderName\.includes\('video'\)/);
  assert.match(vlm, /\/data-studio\/api\/fs\/list\?path=\$\{encodeURIComponent\(dir\)\}/);
  assert.match(vlm, /if\s*\(auto\)\s*\{[\s\S]*?setMediaBaseRoot\(auto\)[\s\S]*?setMediaBasePath\(auto\)[\s\S]*?localStorage\.setItem\(VLM_MEDIA_BASE_STORAGE_KEY,\s*auto\)[\s\S]*?\}\s*else\s*\{[\s\S]*?syncMediaRoots\(jsonDir\)/);
  assert.match(readProjectFile('src/vlmMedia.ts'), /record\.video/);
  assert.match(readProjectFile('src/webMediaBase.ts'), /resolveRelativePath/);
});

test('label picker listens for the web bridge label event', () => {
  const picker = readProjectFile('src/components/ServerFolderPicker.tsx');

  assert.match(picker, /addEventListener\('data-studio:pick-label',\s*open\)/);
  assert.match(picker, /removeEventListener\('data-studio:pick-label',\s*open\)/);
});

test('unknown API routes return JSON 404 before the SPA fallback', () => {
  const source = readProjectFile('server/index.js');
  const routerIndex = source.indexOf("app.use('/data-studio/api', createFsRouter())");
  const notFoundIndex = source.indexOf(
    "app.use('/data-studio/api', (_req, res) => res.status(404).json({ error: 'not found' }))"
  );
  const spaIndex = source.indexOf("app.get(['/data-studio', '/data-studio/*']");

  assert.ok(routerIndex >= 0);
  assert.ok(notFoundIndex > routerIndex);
  assert.ok(spaIndex > notFoundIndex);
});
