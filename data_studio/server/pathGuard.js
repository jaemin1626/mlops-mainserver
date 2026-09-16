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
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const parent = path.dirname(candidate);
        if (!fs.existsSync(parent)) {
          return { ok: false, error: 'not found', status: 404 };
        }
        real = path.join(fs.realpathSync(parent), path.basename(candidate));
      } else {
        throw err;
      }
    }
    if (stat) {
      // Symlink(including dangling) must resolve via realpath; fails if target missing
      real = fs.realpathSync(candidate);
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
  const lower = resolvedPath.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.json') || lower.endsWith('.meta.json')) {
    return { ok: true };
  }
  return { ok: false, error: 'only .txt/.json/.meta.json writes allowed', status: 400 };
}

function normalizedAllowedRoots(allowedRoots) {
  return allowedRoots.map((r) => {
    try {
      return fs.existsSync(r) ? fs.realpathSync(r) : path.resolve(r);
    } catch {
      return path.resolve(r);
    }
  });
}

function isPathUnderRoot(resolvedPath, root) {
  return resolvedPath === root || resolvedPath.startsWith(root + path.sep);
}

/** PUT 쓰기용 — 중간 디렉터리가 없어도 허용 루트 아래면 통과 (mkdir 후 저장) */
function resolveSafePathForWrite(allowedRoots, requestedPath) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    return { ok: false, error: 'path required', status: 400 };
  }
  let candidate;
  try {
    candidate = path.resolve(requestedPath);
  } catch {
    return { ok: false, error: 'invalid path', status: 400 };
  }

  const roots = normalizedAllowedRoots(allowedRoots);
  if (!roots.some((root) => isPathUnderRoot(candidate, root))) {
    return { ok: false, error: 'path outside allowed roots', status: 400 };
  }

  let probe = path.dirname(candidate);
  while (probe !== path.dirname(probe)) {
    if (fs.existsSync(probe)) {
      try {
        const realProbe = fs.realpathSync(probe);
        if (!roots.some((root) => isPathUnderRoot(realProbe, root))) {
          return { ok: false, error: 'path outside allowed roots', status: 400 };
        }
      } catch {
        return { ok: false, error: 'not found', status: 404 };
      }
      break;
    }
    probe = path.dirname(probe);
  }

  return { ok: true, path: candidate };
}

module.exports = {
  parseAllowedRoots,
  resolveSafePath,
  resolveSafePathForWrite,
  assertWritableLabelPath,
};
