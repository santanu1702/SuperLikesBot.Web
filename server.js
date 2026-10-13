'use strict';
const express = require('express'), helmet = require('helmet'), session = require('express-session');
const PgStore = require('connect-pg-simple')(session), rateLimit = require('express-rate-limit');
const crypto = require('crypto'), path = require('path'), { Pool } = require('pg');

const PROD = process.env.NODE_ENV === 'production';
for (const k of ['DATABASE_URL', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'CONFIG_ENCRYPTION_KEY'])
  if (!process.env[k]) { console.error('Missing required env var: ' + k); process.exit(1); }

const dbUrl = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: dbUrl, max: 10,
  ssl: process.env.PGSSL === 'disable' || /localhost|127\.0\.0\.1/.test(dbUrl) ? false : { rejectUnauthorized: false },
});
const KEY = crypto.createHash('sha256').update(process.env.CONFIG_ENCRYPTION_KEY).digest();
const enc = o => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const d = Buffer.concat([c.update(JSON.stringify(o), 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), d]).toString('base64'); };
const dec = s => { const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')); };
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

const APIS = ['like', 'info', 'level', 'jwt'];
const DEFAULT_FIELDS = { like: ['region', 'uid'], info: ['region', 'uid'], level: ['region', 'uid'], jwt: ['uid', 'password'] };
const DEFAULT_LIMIT = { enabled: false, max: 1, periodSeconds: 86400 };

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS regions(code TEXT PRIMARY KEY, label TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS apis(name TEXT PRIMARY KEY, config TEXT NOT NULL, last_ok TIMESTAMPTZ, last_status TEXT, updated_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS like_usage(subject TEXT NOT NULL, bucket BIGINT NOT NULL, count INT NOT NULL DEFAULT 0, PRIMARY KEY(subject, bucket));`);
}
async function getLimit() {
  const r = await pool.query("SELECT value FROM settings WHERE key='like_limit'");
  return r.rows[0] ? { ...DEFAULT_LIMIT, ...r.rows[0].value } : { ...DEFAULT_LIMIT };
}
async function getApi(name) {
  const r = await pool.query('SELECT * FROM apis WHERE name=$1', [name]);
  if (!r.rows[0]) return null;
  try { return { cfg: dec(r.rows[0].config), row: r.rows[0] }; } catch { return null; }
}
const endpointOf = u => { try { const x = new URL(u); return x.origin + decodeURIComponent(x.pathname); } catch { return '(invalid)'; } };
const summary = (name, a) => !a ? { name, configured: false } : {
  name, configured: true, endpoint: endpointOf(a.cfg.url), method: a.cfg.method, fields: a.cfg.fields,
  bodyType: a.cfg.bodyType, hasHeaders: !!Object.keys(a.cfg.headers || {}).length, hasBody: !!a.cfg.body,
  last_ok: a.row.last_ok, last_status: a.row.last_status };

// ---------- atomic Like limit ----------
async function consume(subjects, lim) {
  const bucket = Math.floor(Date.now() / 1000 / lim.periodSeconds), c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const s of subjects) {
      const r = await c.query(`INSERT INTO like_usage(subject,bucket,count) VALUES($1,$2,1)
        ON CONFLICT(subject,bucket) DO UPDATE SET count=like_usage.count+1 WHERE like_usage.count<$3 RETURNING count`, [s, bucket, lim.max]);
      if (!r.rowCount) { await c.query('ROLLBACK'); return null; }
    }
    await c.query('COMMIT'); return { subjects, bucket };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const refund = t => t && pool.query('UPDATE like_usage SET count=GREATEST(count-1,0) WHERE subject=ANY($1) AND bucket=$2', [t.subjects, t.bucket]).catch(() => {});

// ---------- upstream call ----------
const MAX_BYTES = 2 * 1024 * 1024;
const sub = (tpl, vals, mode) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => !(k in vals) ? m :
  mode === 'url' ? encodeURIComponent(vals[k]) : mode === 'json' ? JSON.stringify(vals[k]).slice(1, -1) : vals[k]);
async function callUpstream(cfg, vals, timeoutMs = 15000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = {};
    for (const [k, v] of Object.entries(cfg.headers || {})) headers[k] = sub(v, vals, 'raw');
    let body;
    if (cfg.method !== 'GET' && cfg.bodyType !== 'none' && cfg.body) {
      body = sub(cfg.body, vals, cfg.bodyType === 'json' ? 'json' : 'url');
      if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type'))
        headers['Content-Type'] = cfg.bodyType === 'json' ? 'application/json' : 'application/x-www-form-urlencoded';
    }
    const res = await fetch(sub(cfg.url, vals, 'url'), { method: cfg.method, headers, body, signal: ctl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw Object.assign(new Error('Upstream response too large to display safely'), { safe: true });
    return { status: res.status, ok: res.ok, contentType: res.headers.get('content-type') || '', text: buf.toString('utf8') };
  } catch (e) {
    if (e.safe) throw e;
    throw Object.assign(new Error(e.name === 'AbortError' ? 'Upstream API timed out' : 'Could not reach upstream API'), { safe: true });
  } finally { clearTimeout(t); }
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.get('/health', (req, res) => res.status(200).type('text/plain').send('OK')); // no DB / upstream calls
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], scriptSrc: ["'self'"],
  styleSrc: ["'self'"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } } }));
app.use(express.json({ limit: '32kb' }));
app.use(session({
  name: 'sl.sid', secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, rolling: true,
  store: new PgStore({ pool, createTableIfMissing: true }),
  cookie: { httpOnly: true, secure: PROD, sameSite: 'strict', maxAge: 2 * 3600 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', extensions: ['html'] }));
app.get('/admin', (req, res) => { res.set('X-Robots-Tag', 'noindex'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });

// visitor identity for limits: IP + long-lived anonymous cookie (both counted)
function visitor(req, res) {
  let id = (req.headers.cookie || '').match(/(?:^|; )vid=([a-f0-9]{32})/)?.[1];
  if (!id) { id = crypto.randomBytes(16).toString('hex');
    res.cookie('vid', id, { httpOnly: true, secure: PROD, sameSite: 'lax', maxAge: 365 * 86400 * 1000 }); }
  return ['ip:' + req.ip, 'vid:' + id];
}

const pub = express.Router();
pub.get('/features', async (req, res, next) => { try {
  const features = [];
  for (const n of APIS) { const a = await getApi(n); features.push({ name: n, configured: !!a, fields: a ? a.cfg.fields : undefined }); }
  const regions = (await pool.query('SELECT code,label FROM regions WHERE enabled ORDER BY label')).rows;
  const l = await getLimit();
  res.json({ features, regions, likeLimit: { enabled: l.enabled, max: l.max, periodSeconds: l.periodSeconds } });
} catch (e) { next(e); } });

const inflight = new Set();
pub.post('/run/:name', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down.' } }),
  async (req, res, next) => {
    let ticket = null, lockKey = null;
    try {
      const name = req.params.name;
      if (!APIS.includes(name)) return res.status(404).json({ error: 'Unknown feature' });
      const a = await getApi(name);
      if (!a) return res.status(503).json({ error: `The ${name.toUpperCase()} API is not configured.` });
      const input = req.body && typeof req.body.fields === 'object' && req.body.fields || {}, vals = {};
      for (const f of a.cfg.fields) {
        const v = typeof input[f] === 'string' ? input[f].trim() : '';
        if (!v) return res.status(400).json({ error: `Missing required field: ${f}` });
        if (v.length > 500 || /[\u0000-\u001f]/.test(v)) return res.status(400).json({ error: `Invalid value for ${f}` });
        if (f === 'uid' && !/^\d{4,20}$/.test(v)) return res.status(400).json({ error: 'UID must be 4-20 digits' });
        if (f === 'region') {
          const r = await pool.query('SELECT code FROM regions WHERE code=$1 AND enabled', [v]);
          if (!r.rowCount) return res.status(400).json({ error: 'Selected region is not available' });
        }
        vals[f] = v;
      }
      const who = visitor(req, res);
      lockKey = name + '|' + who[0] + '|' + JSON.stringify(vals);
      if (inflight.has(lockKey)) { lockKey = null; return res.status(409).json({ error: 'This request is already being processed' }); }
      inflight.add(lockKey);
      if (name === 'like') {
        const lim = await getLimit();
        if (lim.enabled) {
          ticket = await consume(who, lim);
          if (!ticket) return res.status(429).json({ error: `Like limit reached (${lim.max} per ${fmtPeriod(lim.periodSeconds)}). Try again later.` });
        }
      }
      let up;
      try { up = await callUpstream(a.cfg, vals); }
      catch (e) { await refund(ticket); return res.status(502).json({ error: e.message }); }
      if (!up.ok) await refund(ticket);
      pool.query('UPDATE apis SET last_ok=CASE WHEN $2 THEN now() ELSE last_ok END, last_status=$3 WHERE name=$1', [name, up.ok, 'HTTP ' + up.status]).catch(() => {});
      let json; try { json = JSON.parse(up.text); } catch {}
      res.status(up.ok ? 200 : 502).json({ ok: up.ok, upstreamStatus: up.status, body: up.text, isJson: json !== undefined,
        error: up.ok ? undefined : `Upstream API returned HTTP ${up.status}` });
    } catch (e) { await refund(ticket); next(e); }
    finally { if (lockKey) inflight.delete(lockKey); }
  });
function fmtPeriod(s) { return s % 86400 === 0 ? (s / 86400 === 1 ? 'day' : s / 86400 + ' days') : s % 3600 === 0 ? (s / 3600 === 1 ? 'hour' : s / 3600 + ' hours') : s + ' seconds'; }
app.use('/api', pub);

// ---------- admin ----------
const adm = express.Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Too many attempts. Try again later.' } });
const csrf = (req, res, next) => (req.method === 'GET' || req.get('x-requested-with') === 'fetch') ? next() : res.status(403).json({ error: 'Forbidden' });
adm.use(csrf);
adm.post('/login', loginLimiter, (req, res, next) => {
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!crypto.timingSafeEqual(sha(pw), sha(process.env.ADMIN_PASSWORD))) return res.status(401).json({ error: 'Incorrect password' });
  req.session.regenerate(err => { if (err) return next(err); req.session.admin = true; res.json({ ok: true }); });
});
adm.post('/logout', (req, res) => req.session.destroy(() => { res.clearCookie('sl.sid'); res.json({ ok: true }); }));
adm.use((req, res, next) => req.session?.admin ? next() : res.status(401).json({ error: 'Unauthorized' }));
adm.get('/me', (req, res) => res.json({ ok: true }));
adm.get('/overview', async (req, res, next) => { try {
  const apis = []; for (const n of APIS) apis.push(summary(n, await getApi(n)));
  const rc = (await pool.query('SELECT count(*) FILTER (WHERE enabled) a, count(*) t FROM regions')).rows[0];
  res.json({ apis, regions: { active: +rc.a, total: +rc.t }, limit: await getLimit() });
} catch (e) { next(e); } });
adm.get('/limit', async (req, res, next) => { try { res.json(await getLimit()); } catch (e) { next(e); } });
adm.put('/limit', async (req, res, next) => { try {
  const { enabled, max, periodSeconds } = req.body || {};
  if (!Number.isInteger(max) || max < 1 || max > 1e6) return res.status(400).json({ error: 'Limit must be a whole number from 1 to 1,000,000' });
  if (!Number.isInteger(periodSeconds) || periodSeconds < 60 || periodSeconds > 31536000) return res.status(400).json({ error: 'Period must be between 60 seconds and 365 days' });
  const v = { enabled: !!enabled, max, periodSeconds };
  await pool.query("INSERT INTO settings(key,value) VALUES('like_limit',$1) ON CONFLICT(key) DO UPDATE SET value=$1", [v]);
  res.json(v);
} catch (e) { next(e); } });
const codeOk = c => typeof c === 'string' && /^[A-Za-z0-9_-]{1,16}$/.test(c);
const labelOk = l => typeof l === 'string' && l.trim().length >= 1 && l.trim().length <= 40;
adm.get('/regions', async (req, res, next) => { try { res.json((await pool.query('SELECT code,label,enabled FROM regions ORDER BY label')).rows); } catch (e) { next(e); } });
adm.post('/regions', async (req, res, next) => { try {
  const { code, label } = req.body || {};
  if (!codeOk(code) || !labelOk(label)) return res.status(400).json({ error: 'Region code (letters, digits, - _ up to 16) and label (1-40 chars) are required' });
  if ((await pool.query('SELECT 1 FROM regions WHERE lower(code)=lower($1)', [code])).rowCount) return res.status(409).json({ error: 'Region already exists' });
  await pool.query('INSERT INTO regions(code,label) VALUES($1,$2)', [code, label.trim()]); res.json({ ok: true });
} catch (e) { next(e); } });
adm.put('/regions/:code', async (req, res, next) => { try {
  const { label, enabled } = req.body || {};
  if (!labelOk(label) || typeof enabled !== 'boolean') return res.status(400).json({ error: 'Invalid label or enabled flag' });
  const r = await pool.query('UPDATE regions SET label=$2, enabled=$3 WHERE code=$1', [req.params.code, label.trim(), enabled]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Region not found' });
} catch (e) { next(e); } });
adm.delete('/regions/:code', async (req, res, next) => { try {
  const r = await pool.query('DELETE FROM regions WHERE code=$1', [req.params.code]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Region not found' });
} catch (e) { next(e); } });

const apiName = (req, res, next) => APIS.includes(req.params.name) ? next() : res.status(404).json({ error: 'Unknown API' });
adm.get('/apis', async (req, res, next) => { try { const o = []; for (const n of APIS) o.push(summary(n, await getApi(n))); res.json(o); } catch (e) { next(e); } });
adm.put('/apis/:name', apiName, async (req, res, next) => { try {
  const b = req.body || {}, prev = await getApi(req.params.name);
  let u; try { u = new URL(String(b.url).replace(/\{(\w+)\}/g, 'x')); } catch { return res.status(400).json({ error: 'A valid http(s) URL is required' }); }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'URL must start with http:// or https://' });
  if (process.env.ALLOW_PRIVATE_UPSTREAM !== '1' && /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(u.hostname)) return res.status(400).json({ error: 'Private or local addresses are not allowed' });
  const method = String(b.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) return res.status(400).json({ error: 'Method must be GET or POST' });
  const fields = (Array.isArray(b.fields) ? b.fields : String(b.fields || '').split(',')).map(s => s.trim()).filter(Boolean);
  if (!fields.length || fields.length > 8 || !fields.every(f => /^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(f))) return res.status(400).json({ error: 'Provide 1-8 input field names (letters, digits, underscore)' });
  const bodyType = ['json', 'form', 'none'].includes(b.bodyType) ? b.bodyType : 'none';
  let headers = prev ? prev.cfg.headers : {};
  if (typeof b.headers === 'string') {            // undefined = keep existing, '' = clear
    if (!b.headers.trim()) headers = {};
    else { try { headers = JSON.parse(b.headers); if (!headers || typeof headers !== 'object' || Array.isArray(headers) || !Object.values(headers).every(v => typeof v === 'string')) throw 0; }
      catch { return res.status(400).json({ error: 'Headers must be a JSON object of string values' }); } }
  }
  const cfg = { url: String(b.url).trim(), method, fields, bodyType, body: String(b.body || ''), headers };
  await pool.query(`INSERT INTO apis(name,config) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET config=$2, updated_at=now(), last_ok=NULL, last_status=NULL`, [req.params.name, enc(cfg)]);
  res.json(summary(req.params.name, await getApi(req.params.name)));
} catch (e) { next(e); } });
adm.delete('/apis/:name', apiName, async (req, res, next) => { try {
  await pool.query('DELETE FROM apis WHERE name=$1', [req.params.name]); res.json({ ok: true });
} catch (e) { next(e); } });
// Connectivity test only: contacts the endpoint's origin without sending any user data or a real Like.
adm.post('/apis/:name/test', apiName, async (req, res, next) => { try {
  const a = await getApi(req.params.name);
  if (!a) return res.status(400).json({ error: 'API is not configured' });
  const origin = new URL(a.cfg.url.replace(/\{(\w+)\}/g, 'x')).origin, ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000), t0 = Date.now();
  try {
    const r = await fetch(origin, { method: 'GET', signal: ctl.signal });
    await pool.query("UPDATE apis SET last_ok=now(), last_status=$2 WHERE name=$1", [req.params.name, 'Reachable (HTTP ' + r.status + ')']);
    res.json({ ok: true, message: `Server reachable (HTTP ${r.status}, ${Date.now() - t0} ms). This does not validate your API request format.` });
  } catch (e) {
    const m = e.name === 'AbortError' ? 'Timed out' : 'Connection failed';
    await pool.query('UPDATE apis SET last_status=$2 WHERE name=$1', [req.params.name, m]);
    res.json({ ok: false, message: m });
  } finally { clearTimeout(t); }
} catch (e) { next(e); } });
app.use('/api/admin', adm);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error('Server error:', err.code || err.name); res.status(500).json({ error: 'Internal server error' }); });

const port = process.env.PORT || 10000;
migrate().then(() => {
  setInterval(async () => { try { const l = await getLimit(); const cur = Math.floor(Date.now() / 1000 / l.periodSeconds);
    await pool.query('DELETE FROM like_usage WHERE bucket < $1', [cur - 1]); } catch {} }, 3600000).unref();
  app.listen(port, '0.0.0.0', () => console.log('Listening on ' + port));
}).catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
