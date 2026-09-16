const test = require('node:test');
const assert = require('node:assert/strict');
const {
  yoloMetaPathForImage,
  parseYoloMeta,
  createDefaultYoloMeta,
  canEditLabels,
  appendLabelSaveHistory,
  transitionSubmit,
  transitionApprove,
  transitionReject,
  workflowStatusLabel,
} = require('../shared/yoloMeta');

test('yoloMetaPathForImage uses same folder as image', () => {
  assert.equal(
    yoloMetaPathForImage('/data/datasets/detector/Fire/0001.jpg'),
    '/data/datasets/detector/Fire/0001.meta.json'
  );
});

test('transitionSubmit moves draft to submitted with history', () => {
  const meta = createDefaultYoloMeta();
  const next = transitionSubmit(meta, 'hong');
  assert.equal(next.workflowStatus, 'submitted');
  assert.equal(next.worker, 'hong');
  assert.equal(next.review.status, 'pending');
  assert.equal(next.changeHistory.length, 1);
  assert.equal(next.changeHistory[0].action, 'submit');
});

test('transitionApprove and transitionReject require submitted', () => {
  const draft = createDefaultYoloMeta();
  assert.equal(transitionApprove(draft, 'kim').workflowStatus, 'draft');
  assert.equal(transitionReject(draft, 'kim', '오류').workflowStatus, 'draft');

  const submitted = transitionSubmit(draft, 'hong');
  const approved = transitionApprove(submitted, 'kim');
  assert.equal(approved.workflowStatus, 'approved');
  assert.equal(approved.review.inspector, 'kim');

  const submitted2 = transitionSubmit(createDefaultYoloMeta(), 'hong');
  const rejected = transitionReject(submitted2, 'kim', '클래스 오류');
  assert.equal(rejected.workflowStatus, 'rejected');
  assert.equal(rejected.review.rejectReason, '클래스 오류');
});

test('appendLabelSaveHistory skips identical txt', () => {
  const meta = createDefaultYoloMeta();
  assert.equal(appendLabelSaveHistory(meta, 'a', 'worker', '0 1 2 3 4', '0 1 2 3 4'), null);
  const next = appendLabelSaveHistory(meta, 'a', 'worker', '', '0 1 2 3 4');
  assert.ok(next);
  assert.equal(next.changeHistory.length, 1);
  assert.equal(next.changeHistory[0].before.labelTxt, '');
  assert.equal(next.changeHistory[0].after.labelTxt, '0 1 2 3 4');
});

test('canEditLabels respects role and status', () => {
  assert.equal(canEditLabels('reviewer', 'submitted'), false);
  assert.equal(canEditLabels('worker', 'submitted'), true);
  assert.equal(canEditLabels('worker', 'approved'), false);
  assert.equal(canEditLabels('worker', 'rejected'), true);
  assert.equal(canEditLabels('worker', 'draft'), true);
});

test('parseYoloMeta falls back for invalid status', () => {
  const parsed = parseYoloMeta(JSON.stringify({ workflowStatus: 'unknown' }));
  assert.equal(parsed.workflowStatus, 'draft');
});

test('workflowStatusLabel returns Korean labels', () => {
  assert.equal(workflowStatusLabel('submitted'), '검수대기');
});
