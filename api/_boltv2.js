// api/_boltv2.js — ДІАГНОСТИКА нового Bolt Fleet API v2 (підключається в api/bolt-probe.js за параметром ?v2=1).
// Файл з «_» Vercel не рахує окремою функцією, тому ліміт 12 функцій не порушується. Нічого не пише в Supabase,
// наявних функцій не чіпає. Змінні оточення (вже є на Vercel): BOLT_CLIENT_ID, BOLT_CLIENT_SECRET.
//   /api/bolt-probe?v2=1&key=КОД&spec=1   -> HTML-список методів зі специфікації (параметри, обовʼязкові)
//   /api/bolt-probe?v2=1&key=КОД          -> смикає 7 методів v2, таблиця: метод · статус · початок відповіді
//   /api/bolt-probe?v2=1&key=КОД&token=1  -> чистий access_token текстом (для Swagger Authorize; живе ~10 хв)
// Доступ: лише з секретним кодом CRON_SECRET (?key=... або заголовок Authorization: Bearer ...),
// бо адреса віддає токен Bolt.

import { kyivDayRange } from './_day.js';
import { boltByDriver } from './sync.js';
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

async function getToken(useOld) {
  const id = useOld ? process.env.BOLT_CLIENT_ID : (process.env.BOLT_V2_CLIENT_ID || process.env.BOLT_CLIENT_ID), secret = useOld ? process.env.BOLT_CLIENT_SECRET : (process.env.BOLT_V2_CLIENT_SECRET || process.env.BOLT_CLIENT_SECRET);
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
  const B = 'https://node.bolt.eu/fleet-integration-gateway-v2/';
  const cands = [SPEC_URL, B + 'openapi.json', B + 'swagger.json', B + 'docs/json', B + 'documentation/json', B + 'docs-json', B + 'api-json', B + 'swagger/json', B + 'fleetIntegration/v2/open-api.json', B + 'fleetIntegration/v2/openapi.json', B + 'fleetIntegration/open-api.json', B + 'v2/api-docs', B + 'docs', B + 'documentation'];
  const tried = []; let r = null, txt = '', spec = null, how = '', token = null;
  for (const u of cands) {
    for (const withTok of [false, true]) {
      try {
        const h = { Accept: 'application/json' };
        if (withTok) { token = token || await getToken(); h.Authorization = 'Bearer ' + token; }
        r = await fetchT(u, { headers: h }, 4000); txt = await r.text(); spec = null;
        try { spec = JSON.parse(txt); } catch (e) { spec = null; }
        tried.push(r.status + (withTok ? ' (токен) ' : ' ') + u.replace(B, '…/'));
        if (spec && spec.paths) { how = (withTok ? 'з токеном' : 'без токена') + ', ' + u; break; }
      } catch (e) { tried.push('помилка ' + u.replace(B, '…/')); }
      if (r && r.status === 404) break;      // з токеном той самий 404 — далі не пробуємо
    }
    if (spec && spec.paths) break;
  }
  if (!spec || !spec.paths) return page('Bolt v2 spec', '<h2>Специфікацію не вдалося прочитати</h2><p>HTTP ' + r.status + ' (' + how + '). Початок відповіді:</p><pre class="mono">' + esc(txt.slice(0, 600)) + '</pre><p>Що пробували:</p><pre class="mono">' + esc(tried.join('\n')) + '</pre>');
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
  const body = { company_id: COMPANY_ID, company_ids: [COMPANY_ID], filter: {}, start_ts: now - 86400, end_ts: now, start_datetime: new Date((now - 86400) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), end_datetime: new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'), offset: 0, limit: 50 };
  const jobs = METHODS.map(m => ({ m, label: m, b: body }));
  ['getDriverUuids', 'getVehicleUuids'].forEach(m => ['all', 'zzz'].forEach(t => jobs.push({ m, label: m + ' [filter.type=' + t + ']', b: Object.assign({}, body, { filter: { type: t } }) })));
  const rows = await Promise.all(jobs.map(async j => {
    const m = j.m; let status = '?', snippet = '';
    try {
      const r = await fetchT(BASE + m, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(j.b) }, 20000);
      status = r.status; snippet = (await r.text()).slice(0, 400);
    } catch (e) { status = 'ERR'; snippet = (e && e.message || '').slice(0, 200); }
    return { m: j.label, status, snippet };
  }));
  return page('Bolt v2 перебір',
    '<h2>Bolt Fleet API v2 · перебір методів</h2><p>Тіло запиту: company_id=' + COMPANY_ID + ', company_ids, filter {}, start_ts/end_ts та start_datetime/end_datetime за останню добу, offset 0, limit 50. 200 = метод відповів. При 702 дивіться <code>validation_errors</code> — там видно, яких полів бракує.</p>'
    + '<table><thead><tr><th>Метод</th><th>HTTP</th><th>Початок відповіді (~400 симв.)</th></tr></thead><tbody>'
    + rows.map(r => '<tr class="' + (String(r.status) === '200' ? 'ok' : 'no') + '"><td class="mono">' + esc(r.m) + '</td><td>' + esc(r.status) + '</td><td class="mono">' + esc(r.snippet) + '</td></tr>').join('') + '</tbody></table>');
}

