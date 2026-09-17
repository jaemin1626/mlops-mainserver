const fs = require('node:fs');
const path = require('node:path');
const { parseYoloMeta, yoloMetaPathForImage } = require('./yoloMeta');
const { vlmJsonPathForMediaPath } = require('./vlmJsonPaths');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.gif', '.avi']);
const SKIP = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  'images_json',
  'videos_json',
]);

/**
 * @typedef {'draft' | 'submitted' | 'approved' | 'rejected'} WorkflowStatus
 */

/**
 * @typedef {Object} VlmFolderStats
 * @property {string} folderPath
 * @property {string} folderName
 * @property {number} totalImages
 * @property {number} labeledImages
 * @property {number} labelRate
 * @property {number} imageCount
 * @property {number} videoCount
 * @property {number} labeledImageCount
 * @property {number} labeledVideoCount
 * @property {number} imageLabelRate
 * @property {number} videoLabelRate
 * @property {Record<WorkflowStatus, number>} byStatus
 */

function pct(labeled, total) {
  return total > 0 ? Math.round((labeled / total) * 100) : 0;
}

/**
 * @param {string} dir
 * @param {VlmFolderStats} stats
 */
function walkMedia(dir, stats) {
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
      walkMedia(full, stats);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const isImage = IMAGE_EXT.has(ext);
    const isVideo = VIDEO_EXT.has(ext);
    if (!isImage && !isVideo) continue;

    stats.totalImages += 1;
    if (isImage) stats.imageCount += 1;
    else stats.videoCount += 1;

    let labeled = false;
    const jsonPath = vlmJsonPathForMediaPath(full);
    try {
      if (fs.existsSync(jsonPath)) {
        const json = fs.readFileSync(jsonPath, 'utf8').trim();
        labeled = json.length > 0;
      }
    } catch {
      /* ignore read errors */
    }
    if (labeled) {
      stats.labeledImages += 1;
      if (isImage) stats.labeledImageCount += 1;
      else stats.labeledVideoCount += 1;
    }

    let status = /** @type {WorkflowStatus} */ ('draft');
    const metaPath = yoloMetaPathForImage(full);
    try {
      if (fs.existsSync(metaPath)) {
        const meta = parseYoloMeta(fs.readFileSync(metaPath, 'utf8'));
        status = meta.workflowStatus;
      }
    } catch {
      /* ignore invalid meta */
    }
    stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
  }
}

function finalizeVlmStats(stats) {
  stats.labelRate = pct(stats.labeledImages, stats.totalImages);
  stats.imageLabelRate = pct(stats.labeledImageCount, stats.imageCount);
  stats.videoLabelRate = pct(stats.labeledVideoCount, stats.videoCount);
  return stats;
}

/** @returns {VlmFolderStats} */
function scanVlmProjectFolder(folderPath, folderName) {
  /** @type {Record<WorkflowStatus, number>} */
  const byStatus = { draft: 0, submitted: 0, approved: 0, rejected: 0 };
  /** @type {VlmFolderStats} */
  const stats = {
    folderPath,
    folderName,
    totalImages: 0,
    labeledImages: 0,
    labelRate: 0,
    imageCount: 0,
    videoCount: 0,
    labeledImageCount: 0,
    labeledVideoCount: 0,
    imageLabelRate: 0,
    videoLabelRate: 0,
    byStatus,
  };
  walkMedia(folderPath, stats);
  return finalizeVlmStats(stats);
}

/**
 * @param {string} parentDir
 * @param {string} kindLabel images | videos
 * @param {VlmFolderStats[]} folders
 */
function collectCategoryFolders(parentDir, kindLabel, folders) {
  let entries;
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const folderPath = path.join(parentDir, entry.name);
    const folderName = `${kindLabel} · ${entry.name}`;
    const stats = scanVlmProjectFolder(folderPath, folderName);
    if (stats.totalImages > 0) {
      folders.push(stats);
    }
  }
}

/**
 * @param {string} vlmRoot
 */
function scanVlmDashboard(vlmRoot) {
  const resolvedRoot = path.resolve(vlmRoot);
  /** @type {VlmFolderStats[]} */
  const folders = [];

  const imagesDir = path.join(resolvedRoot, 'images');
  if (fs.existsSync(imagesDir)) {
    collectCategoryFolders(imagesDir, 'images', folders);
  }

  const videosDir = path.join(resolvedRoot, 'videos');
  if (fs.existsSync(videosDir)) {
    collectCategoryFolders(videosDir, 'videos', folders);
  }

  const generatedDir = path.join(resolvedRoot, 'generated');
  if (fs.existsSync(generatedDir)) {
    const stats = scanVlmProjectFolder(generatedDir, 'generated');
    if (stats.totalImages > 0) {
      folders.push(stats);
    }
  }

  folders.sort((a, b) => a.folderName.localeCompare(b.folderName, undefined, { numeric: true }));

  /** @type {Record<WorkflowStatus, number>} */
  const byStatus = { draft: 0, submitted: 0, approved: 0, rejected: 0 };
  let totalImages = 0;
  let labeledImages = 0;
  let imageCount = 0;
  let videoCount = 0;
  let labeledImageCount = 0;
  let labeledVideoCount = 0;
  for (const folder of folders) {
    totalImages += folder.totalImages;
    labeledImages += folder.labeledImages;
    imageCount += folder.imageCount;
    videoCount += folder.videoCount;
    labeledImageCount += folder.labeledImageCount;
    labeledVideoCount += folder.labeledVideoCount;
    for (const key of Object.keys(byStatus)) {
      byStatus[/** @type {WorkflowStatus} */ (key)] += folder.byStatus[/** @type {WorkflowStatus} */ (key)] ?? 0;
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    vlmRoot: resolvedRoot,
    folders,
    totals: {
      totalImages,
      labeledImages,
      labelRate: pct(labeledImages, totalImages),
      imageCount,
      videoCount,
      labeledImageCount,
      labeledVideoCount,
      imageLabelRate: pct(labeledImageCount, imageCount),
      videoLabelRate: pct(labeledVideoCount, videoCount),
      byStatus,
      pendingReview: byStatus.submitted,
      rejected: byStatus.rejected,
    },
  };
}

module.exports = {
  scanVlmDashboard,
  scanVlmProjectFolder,
};
