const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanYoloDashboard } = require('../shared/yoloDashboardScan');
const { serializeYoloMeta, transitionSubmit } = require('../shared/yoloMeta');

test('scanYoloDashboard aggregates subfolders and workflow status', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-dash-'));
  const fire = path.join(root, 'Fire');
  const cig = path.join(root, 'Cigarette');
  fs.mkdirSync(fire, { recursive: true });
  fs.mkdirSync(cig, { recursive: true });

  fs.writeFileSync(path.join(fire, '001.jpg'), 'jpg');
  fs.writeFileSync(path.join(fire, '001.txt'), '0 0.1 0.2 0.3 0.4');
  const submittedMeta = transitionSubmit(
    JSON.parse(serializeYoloMeta(require('../shared/yoloMeta').createDefaultYoloMeta())),
    'worker-a'
  );
  fs.writeFileSync(path.join(fire, '001.meta.json'), serializeYoloMeta(submittedMeta));

  fs.writeFileSync(path.join(cig, '002.jpg'), 'jpg');

  const summary = scanYoloDashboard(root);
  assert.equal(summary.folders.length, 2);
  assert.equal(summary.totals.totalImages, 2);
  assert.equal(summary.totals.labeledImages, 1);
  assert.equal(summary.totals.byStatus.submitted, 1);
  assert.equal(summary.totals.byStatus.draft, 1);
  assert.equal(summary.totals.pendingReview, 1);
  assert.ok(summary.recentChanges.length >= 1);
  assert.equal(summary.recentChanges[0].action, 'submit');

  fs.rmSync(root, { recursive: true, force: true });
});

test('scanYoloDashboard scans root when no subfolders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-dash-root-'));
  fs.writeFileSync(path.join(root, 'a.jpg'), 'jpg');
  fs.writeFileSync(path.join(root, 'a.txt'), '0 0.1 0.2 0.3 0.4');

  const summary = scanYoloDashboard(root);
  assert.equal(summary.folders.length, 1);
  assert.equal(summary.folders[0].folderName, path.basename(root));
  assert.equal(summary.totals.totalImages, 1);

  fs.rmSync(root, { recursive: true, force: true });
});