// ?shape=1 — які поля віддає кожен метод (без персональних даних: імена, телефони, пошта, координати, коди маскуються)
const SECRET_KEY = /email|phone|name|lat|lng|location|vin|code|uuid|reference|plate|registration|licen[cs]e|address|photo|url|token|iban|card/i;
function flat(o, pre, out, depth) {
  if (o === null || typeof o !== 'object') { out.push([pre, o]); return; }
  if (Array.isArray(o)) { out.push([pre + '[]', o.length ? (typeof o[0] === 'object' ? '(обʼєкти)' : o[0]) : '(порожньо)']); if (o[0] && typeof o[0] === 'object' && depth < 4) flat(o[0], pre + '[]', out, depth + 1); return; }
  Object.keys(o).forEach(k => { if (depth < 5) flat(o[k], pre ? pre + '.' + k : k, out, depth + 1); });
}
async function shapePage() {
  const token = await getToken();
  const now = Math.floor(Date.now() / 1000);
  const iso = t => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = { company_id: COMPANY_ID, company_ids: [COMPANY_ID], start_ts: now - 86400, end_ts: now, start_datetime: iso(now - 86400), end_datetime: iso(now), offset: 0, limit: 50 };
  const methods = ['getCompanies', 'getDrivers', 'getOnlineDrivers', 'getVehicles', 'getRideHistory'];
  const blocks = await Promise.all(methods.map(async m => {
    let out = '';
    try {
      const r = await fetchT(BASE + m, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 20000);
      const j = await r.json(); const d = j && j.data || {};
      const tops = Object.keys(d).map(k => k + (Array.isArray(d[k]) ? ' [' + d[k].length + ' шт.]' : ' = ' + esc(JSON.stringify(d[k]).slice(0, 80)))).join(', ');
      const arrKey = Object.keys(d).find(k => Array.isArray(d[k])); const arr = arrKey ? d[arrKey] : [];
      const seen = new Map();
      arr.forEach(rec => { const f = []; flat(rec, '', f, 0); f.forEach(([k, v]) => { if (!seen.has(k) || (seen.get(k) == null && v != null)) seen.set(k, v); }); });
      const cnt = {};
      if (m === 'getRideHistory') arr.forEach(o => { const k = (o.status || '?') + ' / ' + (o.payment_method || '?'); cnt[k] = (cnt[k] || 0) + 1; });
      out += '<h3>' + m + ' <span class="mono">(код ' + esc(j.code) + ', ' + esc(j.message) + ')</span></h3><p>data: ' + (tops || '—') + '</p>';
      if (Object.keys(cnt).length) out += '<p>Статус / оплата (за добу, до 50): ' + Object.keys(cnt).map(k => esc(k) + ' × ' + cnt[k]).join('; ') + '</p>';
      out += '<table><thead><tr><th>Поле</th><th>Приклад</th></tr></thead><tbody>' + [...seen.entries()].map(([k, v]) => '<tr><td class="mono">' + esc(k) + '</td><td class="mono">' + (SECRET_KEY.test(k) && v != null ? '•••' : esc(String(v).slice(0, 60))) + '</td></tr>').join('') + '</tbody></table>';
    } catch (e) { out += '<h3>' + m + '</h3><pre class="mono">' + esc(e && e.message) + '</pre>'; }
    return out;
  }));
  return page('Bolt v2 поля', '<h2>Bolt Fleet API v2 · які поля віддає</h2><p>Персональні дані замасковані (•••). Приклад береться з перших записів.</p>' + blocks.join(''));
}

