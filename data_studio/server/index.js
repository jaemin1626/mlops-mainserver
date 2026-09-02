const express = require('express');
const path = require('node:path');
const { createFsRouter } = require('./fsRoutes');

const PORT = Number(process.env.DATA_STUDIO_PORT || 8091);
const app = express();

app.use('/data-studio/api', createFsRouter());
app.use('/data-studio/api', (_req, res) => res.status(404).json({ error: 'not found' }));

const dist = path.join(__dirname, '..', 'dist');
app.use('/data-studio', express.static(dist, { index: false, fallthrough: true }));
app.get(['/data-studio', '/data-studio/*'], (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'));
});

app.get('/api/health', (_req, res) => res.redirect(302, '/data-studio/api/health'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`data-studio listening on ${PORT}`);
});
