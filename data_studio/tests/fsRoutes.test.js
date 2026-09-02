const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createFsRouter } = require('../server/fsRoutes');

let root;
let baseUrl;
let server;
let previousAllowedRoots;

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-studio-fs-routes-'));
  previousAllowedRoots = process.env.DATA_STUDIO_ALLOWED_ROOTS;
  process.env.DATA_STUDIO_ALLOWED_ROOTS = root;

  const app = express();
  app.use('/data-studio/api', createFsRouter());
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}/data-studio/api`;
});

test.after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  fs.rmSync(root, { recursive: true, force: true });
  if (previousAllowedRoots === undefined) {
    delete process.env.DATA_STUDIO_ALLOWED_ROOTS;
  } else {
    process.env.DATA_STUDIO_ALLOWED_ROOTS = previousAllowedRoots;
  }
});

async function putFile(body) {
  return fetch(`${baseUrl}/fs/file`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET health returns ok', async () => {
  const response = await fetch(`${baseUrl}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('PUT rejects non-.txt/.json paths', async () => {
  const response = await putFile({ path: path.join(root, 'label.png'), content: 'label' });

  assert.equal(response.status, 400);
});

test('PUT rejects missing, null, and object content', async () => {
  for (const content of [undefined, null, { label: 1 }]) {
    const body = { path: path.join(root, 'label.txt') };
    if (content !== undefined) body.content = content;

    const response = await putFile(body);

    assert.equal(response.status, 400);
  }
});

test('PUT rejects empty and non-string paths', async () => {
  for (const invalidPath of ['', '   ', null, { path: 'label.txt' }]) {
    const response = await putFile({ path: invalidPath, content: 'label' });

    assert.equal(response.status, 400);
  }
});

test('GET list and images reject paths outside allowed roots', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'data-studio-outside-'));
  try {
    for (const route of ['list', 'images']) {
      const response = await fetch(`${baseUrl}/fs/${route}?path=${encodeURIComponent(outside)}`);

      assert.equal(response.status, 400);
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('PUT writes valid .txt content under an allowed root', async () => {
  const labelPath = path.join(root, 'label.txt');

  const response = await putFile({ path: labelPath, content: '' });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(fs.readFileSync(labelPath, 'utf8'), '');
});

test('PUT writes valid .json content under an allowed root', async () => {
  const labelPath = path.join(root, 'label.json');
  const content = '{"label":"test"}';

  const response = await putFile({ path: labelPath, content });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(fs.readFileSync(labelPath, 'utf8'), content);
});

test('GET fs/file serves video with correct content type and range support', async () => {
  const videoPath = path.join(root, 'sample.mp4');
  fs.writeFileSync(videoPath, Buffer.from('fake-mp4-bytes'));

  const response = await fetch(`${baseUrl}/fs/file?path=${encodeURIComponent(videoPath)}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
});