// ?guess=1 — чи існують методи з правдоподібними назвами (404 = немає, інакше — є)
async function guessPage() {
  const token = await getToken();
  const names = ['getEarnings', 'getDriverEarnings', 'getDriversEarnings', 'getFleetEarnings', 'getEarningsReport', 'getPayouts', 'getDriverPayouts', 'getPayments', 'getPaymentReport', 'getStatements', 'getWeeklyReport', 'getDailyReport', 'getReport', 'getReports', 'getBonuses', 'getDriverBonuses', 'getCampaigns', 'getIncentives', 'getPromotions', 'getDriverStats', 'getDriverStatistics', 'getFleetStats', 'getOrders', 'getFleetOrders', 'getOrderDetails', 'getOrder', 'getRideDetails', 'getDriverBalance', 'getBalance', 'getTransactions', 'getDriverTransactions', 'getFinancialReport', 'getDriverReport', 'getStateLogs', 'getFleetStateLogs', 'getDriverActivity', 'getVehicleReport'];
  const now = Math.floor(Date.now() / 1000);
  const iso = t => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const body = { company_id: COMPANY_ID, company_ids: [COMPANY_ID], start_ts: now - 86400, end_ts: now, start_datetime: iso(now - 86400), end_datetime: iso(now), offset: 0, limit: 5 };
  const rows = await Promise.all(names.map(async m => {
    try {
      const r = await fetchT(BASE + m, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 8000);
      return { m, status: r.status, snippet: (await r.text()).slice(0, 200) };
    } catch (e) { return { m, status: 'ERR', snippet: (e && e.message || '').slice(0, 100) }; }
  }));
  const found = rows.filter(r => r.status !== 404);
  return page('Bolt v2 guess', '<h2>Перебір назв методів</h2><p>404 = такого методу немає. Усе інше = метод існує. Знайдено: <b>' + found.length + '</b> з ' + rows.length + '.</p>'
    + '<table><thead><tr><th>Метод</th><th>HTTP</th><th>Відповідь</th></tr></thead><tbody>'
    + rows.sort((a, b) => (a.status === 404) - (b.status === 404)).map(r => '<tr class="' + (r.status === 404 ? 'no' : 'ok') + '"><td class="mono">' + esc(r.m) + '</td><td>' + esc(r.status) + '</td><td class="mono">' + esc(r.status === 404 ? '' : r.snippet) + '</td></tr>').join('') + '</tbody></table>');
}

