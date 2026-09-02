const test = require('node:test');
const assert = require('node:assert/strict');

function resolveRelativePath(baseDir, relativePath) {
  const base = String(baseDir || '').replace(/\\/g, '/');
  const rel = String(relativePath || '').replace(/\\/g, '/');
  const isAbs = base.startsWith('/');
  const baseParts = base.split('/').filter((part, index) => part.length > 0 || (index === 0 && isAbs));
  const stack = (isAbs && baseParts[0] === '' ? baseParts.slice(1) : baseParts.filter(Boolean)).slice();
  for (const segment of rel.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return (isAbs ? '/' : '') + stack.join('/');
}

function extractVlmMediaPathFromRecord(record) {
  if (!record) return '';
  const media = String(record.media ?? '').trim();
  if (media) return media;
  const video = String(record.video ?? record.video_path ?? record.videoPath ?? '').trim();
  if (video) return video;
  return String(record.image ?? record.image_path ?? record.imagePath ?? '').trim();
}

test('extractVlmMediaPathFromRecord prefers media then video then image', () => {
  assert.equal(extractVlmMediaPathFromRecord({ video: '../videos/Fire/0075.mp4' }), '../videos/Fire/0075.mp4');
  assert.equal(extractVlmMediaPathFromRecord({ media: 'a.jpg', video: 'b.mp4' }), 'a.jpg');
  assert.equal(extractVlmMediaPathFromRecord({ image: 'a.jpg' }), 'a.jpg');
});

test('resolveRelativePath resolves ../videos from json directory', () => {
  const jsonDir = '/data/datasets/vlm/task/json';
  assert.equal(
    resolveRelativePath(jsonDir, '../videos/Fire/0075.mp4'),
    '/data/datasets/vlm/task/videos/Fire/0075.mp4'
  );
});

test('resolveRelativePath resolves sibling images path', () => {
  const imagesBase = '/data/datasets/vlm/task/images';
  assert.equal(
    resolveRelativePath(imagesBase, 'Event/Person/sample.jpg'),
    '/data/datasets/vlm/task/images/Event/Person/sample.jpg'
  );
});
