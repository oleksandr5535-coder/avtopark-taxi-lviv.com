// api/_boltv2.js — ДІАГНОСТИКА нового Bolt Fleet API v2 (підключається в api/bolt-probe.js за параметром ?v2=1).
// Файл з «_» Vercel не рахує окремою функцією, тому ліміт 12 функцій не порушується. Нічого не пише в Supabase,
// наявних функцій не чіпає. Змінні оточення (вже є на Vercel): BOLT_CLIENT_ID, BOLT_CLIENT_SECRET.
//   /api/bolt-probe?v2=1&key=КОД&spec=1   -> HTML-список методів зі специфікації (параметри, обовʼязкові)
//   /api/bolt-probe?v2=1&key=КОД          -> смикає 7 методів v2, таблиця: метод · статус · початок відповіді
//   /api/bolt-probe?v2=1&key=КОД&token=1  -> чистий access_token текстом (для Swagger Authorize; живе ~10 хв)
// Доступ: лише з секретним кодом CRON_SECRET (?key=... або заголовок Authorization: Bearer ...),
// бо адреса віддає токен Bolt.

const COMPANY_ID = 25859;
const BASE = 'https://node.bolt.eu/fleet-integration-gateway-v2/fleetIntegration/v2/';
const SPEC_URL = 'https://node.bolt.eu/fleet-integration-gateway-v2/open-api.json';
const METHODS = ['getCompanies', 'getDrivers', 'getDriverUuids', 'getOnlineDrivers', 'getVehicleUuids', 'getVehicles', 'getRideHistory'];

async function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 15000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); }
  finally { clearTimeout(t); }
}

async function getToken() {
  const id = process.env.BOLT_CLIENT_ID, secret = process.env.BOLT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Немає BOLT_CLIENT_ID або BOLT_CLIENT_SECRET');
  const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials', scope: 'fleet-integration:api' });
  const r = await fetchT('https://oidc.bolt.eu/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, 12000);
  const j = await r.json();
  if (!j.access_token) throw new Error('Токен не отримано: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (title, body) => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title>'
  + '<style>body{font:13px/1.45 system-ui,monospace;margin:16px;color:#1a1c22}h2{margin:0 0 6px}p{color:#555;margin:0 0 12px}table{border-collapse:collapse;width:100%}'
  + 'td,th{border:1px solid #ccc;padding:5px 7px;vertical-align:top;text-align:left}th{background:#eee}.ok{background:#e7f7e7}.no{background:#fbeaea}.mono{font-family:ui-monospace,monospace;word-break:break-all}'
  + 'code{background:#f2f2f2;padding:1px 4px;border-radius:4px}.req{color:#b00020;font-weight:700}.hit{background:#fff6d6;padding:2px 6px;border-radius:4px;margin:2px;display:inline-block}</style></head><body>'
  + body + '</body></html>';

/* ---------- специфікація OpenAPI -> список методів ---------- */
function resolveRef(spec, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').reduce((o, k) => (o && o[k.replace(/~1/g, '/').replace(/~0/g, '~')]), spec) || null;
}
function schemaProps(spec, schema, depth, seen) {
  // повертає [{name, type, required}] для верхнього рівня об'єкта (+ вкладені з крапкою, до 2 рівнів)
  const out = [];
  if (!schema || depth > 2) return out;
  if (schema.$ref) { if (seen.has(schema.$ref)) return out; seen.add(schema.$ref); return schemaProps(spec, resolveRef(spec, schema.$ref), depth, seen); }
  ['allOf', 'oneOf', 'anyOf'].forEach(k => (schema[k] || []).forEach(s => out.push(...schemaProps(spec, s, depth, seen))));
  const req = new Set(schema.required || []);
  Object.keys(schema.properties || {}).forEach(name => {
    let p = schema.properties[name]; const rp = p && p.$ref ? resolveRef(spec, p.$ref) : p;
    const t = (rp && (rp.type || (rp.enum ? 'enum' : '') || (rp.properties ? 'object' : ''))) || '';
    const type = t === 'array' ? 'array<' + ((rp.items && (rp.items.type || (rp.items.$ref ? String(rp.items.$ref).split('/').pop() : ''))) || '?') + '>' : t;
    out.push({ name, type, required: req.has(name) });
    if (rp && rp.type === 'object' && rp.properties && depth < 2) schemaProps(spec, rp, depth + 1, new Set(seen)).forEach(c => out.push({ name: name + '.' + c.name, type: c.type, required: c.required && req.has(name) }));
  });
  return out;
}
async function specPage() {
  let r = await fetchT(SPEC_URL, { headers: { Accept: 'application/json' } }, 15000);
  let how = 'без токена';
  let txt = await r.text(), spec = null;
  try { spec = JSON.parse(txt); } catch (e) { spec = null; }
  if (!spec || !spec.paths) {                              // якщо специфікація закрита — пробуємо з токеном
    const token = await getToken();
    r = await fetchT(SPEC_URL, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token } }, 15000);
    how = 'з токеном'; txt = await r.text();
    try { spec = JSON.parse(txt); } catch (e) { spec = null; }
  }
  if (!spec || !spec.paths) return page('Bolt v2 spec', '<h2>Специфікацію не вдалося прочитати</h2><p>HTTP ' + r.status + ' (' + how + '). Початок відповіді:</p><pre class="mono">' + esc(txt.slice(0, 1200)) + '</pre>');
  const rows = [];
  Object.keys(spec.paths).forEach(path => Object.keys(spec.paths[path] || {}).forEach(m => {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(m)) return;
    const op = spec.paths[path][m] || {};
    let bodySchema = null;
    const rb = op.requestBody && (op.requestBody.$ref ? resolveRef(spec, op.requestBody.$ref) : op.requestBody);
    if (rb && rb.content) { const c = rb.content['application/json'] || Object.values(rb.content)[0]; bodySchema = c && c.schema; }
    const params = (op.parameters || []).map(p => { p = p.$ref ? resolveRef(spec, p.$ref) || p : p; return { name: (p.in ? p.in + ':' : '') + p.name, type: (p.schema && p.schema.type) || '', required: !!p.required }; });
    const props = schemaProps(spec, bodySchema, 0, new Set());
    rows.push('<tr><td class="mono"><b>' + esc(m.toUpperCase()) + '</b> ' + esc(path) + '</td><td>' + esc(op.summary || op.operationId || '') + (op.description ? '<br><small>' + esc(String(op.description).slice(0, 300)) + '</small>' : '') + '</td><td class="mono">'
      + params.concat(props).map(p => (p.required ? '<span class="req">' + esc(p.name) + '*</span>' : esc(p.name)) + ': ' + esc(p.type)).join('<br>') + '</td></tr>');
  }));
  const hits = [...new Set((txt.match(/[A-Za-z_]*(campaign|bonus|brand|compensat|incentive|promo|reward)[A-Za-z_]*/gi) || []).map(s => s.toLowerCase()))].slice(0, 40);
  const info = spec.info ? esc((spec.info.title || '') + ' ' + (spec.info.version || '')) : '';
  return page('Bolt Fleet API v2 — специфікація',
    '<h2>Bolt Fleet API v2 · специфікація</h2><p>' + info + ' · отримано ' + how + ' · методів: ' + rows.length + ' · <span class="req">*</span> = обовʼязкове</p>'
    + '<p>Слова про кампанії/бонуси/брендування у специфікації: ' + (hits.length ? hits.map(h => '<span class="hit">' + esc(h) + '</span>').join('') : '<b>не знайдено</b>') + '</p>'
    + '<table><thead><tr><th>Метод</th><th>Опис</th><th>Параметри (тіло/запит)</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>');
}

