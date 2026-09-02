/**
 * electron-builder가 release/win-unpacked 등을 덮어쓰기 전에
 * 이전 산출물·실행 중인 동일 앱이 app.asar 등을 잠그는 문제를 줄입니다.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const release = path.join(root, 'release');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
/** NSIS/win-unpacked 실행 파일명은 executableName(없으면 name) 기준 */
const appExeBase =
  (pkg.build && pkg.build.executableName) || pkg.name || 'intellivix-data-studio-local';
const productExe = `${appExeBase}.exe`;

function sleepSync(ms) {
  if (process.platform === 'win32') {
    try {
      execSync(`powershell -NoProfile -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
    } catch {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* spin */
      }
    }
  } else {
    try {
      execSync(`sleep ${Math.max(1, Math.ceil(ms / 1000))}`, { stdio: 'ignore' });
    } catch {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* spin */
      }
    }
  }
}

if (process.platform === 'win32') {
  try {
    execSync(`taskkill /F /IM "${productExe}" /T`, { stdio: 'ignore' });
  } catch {
    /* 없으면 정상 */
  }
}

if (!fs.existsSync(release)) {
  process.exit(0);
}

for (let attempt = 1; attempt <= 5; attempt++) {
  try {
    fs.rmSync(release, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    if (attempt === 5) {
      console.error('[clean-release] release 폴더를 삭제할 수 없습니다.');
      console.error(err.message);
      console.error(
        '→ 이전에 빌드한 앱이 실행 중이거나, 탐색기가 release 폴더를 열고 있을 수 있습니다. 종료·닫기 후 다시 npm run electron:build 하세요.'
      );
      process.exit(1);
    }
    sleepSync(800);
  }
}
