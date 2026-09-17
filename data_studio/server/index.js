const express = require('express');
const path = require('node:path');
const { createFsRouter } = require('./fsRoutes');

const PORT = Number(process.env.DATA_STUDIO_PORT || 8091);
const app = express();
const ACCESS_CONTROL_URL = process.env.ACCESS_CONTROL_URL || 'http://access-control:8095';

app.use('/data-studio/api', async (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  try {
    const options = { headers: { cookie: req.headers.cookie || '' }, signal: AbortSignal.timeout(5000) };
    const work = await fetch(`${ACCESS_CONTROL_URL}/authorize?permission=LABEL_WORK`, options);
    if (!work.ok) {
      const review = await fetch(`${ACCESS_CONTROL_URL}/authorize?permission=LABEL_REVIEW`, options);
      if (!review.ok) return res.status(work.status === 401 ? 401 : 403).json({ error: '라벨링 작업 또는 검수 권한이 필요합니다.' });
    }
    next();
  } catch (_err) {
    res.status(503).json({ error: '권한 서비스를 확인할 수 없습니다.' });
  }
});

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