// ?v1shape=1 — усі поля відповіді v1 getFleetOrders (за останні 3 доби) і скільки разів вони заповнені
async function v1ShapePage() {
  const token = await getToken(true);
  const now = Math.floor(Date.now() / 1000);
  const body = { company_ids: [COMPANY_ID], company_id: COMPANY_ID, start_ts: now - 3 * 86400, end_ts: now, offset: 0, limit: 500 };
  const r = await fetchT('https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1/getFleetOrders', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 25000);
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
  if (!j) return page('v1 shape', '<h2>Відповідь не JSON</h2><pre class="mono">' + esc(r.status + ' ' + txt.slice(0, 600)) + '</pre>');
  const d = j.data || {}; const arr = Array.isArray(d.orders) ? d.orders : [];
  const top = Object.keys(d).filter(k => !Array.isArray(d[k])).map(k => k + '=' + JSON.stringify(d[k]).slice(0, 60)).join(', ');
  const st = {};
  const stat = new Map();
  arr.forEach(o => { st[o.order_status || '?'] = (st[o.order_status || '?'] || 0) + 1; const f = []; flat(o, '', f, 0); f.forEach(([k, v]) => { const e = stat.get(k) || { n: 0, nz: 0, ex: null }; e.n++; if (v !== null && v !== '' && v !== 0 && v !== false) { e.nz++; if (e.ex == null) e.ex = v; } stat.set(k, e); }); });
  const rows = [...stat.entries()].map(([k, e]) => '<tr><td class="mono">' + esc(k) + '</td><td>' + e.n + '</td><td>' + e.nz + '</td><td class="mono">' + (SECRET_KEY.test(k) && e.ex != null ? '•••' : esc(String(e.ex == null ? '' : e.ex).slice(0, 50))) + '</td></tr>').join('');
  return page('Bolt v1 поля', '<h2>Bolt v1 getFleetOrders · які поля віддає</h2><p>HTTP ' + r.status + ', код ' + esc(j.code) + ' ' + esc(j.message) + '. Записів: ' + arr.length + '. ' + esc(top) + '</p><p>Статуси: ' + Object.keys(st).map(k => esc(k) + ' × ' + st[k]).join('; ') + '</p>'
    + '<table><thead><tr><th>Поле</th><th>Є у записів</th><th>Не нульове</th><th>Приклад (не нульове)</th></tr></thead><tbody>' + rows + '</tbody></table>');
}

