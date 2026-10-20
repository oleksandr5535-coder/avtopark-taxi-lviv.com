// /api/sync.js — автоматичне оновлення заробітку водіїв (без відкритого дашборду).
// Запускається за розкладом (Supabase pg_cron кожні 10 хв) або вручну:
//   /api/sync?key=CRON_SECRET                  -> сьогодні (+ вчора зранку), записує в базу
//   /api/sync?key=CRON_SECRET&date=2026-10-15  -> конкретний день
//   /api/sync?key=CRON_SECRET&date=...&dry=1   -> лише показати цифри, НІЧОГО не писати
// Змінні Vercel: SUPABASE_SERVICE_KEY, CRON_SECRET (+ вже наявні ключі Bolt/Uklon).
// Рахує так само, як дашборд (publishWeekCore): чисте Bolt/Uklon, готівка, поїздки, км.
import boltHandler from './bolt.js';
import uklonHandler from './uklon.js';

export const maxDuration = 60;
const SUPA = 'https://lriixtvefevxindyiuck.supabase.co';

/* ---------- допоміжні (ті самі правила, що в дашборді) ---------- */
const F = x => { const v = parseFloat(String(x == null ? '' : x).replace(',', '.')); return isNaN(v) ? 0 : v; };
const CYR = { 'А':'A','В':'B','Е':'E','І':'I','Ї':'I','Є':'E','Ґ':'G','К':'K','М':'M','Н':'H','О':'O','Р':'P','С':'C','Т':'T','У':'U','Х':'X' };
const NPL = p => String(p || '').replace(/\s|-/g, '').toUpperCase().replace(/[А-ЯІЇЄҐ]/g, c => CYR[c] || c);
const TOKS = n => new Set(String(n || '').toLowerCase().split(/[\s'’.]+/).filter(t => t.length > 1));
function rptToks(n) {
  const r = String(n || '').toLowerCase().replace(/[’ʼ‘´`'`]/g, '').replace(/[‐-―]/g, '-').split(/\s+/).filter(Boolean);
  let t = r;
  if (r.length >= 3) { const f = r.filter(x => !/(ович|йович|ьович|евич|івна|ївна|иївна)$/.test(x)); if (f.length >= 2) t = f; }
  return t.sort();
}
const r2 = x => Math.round(x * 100) / 100;

/* ---------- Bolt: замовлення -> по водіях (як boltOrdersToParts) ---------- */
export function boltByDriver(orders) {
  const seen = {}, ok = {};
  const keyOf = o => [o.payment_confirmed_timestamp || o.order_created_timestamp || '',
    ((o.order_price || {}).ride_price != null ? (o.order_price || {}).ride_price : ''), o.driver_name || ''].join('|');
  (orders || []).forEach(o => {
    if (o.order_status !== 'finished') return;
    const key = keyOf(o); if (seen[key]) return; seen[key] = 1; ok[o.order_reference || key] = 1;
  });
  const out = {};
  const get = n => out[n] || (out[n] = { name: n, net: 0, cash: 0, cdisc: 0, comp: 0, km: 0, plates: {} });
  (orders || []).forEach(o => {
    const n = o.driver_name || ''; const pr = o.order_price || {};
    const a = get(n);
    if (o.vehicle_license_plate) a.plates[o.vehicle_license_plate] = (a.plates[o.vehicle_license_plate] || 0) + 1;
    if (pr.net_earnings != null && ok[o.order_reference || keyOf(o)]) {
      a.net += (pr.net_earnings || 0);
      if (o.payment_method === 'cash' && (pr.ride_price || 0) > 0) a.cash += (pr.ride_price || 0);
      a.cdisc += (pr.cash_discount || 0);
    }
    if (o.order_status === 'finished') {
      a.comp++;
      const km = o.ride_distance != null ? F((o.ride_distance / 1000).toFixed(2)) : 0;
      if (F(pr.ride_price != null ? String(pr.ride_price) : '')) a.km += km;
    }
  });
  Object.values(out).forEach(a => {
    a.net = F(a.net.toFixed(2)); a.cashNet = F((a.cash - a.cdisc).toFixed(2));
    a.plate = Object.keys(a.plates).sort((x, y) => a.plates[y] - a.plates[x])[0] || '';
  });
  return out;
}

/* ---------- Uklon: агрегат + поїздки -> по водіях ---------- */
export function uklonByDriver(agg, trips, carsByPlate) {
  const out = {};
  const get = n => out[n] || (out[n] = { name: n, net: 0, cash: 0, orders: 0, km: 0, cashT: 0, plate: '' });
  (agg || []).forEach(r => {
    const n = String(r['Водій'] || '').trim(); if (!n) return;
    const a = get(n);
    a.net += F(r['Разом, грн']); a.cash += F(r['Вартість готівкою, грн'] || 0); a.orders += Math.round(F(r['Кількість замовлень']));
  });
  (trips || []).forEach(t => {
    let n = String(t['Водій'] || '').trim();
    const plate = NPL(t['Держ номер авто']);
    if (!n && plate && carsByPlate && carsByPlate[plate]) n = '#car:' + carsByPlate[plate];   // поїздка без імені — за авто
    if (!n) return;
    const a = get(n);
    if (!a.plate && t['Держ номер авто']) a.plate = t['Держ номер авто'];
    const s = t['Статус']; const done = (s === 'Виконано' || s === 'Виконується');
    if (!done) return;
    if (F(t['Вартість замовлення, грн'])) a.km += F(t['Відст. за маршрутом, км']);
    if (String(t['Тип оплати']).toLowerCase().indexOf('готів') >= 0 && String(t['Тип оплати']).toLowerCase().indexOf('безготів') < 0)
      a.cashT += F(t['Вартість замовлення, грн']);
  });
  return out;
}

/* ---------- збирання по водіях бази ---------- */
export function buildRows(day, bolt, uklon, ctx) {
  const { drivers, carsByPlate, carsByDriver } = ctx;
  const byName = {};
  drivers.forEach(d => [d.dash_name, d.full_name].forEach(n => { if (n && n.trim()) byName[rptToks(n).join('|')] = d.id; }));
  const findByName = name => {
    if (!name) return null;
    if (name.indexOf('#car:') === 0) return name.slice(5);
    const k = rptToks(name).join('|'); if (byName[k]) return byName[k];
    const tk = TOKS(name); let best = null, bs = 0;       // той самий запас, що в дашборді: ≥2 спільні слова
    drivers.forEach(d => [d.dash_name, d.full_name].forEach(n => {
      if (!n) return; let sh = 0; TOKS(n).forEach(t => { if (tk.has(t)) sh++; });
      if (sh >= 2 && sh > bs) { bs = sh; best = d.id; }
    }));
    return best;
  };
  const acc = {}, unmatched = {};
  const row = did => acc[did] || (acc[did] = { driver_id: did, day, bolt_net: 0, uklon_net: 0, bolt_cash: 0, uklon_cash: 0, orders: 0, km: 0, plate: null });
  Object.values(bolt).forEach(b => {
    if (!b.name) return;
    const did = (b.plate && carsByPlate[NPL(b.plate)]) || findByName(b.name);
    if (!did) { if (b.net > 0 || b.comp > 0) unmatched[b.name] = 1; return; }
    const r = row(did); r.bolt_net += b.net; r.bolt_cash += b.cashNet; r.orders += b.comp; r.km += b.km; r.plate = r.plate || b.plate || null;
  });
  Object.values(uklon).forEach(u => {
    if (!u.name) return;
    const did = findByName(u.name);
    if (!did) { if (u.net > 0 || u.orders > 0) unmatched[u.name] = 1; return; }
    const r = row(did); r.uklon_net += u.net; r._cAgg = (r._cAgg || 0) + u.cash; r._cTrip = (r._cTrip || 0) + u.cashT; r.orders += u.orders; r.km += u.km;
    r.plate = r.plate || u.plate || (carsByDriver[did] || null);
  });
  // готівка Uklon: з агрегату; якщо там порожньо — із суми готівкових поїздок (як у дашборді)
  Object.keys(acc).forEach(k => { const r = acc[k]; r.uklon_cash = r._cAgg || r._cTrip || 0; delete r._cAgg; delete r._cTrip; });
  // як у дашборді: водія без грошей і без замовлень за день не публікуємо
  Object.keys(acc).forEach(k => { const r = acc[k]; if (!(r.bolt_net + r.uklon_net > 0 || r.orders > 0)) delete acc[k]; });
  const rows = Object.values(acc).map(r => ({
    ...r, bolt_net: r2(r.bolt_net), uklon_net: r2(r.uklon_net), bolt_cash: r2(r.bolt_cash), uklon_cash: r2(r.uklon_cash),
    km: Math.round(r.km * 10) / 10, updated_at: new Date().toISOString(),
  }));
  return { rows, unmatched: Object.keys(unmatched) };
}

/* ---------- виклик існуючих функцій /api/bolt та /api/uklon без HTTP ---------- */
async function callHandler(handler, query) {
  const req = { query, url: '/api/internal', headers: { authorization: 'Bearer ' + (process.env.CRON_SECRET || '') } };
  const res = { headers: {}, code: 200, body: '', setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } };
  await handler(req, res);
  try { return JSON.parse(res.body); } catch (e) { return { ok: false, error: 'відповідь не JSON' }; }
}
function extractOrders(j) {
  let found = [];
  const isOrd = x => x && typeof x === 'object' && ('order_status' in x || 'order_price' in x || 'driver_name' in x || 'vehicle_license_plate' in x);
  (function walk(x) {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { if (x.length && (isOrd(x[0]) || isOrd(x[1]))) found.push(x); x.forEach(walk); return; }
    Object.keys(x).forEach(k => walk(x[k]));
  })(j);
  found.sort((a, b) => b.length - a.length);
  return found[0] || [];
}

/* ---------- Supabase (REST, від імені сервера) ---------- */
function sb(path, opt) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(SUPA + '/rest/v1/' + path, Object.assign({}, opt, {
    headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, (opt && opt.headers) || {}),
  }));
}
async function loadCtx() {
  const [dr, cr] = await Promise.all([sb('drivers?select=id,full_name,dash_name,status'), sb('cars?select=plate,driver_id')]);
  if (!dr.ok) throw new Error('drivers: ' + dr.status + ' ' + (await dr.text()).slice(0, 160));
  if (!cr.ok) throw new Error('cars: ' + cr.status + ' ' + (await cr.text()).slice(0, 160));
  const drivers = await dr.json(), cars = await cr.json();
  const carsByPlate = {}, carsByDriver = {};
  cars.forEach(c => { if (c.driver_id && c.plate) { carsByPlate[NPL(c.plate)] = c.driver_id; carsByDriver[c.driver_id] = c.plate; } });
  return { drivers, carsByPlate, carsByDriver };
}
async function writeRows(rows) {
  if (!rows.length) return { ok: true, n: 0 };
  const post = async body => sb('api_days?on_conflict=driver_id,day', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(body) });
  let r = await post(rows);
  if (!r.ok) {
    const t = await r.text();
    if (/bolt_cash|uklon_cash/.test(t)) { r = await post(rows.map(x => { const c = { ...x }; delete c.bolt_cash; delete c.uklon_cash; return c; })); if (r.ok) return { ok: true, n: rows.length, warn: 'немає колонок готівки (cash_columns.sql)' }; }
    return { ok: false, error: 'api_days: ' + r.status + ' ' + t.slice(0, 200) };
  }
  return { ok: true, n: rows.length };
}

