/**
 * Smoke test for the security middleware. Does NOT require Firebase / JWT /
 * encryption keys — we wire `middleware/security.js` into a minimal Express
 * app and exercise the four guarantees we care about:
 *
 *   1. CORS allow-list works, wildcard is rejected in production.
 *   2. Tiered rate limiters trip at the configured threshold.
 *   3. Body-size limits reject oversized JSON.
 *   4. Error responses are sanitised — stack traces / internal details do
 *      NOT reach the client; an `errorId` is returned instead.
 *
 * Run with:
 *   node tests/security.smoke.js
 */

const assert = require('assert');
const http = require('http');
const express = require('express');
const cors = require('cors');

process.env.NODE_ENV = 'production';
process.env.CORS_ORIGIN = 'https://wyth.app,https://www.wyth.app';
process.env.RL_GLOBAL_MAX = '100';
process.env.RL_PASSWORD_MAX = '2';
process.env.RL_UPLOAD_MAX = '3';

const {
  corsOptions,
  globalLimiter,
  passwordLimiter,
  uploadLimiter,
  sanitizeJsonResponses,
  errorHandler,
  isOriginAllowed,
} = require('../middleware/security');

function buildApp() {
  const app = express();
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '1kb' }));
  app.use(sanitizeJsonResponses);

  app.use('/api/profile/password', passwordLimiter);
  app.use('/api/upload', uploadLimiter);
  app.use('/api/', globalLimiter);

  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  app.post('/api/profile/password', (req, res) => res.json({ ok: true }));
  app.post('/api/upload', (req, res) => res.json({ ok: true }));
  app.post('/api/echo', (req, res) => res.json({ ok: true, len: JSON.stringify(req.body).length }));

  // Deliberate explosion to test the sanitiser
  app.get('/api/boom', (req, res) => {
    res.status(500).json({
      success: false,
      error:
        'TypeError: Cannot read property "uid" of undefined\n    at /app/backend/routes/x.js:42\n    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)\nFIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----xyz',
    });
  });

  // Validation-style 400 should pass through unchanged
  app.get('/api/badreq', (req, res) => {
    res.status(400).json({ success: false, error: 'Email is required' });
  });

  app.use(errorHandler);
  return app;
}

function request(server, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const app = buildApp();
  const server = http.createServer(app).listen(0);
  await new Promise((r) => server.on('listening', r));

  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) { console.log('  ✅', name); pass++; }
    else { console.log('  ❌', name, extra); fail++; }
  };

  // ── 1. CORS ───────────────────────────────────────────────────────────────
  console.log('\n[1] CORS allow-list');
  check('allow listed origin', isOriginAllowed('https://wyth.app'));
  check('reject unlisted origin', !isOriginAllowed('https://evil.example.com'));
  check('reject wildcard literal as origin', !isOriginAllowed('*'));
  const r1 = await request(server, 'GET', '/api/ping', { Origin: 'https://wyth.app' });
  check('listed origin gets ACAO header', r1.headers['access-control-allow-origin'] === 'https://wyth.app');
  const r2 = await request(server, 'GET', '/api/ping', { Origin: 'https://evil.example.com' });
  check('unlisted origin gets NO ACAO header', !r2.headers['access-control-allow-origin']);

  // ── 2. Rate limiting ──────────────────────────────────────────────────────
  console.log('\n[2] Rate limiting (tiered)');
  // password limiter: max 2 per window
  let last;
  for (let i = 0; i < 4; i++) {
    last = await request(server, 'POST', '/api/profile/password', { 'Content-Type': 'application/json' }, {});
  }
  check('password endpoint trips at 3rd request (max=2)', last.status === 429);

  // upload limiter: max 3
  let lastUp;
  for (let i = 0; i < 5; i++) {
    lastUp = await request(server, 'POST', '/api/upload', { 'Content-Type': 'application/json' }, {});
  }
  check('upload endpoint trips at 4th request (max=3)', lastUp.status === 429);

  // ── 3. Body size ──────────────────────────────────────────────────────────
  console.log('\n[3] Body-size limit');
  const huge = 'x'.repeat(5000);
  const rBig = await request(server, 'POST', '/api/echo', { 'Content-Type': 'application/json' }, { huge });
  check('oversized JSON rejected (>1kb)', rBig.status === 413);

  // ── 4. Error sanitisation ─────────────────────────────────────────────────
  console.log('\n[4] Error sanitisation');
  const boom = await request(server, 'GET', '/api/boom');
  const boomJson = JSON.parse(boom.body);
  check('5xx error message replaced with generic category', boomJson.error === 'Server error');
  check('5xx error includes errorId for log correlation', typeof boomJson.errorId === 'string' && boomJson.errorId.length > 0);
  check('5xx response does NOT leak stack trace', !/at\s+\//.test(boom.body) && !/FIREBASE_PRIVATE_KEY/.test(boom.body));

  const bad = await request(server, 'GET', '/api/badreq');
  const badJson = JSON.parse(bad.body);
  check('safe 4xx validation message passes through unchanged', badJson.error === 'Email is required');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