// ?week=YYYY-MM-DD (понеділок) — звірка по водіях: наше чисте (merge, як у дашборді) проти складових, з яких може складатись «Чистий дохід» Bolt
async function v1Orders(token, date, trt) {
  const { from, to } = kyivDayRange(date);
  let offset = 0, all = [];
  for (let g = 0; g < 20; g++) {
    const body = { company_ids: [COMPANY_ID], company_id: COMPANY_ID, start_ts: from, end_ts: to, offset, limit: 1000 };
    if (trt) body.time_range_filter_type = trt;
    const r = await fetchT('https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1/getFleetOrders', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 25000);
    let j = await r.json();
    for (let t = 0; t < 6 && j.code === 1005; t++) {            // TOO_MANY_REQUESTS — зачекати й повторити
      await new Promise(rs => setTimeout(rs, 2500 * (t + 1)));
      const r2_ = await fetchT('https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1/getFleetOrders', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 25000);
      j = await r2_.json();
    }
    if (j.code !== 0) throw new Error('Bolt ' + date + ': ' + j.code + ' ' + j.message);
    const arr = (j.data && j.data.orders) || []; all = all.concat(arr);
    if (arr.length < 1000) break; offset += 1000;
  }
  return all;
}
const nap = ms => new Promise(rs => setTimeout(rs, ms));
// один день: JSON з агрегатами по водіях (merge, як у дашборді)
async function dayAgg(date) {
  const token = await getToken(true);
  const none = await v1Orders(token, date, null); await nap(700);
  const pr = await v1Orders(token, date, 'price_review');
  const prRef = new Set(pr.map(o => o.order_reference));
  const merged = pr.concat(none.filter(o => !prRef.has(o.order_reference) && o.order_status !== 'finished'));
  const by = boltByDriver(merged); const out = {};
  merged.forEach(o => {
    const n = o.driver_name || ''; if (!n) return; const p = o.order_price || {};
    const a = out[n] || (out[n] = { net: 0, gross: 0, comm: 0, tip: 0, cancelNF: 0, netNF: 0, inapp: 0, cashd: 0, book: 0 });
    if (o.order_status === 'finished') { a.gross += p.ride_price || 0; a.comm += p.commission || 0; a.tip += p.tip || 0; a.inapp += p.in_app_discount || 0; a.cashd += p.cash_discount || 0; a.book += p.booking_fee || 0; }
    else { a.cancelNF += p.cancellation_fee || 0; a.netNF += p.net_earnings || 0; }
  });
  Object.keys(by).forEach(n => { if (out[n]) out[n].net = by[n].net; });
  return { date, n: merged.length, drivers: out };
}
// сторінка тижня: сама по черзі питає день за днем (щоб не впиратись у ліміти часу й запитів)
function weekPage(monday) {
  const script = `
const key=new URLSearchParams(location.search).get('key');const mon=${JSON.stringify(monday)};
const days=[];const d0=new Date(mon+'T12:00:00Z');for(let i=0;i<7;i++)days.push(new Date(d0.getTime()+i*864e5).toISOString().slice(0,10));
const st=document.getElementById('st'),tb=document.getElementById('tb');const tot={};const f=x=>(Math.round(x*100)/100).toFixed(2);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{for(const d of days){let ok=false;for(let t=0;t<8&&!ok;t++){st.textContent='Вантажу '+d+(t?' (повтор '+t+')':'')+'…';
try{const r=await fetch(location.pathname+'?v2=1&key='+encodeURIComponent(key)+'&dayagg='+d);const j=await r.json();
if(j.ok){ok=true;Object.entries(j.drivers).forEach(([n,a])=>{const x=tot[n]||(tot[n]={net:0,gross:0,comm:0,tip:0,cancelNF:0,netNF:0,inapp:0,cashd:0,book:0});Object.keys(x).forEach(k=>x[k]+=a[k]||0)});}
else{st.textContent=d+': '+(j.error||'помилка')+' — чекаю і повторюю';await sleep(4000)}}catch(e){st.textContent=d+': '+e.message;await sleep(4000)}}
if(!ok){st.textContent='Не вдалося завантажити '+d+'. Оновіть сторінку трохи пізніше.';return}await sleep(1500)}
st.textContent='Готово.';const names=Object.keys(tot).filter(n=>tot[n].net||tot[n].cancelNF||tot[n].netNF).sort();
let T={net:0,tip:0,cancelNF:0,netNF:0};
tb.innerHTML=names.map(n=>{const a=tot[n];T.net+=a.net;T.tip+=a.tip;T.cancelNF+=a.cancelNF;T.netNF+=a.netNF;return '<tr><td>'+n+'</td><td><b>'+f(a.net)+'</b></td><td>'+f(a.gross)+'</td><td>'+f(a.comm)+'</td><td>'+f(a.tip)+'</td><td>'+f(a.cancelNF)+'</td><td>'+f(a.netNF)+'</td><td>'+f(a.inapp)+'</td><td>'+f(a.cashd)+'</td><td>'+f(a.book)+'</td></tr>'}).join('')+'<tr><td><b>РАЗОМ</b></td><td><b>'+f(T.net)+'</b></td><td></td><td></td><td>'+f(T.tip)+'</td><td>'+f(T.cancelNF)+'</td><td>'+f(T.netNF)+'</td><td></td><td></td><td></td></tr>';})();`;
  return page('Bolt тиждень', '<h2>Тиждень від ' + esc(monday) + ': що віддає v1 по водіях</h2>'
    + '<p>«Наше чисте» = як у дашборді (merge). Далі складові, щоб порівняти зі звітом Bolt «Чистий дохід». «Скас. (не заверш.)» = плата за скасування по незавершених поїздках; «net не заверш.» = net_earnings по них (наш код їх не додає).</p>'
    + '<p id="st"><b>Починаю…</b></p><table><thead><tr><th>Водій</th><th>Наше чисте</th><th>Валовий (заверш.)</th><th>Комісія</th><th>Чайові</th><th>Скас. (не заверш.)</th><th>net не заверш.</th><th>Знижка в застосунку</th><th>Знижка готівка</th><th>Booking fee</th></tr></thead><tbody id="tb"></tbody></table><script>' + script + '</script>');
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
    if (q.dayagg) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); try { return res.status(200).send(JSON.stringify(Object.assign({ ok: true }, await dayAgg(String(q.dayagg))))); } catch (e) { return res.status(200).send(JSON.stringify({ ok: false, error: String(e && e.message || e) })); } }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(q.dayagg ? null : q.week ? weekPage(String(q.week)) : q.v1shape ? await v1ShapePage() : q.guess ? await guessPage() : q.shape ? await shapePage() : q.spec ? await specPage() : await probePage());
  } catch (e) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(page('Помилка', '<h2>Помилка</h2><pre class="mono">' + esc(e && e.message) + '</pre>'));
  }
}
