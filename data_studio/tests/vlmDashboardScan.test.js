const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanVlmDashboard } = require('../shared/vlmDashboardScan');
const { serializeYoloMeta, transitionSubmit } = require('../shared/yoloMeta');

test('scanVlmDashboard aggregates images and videos categories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlm-dash-'));
  const imagesCig = path.join(root, 'images', 'Cigarette', 'base', 'Negative');
  const videosFire = path.join(root, 'videos', 'Fire');
  fs.mkdirSync(imagesCig, { recursive: true });
  fs.mkdirSync(videosFire, { recursive: true });

  const imagePath = path.join(imagesCig, '001.jpg');
  const jsonPath = path.join(imagesCig, '001.json');
  fs.writeFileSync(imagePath, 'jpg');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify({ tags: ['smoke'] }));
  const submittedMeta = transitionSubmit(
    JSON.parse(serializeYoloMeta(require('../shared/yoloMeta').createDefaultYoloMeta())),
    'worker-a'
  );
  fs.writeFileSync(path.join(imagesCig, '001.meta.json'), serializeYoloMeta(submittedMeta));

  const videoPath = path.join(videosFire, '0089.mp4');
  fs.writeFileSync(videoPath, 'mp4');

  const summary = scanVlmDashboard(root);
  assert.equal(summary.folders.length, 2);
  assert.equal(summary.totals.totalImages, 2);
  assert.equal(summary.totals.labeledImages, 1);
  assert.equal(summary.totals.byStatus.submitted, 1);
  assert.equal(summary.totals.byStatus.draft, 1);
  assert.equal(summary.totals.pendingReview, 1);

  const cigFolder = summary.folders.find((f) => f.folderName === 'images · Cigarette');
  assert.ok(cigFolder);
  assert.equal(cigFolder.totalImages, 1);
  assert.equal(cigFolder.labeledImages, 1);
  assert.equal(cigFolder.imageCount, 1);
  assert.equal(cigFolder.videoCount, 0);

  const fireFolder = summary.folders.find((f) => f.folderName === 'videos · Fire');
  assert.ok(fireFolder);
  assert.equal(fireFolder.imageCount, 0);
  assert.equal(fireFolder.videoCount, 1);

  assert.equal(summary.totals.imageCount, 1);
  assert.equal(summary.totals.videoCount, 1);

  fs.rmSync(root, { recursive: true, force: true });
});

test('scanVlmDashboard includes generated folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vlm-dash-gen-'));
  const generated = path.join(root, 'generated', 'clip');
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(path.join(generated, '000001.jpg'), 'jpg');

  const summary = scanVlmDashboard(root);
  assert.equal(summary.folders.length, 1);
  assert.equal(summary.folders[0].folderName, 'generated');
  assert.equal(summary.totals.totalImages, 1);
  assert.equal(summary.totals.imageCount, 1);
  assert.equal(summary.totals.videoCount, 0);

  fs.rmSync(root, { recursive: true, force: true });
});
