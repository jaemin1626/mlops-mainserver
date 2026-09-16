const fs = require('node:fs');
const path = require('node:path');
const { parseYoloMeta, yoloMetaPathForImage } = require('./yoloMeta');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.idea', '.vscode']);

/**
 * @typedef {'draft' | 'submitted' | 'approved' | 'rejected'} WorkflowStatus
 */

/**
 * @typedef {Object} YoloFolderStats
 * @property {string} folderPath
 * @property {string} folderName
 * @property {number} totalImages
 * @property {number} labeledImages
 * @property {number} labelRate
 * @property {Record<WorkflowStatus, number>} byStatus
 */

/**
 * @typedef {Object} YoloRecentChange
 * @property {string} folderPath
 * @property {string} folderName
 * @property {string} imagePath
 * @property {string} imageName
 * @property {number} revision
 * @property {string} at
 * @property {string} by
 * @property {string} role
 * @property {string} action
 * @property {string} summary
 */

/**
 * @param {string} dir
 * @param {string} folderPath
 * @param {string} folderName
 * @param {YoloFolderStats} stats
 * @param {YoloRecentChange[]} recentChanges
 */
function walkImages(dir, folderPath, folderName, stats, recentChanges) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkImages(full, folderPath, folderName, stats, recentChanges);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;

    stats.totalImages += 1;
    const txtPath = full.slice(0, -ext.length) + '.txt';
    try {
      if (fs.existsSync(txtPath)) {
        const txt = fs.readFileSync(txtPath, 'utf8').trim();
        if (txt.length > 0) stats.labeledImages += 1;
      }
    } catch {
      /* ignore read errors */
    }

    let status = /** @type {WorkflowStatus} */ ('draft');
    const metaPath = yoloMetaPathForImage(full);
    try {
      if (fs.existsSync(metaPath)) {
        const meta = parseYoloMeta(fs.readFileSync(metaPath, 'utf8'));
        status = meta.workflowStatus;
        for (const change of meta.changeHistory) {
          recentChanges.push({
            folderPath,
            folderName,
            imagePath: full,
            imageName: entry.name,
            revision: change.revision,
            at: change.at,
            by: change.by,
            role: change.role,
            action: change.action,
            summary: change.summary,
          });
        }
      }
    } catch {
      /* ignore invalid meta */
    }
    stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
  }
}

/** @returns {YoloFolderStats & { recentChanges: YoloRecentChange[] }} */
function scanYoloProjectFolder(folderPath) {
  /** @type {Record<WorkflowStatus, number>} */
  const byStatus = { draft: 0, submitted: 0, approved: 0, rejected: 0 };
  /** @type {YoloFolderStats} */
  const stats = {
    folderPath,
    folderName: path.basename(folderPath),
    totalImages: 0,
    labeledImages: 0,
    labelRate: 0,
    byStatus,
  };
  /** @type {YoloRecentChange[]} */
  const recentChanges = [];
  walkImages(folderPath, folderPath, stats.folderName, stats, recentChanges);
  stats.labelRate = stats.totalImages > 0 ? Math.round((stats.labeledImages / stats.totalImages) * 100) : 0;
  return { ...stats, recentChanges };
}

/**
 * @param {string} detectorRoot
 * @param {{ recentLimit?: number }} [opts]
 */
function scanYoloDashboard(detectorRoot, opts = {}) {
  const recentLimit = typeof opts.recentLimit === 'number' ? opts.recentLimit : 30;
  const resolvedRoot = path.resolve(detectorRoot);
  /** @type {YoloFolderStats[]} */
  const folders = [];
  /** @type {YoloRecentChange[]} */
  const allRecent = [];

  let entries;
  try {
    entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  } catch {
    return {
      scannedAt: new Date().toISOString(),
      detectorRoot: resolvedRoot,
      folders: [],
      recentChanges: [],
      totals: emptyTotals(),
    };
  }

  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name));
  if (subdirs.length === 0) {
    const rootScan = scanYoloProjectFolder(resolvedRoot);
    const { recentChanges, ...folderStats } = rootScan;
    folders.push(folderStats);
    allRecent.push(...recentChanges);
  } else {
    for (const entry of subdirs.sort((a, b) => a.name.localeCompare(b.name))) {
      const folderPath = path.join(resolvedRoot, entry.name);
      const scanned = scanYoloProjectFolder(folderPath);
      const { recentChanges, ...folderStats } = scanned;
      folders.push(folderStats);
      allRecent.push(...recentChanges);
    }
  }

  allRecent.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  /** @type {Record<WorkflowStatus, number>} */
  const byStatus = { draft: 0, submitted: 0, approved: 0, rejected: 0 };
  let totalImages = 0;
  let labeledImages = 0;
  for (const folder of folders) {
    totalImages += folder.totalImages;
    labeledImages += folder.labeledImages;
    for (const key of Object.keys(byStatus)) {
      byStatus[/** @type {WorkflowStatus} */ (key)] += folder.byStatus[/** @type {WorkflowStatus} */ (key)] ?? 0;
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    detectorRoot: resolvedRoot,
    folders,
    recentChanges: allRecent.slice(0, recentLimit),
    totals: {
      totalImages,
      labeledImages,
      labelRate: totalImages > 0 ? Math.round((labeledImages / totalImages) * 100) : 0,
      byStatus,
      pendingReview: byStatus.submitted,
      rejected: byStatus.rejected,
    },
  };
}

function emptyTotals() {
  return {
    totalImages: 0,
    labeledImages: 0,
    labelRate: 0,
    byStatus: { draft: 0, submitted: 0, approved: 0, rejected: 0 },
    pendingReview: 0,
    rejected: 0,
  };
}

module.exports = {
  scanYoloDashboard,
  scanYoloProjectFolder,
};