function kyivNow() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return { date: g('year') + '-' + g('month') + '-' + g('day'), hour: +g('hour') % 24 };
}
const prevDay = d => new Date(Date.parse(d + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);

async function syncDay(date, ctx, dry) {
  const [bj, uj] = await Promise.all([callHandler(boltHandler, { date }), callHandler(uklonHandler, { date })]);
  const res = { date, bolt: bj.ok === false ? ('помилка: ' + bj.error) : 'ok', uklon: uj.ok === false ? ('помилка: ' + uj.error) : 'ok' };
  // якщо платформа не відповіла — цей день пропускаємо, щоб не затерти старі цифри нулями
  if (bj.ok === false || uj.ok === false) { res.skipped = true; return res; }
  const bolt = boltByDriver(extractOrders(bj));
  const uklon = uklonByDriver(uj.uklon_agg, uj.uklon_trips, ctx.carsByPlate);
  const { rows, unmatched } = buildRows(date, bolt, uklon, ctx);
  res.rows = rows.length; res.unmatched = unmatched;
  if (dry) res.preview = rows.map(r => ({ ...r, driver: (ctx.drivers.find(d => d.id === r.driver_id) || {}).full_name }));
  else res.write = await writeRows(rows);
  return res;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const q = req.query || {};
  const h = String(req.headers['authorization'] || '');
  const given = h.startsWith('Bearer ') ? h.slice(7).trim() : String(q.key || '');
  if (!process.env.CRON_SECRET || given !== process.env.CRON_SECRET) return res.status(401).send(JSON.stringify({ ok: false, error: 'Немає доступу' }));
  if (!process.env.SUPABASE_SERVICE_KEY) return res.status(500).send(JSON.stringify({ ok: false, error: 'Немає SUPABASE_SERVICE_KEY у Vercel' }));
  try {
    const dry = q.dry === '1' || q.dry === 'true';
    const now = kyivNow();
    let days = [];
    if (q.date) days = [String(q.date)];
    else { days = [now.date]; if (now.hour < 12) days.push(prevDay(now.date)); }   // зранку ще догоняємо вчорашній день
    const ctx = await loadCtx();
    const results = [];
    for (const d of days) results.push(await syncDay(d, ctx, dry));
    res.status(200).send(JSON.stringify({ ok: true, dry, at: new Date().toISOString(), results }));
  } catch (e) {
    res.status(200).send(JSON.stringify({ ok: false, error: e.message }));
  }
}