/* ---------- перебір 7 методів ---------- */
async function probePage() {
  const token = await getToken();
  const now = Math.floor(Date.now() / 1000);
  const body = { company_id: COMPANY_ID, company_ids: [COMPANY_ID], start_ts: now - 86400, end_ts: now, offset: 0, limit: 50 };
  const rows = await Promise.all(METHODS.map(async m => {
    let status = '?', snippet = '';
    try {
      const r = await fetchT(BASE + m, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 20000);
      status = r.status; snippet = (await r.text()).slice(0, 400);
    } catch (e) { status = 'ERR'; snippet = (e && e.message || '').slice(0, 200); }
    return { m, status, snippet };
  }));
  return page('Bolt v2 перебір',
    '<h2>Bolt Fleet API v2 · перебір методів</h2><p>Тіло запиту: company_id=' + COMPANY_ID + ', company_ids, start_ts/end_ts за останню добу, offset 0, limit 50. 200 = метод відповів. При 702 дивіться <code>validation_errors</code> — там видно, яких полів бракує.</p>'
    + '<table><thead><tr><th>Метод</th><th>HTTP</th><th>Початок відповіді (~400 симв.)</th></tr></thead><tbody>'
    + rows.map(r => '<tr class="' + (String(r.status) === '200' ? 'ok' : 'no') + '"><td class="mono">' + esc(r.m) + '</td><td>' + esc(r.status) + '</td><td class="mono">' + esc(r.snippet) + '</td></tr>').join('') + '</tbody></table>');
}

export async function probeV2(req, res) {
  const q = req.query || {};
  const h = String(req.headers['authorization'] || '');
  const given = h.startsWith('Bearer ') ? h.slice(7).trim() : String(q.key || '');
  if (!process.env.CRON_SECRET || given !== process.env.CRON_SECRET) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(401).send(JSON.stringify({ ok: false, error: 'Немає доступу' }));
  }
  try {
    if (q.token) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(200).send(await getToken()); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(q.spec ? await specPage() : await probePage());
  } catch (e) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(page('Помилка', '<h2>Помилка</h2><pre class="mono">' + esc(e && e.message) + '</pre>'));
  }
}
