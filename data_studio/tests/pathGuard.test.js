// /opt/data_studio/tests/pathGuard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseAllowedRoots,
  resolveSafePath,
  resolveSafePathForWrite,
  assertWritableLabelPath,
} = require('../server/pathGuard');

test('parseAllowedRoots splits comma and colon', () => {
  assert.deepEqual(parseAllowedRoots('/a:/b,/c'), ['/a', '/b', '/c']);
});

test('resolveSafePath rejects path outside roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-out-'));
  const res = resolveSafePath([root], path.join(outside, 'x.txt'));
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test('resolveSafePath accepts path under root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-root-'));
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, '1');
  const res = resolveSafePath([root], file);
  assert.equal(res.ok, true);
  assert.equal(res.path, fs.realpathSync(file));
});

test('assertWritableLabelPath allows .txt, .json, and .meta.json', () => {
  assert.equal(assertWritableLabelPath('/data/datasets/a.txt').ok, true);
  assert.equal(assertWritableLabelPath('/data/datasets/a.json').ok, true);
  assert.equal(assertWritableLabelPath('/data/datasets/a.meta.json').ok, true);
  assert.equal(assertWritableLabelPath('/data/datasets/a.png').ok, false);
});

test('resolveSafePath rejects .. traversal outside root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-root-'));
  const res = resolveSafePath([root], path.join(root, '..', 'escape.txt'));
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test('resolveSafePath rejects symlink pointing outside root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-out-'));
  const outsideFile = path.join(outside, 'secret.txt');
  fs.writeFileSync(outsideFile, 'secret');
  const link = path.join(root, 'link.txt');
  fs.symlinkSync(outsideFile, link);
  const res = resolveSafePath([root], link);
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test('resolveSafePathForWrite accepts nested path before mkdir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-write-'));
  const target = path.join(root, 'videos_json', 'Fire', '0075.json');
  const res = resolveSafePathForWrite([root], target);
  assert.equal(res.ok, true);
  assert.equal(res.path, target);
});

test('resolveSafePathForWrite rejects path outside roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-write-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-write-out-'));
  const res = resolveSafePathForWrite([root], path.join(outside, 'a.json'));
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
});

test('resolveSafePath rejects dangling symlink escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-root-'));
  const outside = path.join(os.tmpdir(), `dangling-target-${Date.now()}.txt`);
  const link = path.join(root, 'label.txt');
  fs.symlinkSync(outside, link);
  const res = resolveSafePath([root], link);
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});
