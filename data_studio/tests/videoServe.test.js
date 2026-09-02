const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectMp4VideoCodec } = require('../server/videoServe');

test('detectMp4VideoCodec identifies mp4v in dataset sample when present', () => {
  const sample = '/opt/clearml/data/datasets/vlm/videos/Smoke/0226.mp4';
  if (!fs.existsSync(sample)) {
    return;
  }
  assert.equal(detectMp4VideoCodec(sample), 'mp4v');
});

test('detectMp4VideoCodec returns unknown for empty file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-codec-'));
  try {
    const file = path.join(tmp, 'empty.mp4');
    fs.writeFileSync(file, Buffer.alloc(0));
    assert.equal(detectMp4VideoCodec(file), 'unknown');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
