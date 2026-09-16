const test = require('node:test');
const assert = require('node:assert/strict');
const { vlmJsonPathForMediaPath } = require('../shared/vlmJsonPaths');

test('vlmJsonPathForMediaPath maps images to images_json', () => {
  assert.equal(
    vlmJsonPathForMediaPath(
      '/data/datasets/vlm/images/Cigarette/base/Negative/foo.jpg'
    ),
    '/data/datasets/vlm/images_json/Cigarette/base/Negative/foo.json'
  );
});

test('vlmJsonPathForMediaPath maps videos to videos_json', () => {
  assert.equal(
    vlmJsonPathForMediaPath('/data/datasets/vlm/videos/Fire/0089.mp4'),
    '/data/datasets/vlm/videos_json/Fire/0089.json'
  );
});

test('vlmJsonPathForMediaPath leaves unknown layout unchanged except extension', () => {
  assert.equal(
    vlmJsonPathForMediaPath('/data/datasets/detector/foo/bar.jpg'),
    '/data/datasets/detector/foo/bar.json'
  );
});

test('vlmJsonPathForMediaPath maps generated images to images_json/generated', () => {
  assert.equal(
    vlmJsonPathForMediaPath('/data/datasets/vlm/generated/clip_000001.jpg'),
    '/data/datasets/vlm/images_json/generated/clip_000001.json'
  );
});

test('vlmJsonPathForMediaPath maps generated videos to videos_json/generated', () => {
  assert.equal(
    vlmJsonPathForMediaPath('/data/datasets/vlm/generated/clip.mp4'),
    '/data/datasets/vlm/videos_json/generated/clip.json'
  );
});

test('vlmJsonPathForMediaPath maps generated nested images to images_json/generated', () => {
  assert.equal(
    vlmJsonPathForMediaPath('/data/datasets/vlm/generated/clip/000001.jpg'),
    '/data/datasets/vlm/images_json/generated/clip/000001.json'
  );
});
