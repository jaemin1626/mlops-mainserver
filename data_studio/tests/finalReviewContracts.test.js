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

test('dataset entry paths and VLM per-image folder workflow are configured', () => {
  const yolo = readProjectFile('src/modes/YoloWorkspace.tsx');
  const vlm = readProjectFile('src/modes/VlmWorkspace.tsx');
  const vlmPerImage = readProjectFile('src/vlmPerImage.ts');
  const electronMain = readProjectFile('electron/main.js');

  assert.match(
    vlm,
    /openFolderDialog\(\{[\s\S]*?initialPath:\s*'\/data\/datasets\/vlm'[\s\S]*?pickerRoot:\s*'\/data\/datasets\/vlm'/
  );
  assert.match(
    yolo,
    /openFolderDialog\(\{[\s\S]*?initialPath:\s*'\/data\/datasets\/detector'[\s\S]*?pickerRoot:\s*'\/data\/datasets\/detector'/
  );
  assert.match(
    yolo,
    /openLabelFileDialog\(\{[\s\S]*?initialPath:\s*'\/data\/datasets\/detector'[\s\S]*?pickerRoot:\s*'\/data\/datasets\/detector'/
  );
  assert.match(readProjectFile('src/webFsBridge.ts'), /openLabelFileDialog:\s*\(opts\)\s*=>\s*pickLabel\(opts\?\.initialPath,\s*opts\?\.pickerRoot\)/);
  assert.match(vlm, /scanMediaFolder\(path\)/);
  assert.match(readProjectFile('server/fsRoutes.js'), /router\.get\('\/fs\/media'/);
  assert.match(readProjectFile('src/webFsBridge.ts'), /scanMediaFolder:[\s\S]*?\/fs\/media\?path=/);
  assert.match(vlm, /item\.jsonPath/);
  assert.match(vlmPerImage, /buildPerImageJsonFileContent/);
  assert.match(readProjectFile('shared/vlmJsonPaths.js'), /sharing the same stem/);
  assert.match(readProjectFile('server/fsRoutes.js'), /vlmJsonPathForMediaPath/);
  assert.match(
    electronMain,
    /openFolderDialog',\s*async\s*\(_,\s*opts\)[\s\S]*?defaultPath:\s*opts\?\.initialPath/
  );
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
