const test = require('node:test');
const assert = require('node:assert/strict');
const { vlmJsonPathForMediaPath } = require('../shared/vlmJsonPaths');

test('image label JSON is stored beside its image', () => {
  assert.equal(vlmJsonPathForMediaPath('/data/datasets/vlm/images/Cigarette/foo.jpg'), '/data/datasets/vlm/images/Cigarette/foo.json');
});

test('video label JSON is stored beside its video', () => {
  assert.equal(vlmJsonPathForMediaPath('/data/datasets/vlm/videos/Fire/0089.mp4'), '/data/datasets/vlm/videos/Fire/0089.json');
});

test('generated media also uses a sidecar JSON', () => {
  assert.equal(vlmJsonPathForMediaPath('/data/datasets/vlm/images/generate/clip/001.png'), '/data/datasets/vlm/images/generate/clip/001.json');
});

test('extensionless path receives json extension', () => {
  assert.equal(vlmJsonPathForMediaPath('/data/datasets/vlm/images/sample'), '/data/datasets/vlm/images/sample.json');
});
