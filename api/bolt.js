// /api/bolt.js — тягне поїздки Bolt за день (getFleetOrders) з ПАГІНАЦІЄЮ.
//   /api/bolt?date=YYYY-MM-DD            -> сирі поїздки (як було, але всі сторінки)
//   /api/bolt?date=YYYY-MM-DD&summary=1  -> таблиця чистого по водіях (сума net_earnings)
//   ...&summary=1&json=1                 -> те саме у JSON
// OAuth2 (client_credentials). Змінні оточення: BOLT_CLIENT_ID, BOLT_CLIENT_SECRET

const COMPANY_ID = 25859;
const API = 'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1';

// дозволити функції працювати довше за дефолтні 10 c (щоб не падала на холодному старті)
export const maxDuration = 60;

// fetch із таймаутом, щоб завислий запит не валив усю функцію
async function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 12000);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ac.signal }));
  } finally {
    clearTimeout(t);
  }
}

async function getToken() {
  const id = process.env.BOLT_CLIENT_ID, secret = process.env.BOLT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Немає BOLT_CLIENT_ID або BOLT_CLIENT_SECRET');
  const body = new URLSearchParams({
    client_id: id, client_secret: secret,
    grant_type: 'client_credentials', scope: 'fleet-integration:api',
  });
  const r = await fetchT('https://oidc.bolt.eu/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, 12000);
  const j = await r.json();
  if (!j.access_token) throw new Error('Токен не отримано: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

function kyivOffsetSec(date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone:'Europe/Kyiv', hour12:false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 1000;
}

async function fetchPage(token, start_ts, end_ts, offset, limit, trt) {
  const reqBody = {
    company_ids: [COMPANY_ID], company_id: COMPANY_ID,
    start_ts, end_ts, offset, limit,
  };
  if (trt) reqBody.time_range_filter_type = trt;   // напр. "price_review"
  const r = await fetchT(API + '/getFleetOrders', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
  }, 15000);
  const txt = await r.text();
  try { return JSON.parse(txt); }
  catch (e) { throw new Error('Bolt відповів не-JSON (' + r.status + '): ' + txt.slice(0, 160)); }
}

async function fetchAll(token, start_ts, end_ts, trt) {
  const limit = 1000;
  let offset = 0, all = [], meta = {}, total = null;
  for (let guard = 0; guard < 50; guard++) {
    const j = await fetchPage(token, start_ts, end_ts, offset, limit, trt);
    const d = (j && j.data) ? j.data : {};
    const arr = Array.isArray(d.orders) ? d.orders : [];
    if (offset === 0) {
      meta = { company_id: d.company_id, company_name: d.company_name, total_orders: d.total_orders };
      total = (typeof d.total_orders === 'number') ? d.total_orders : null;
    }
    all = all.concat(arr);
    if (arr.length < limit) break;
    if (total != null && all.length >= total) break;
    offset += limit;
  }
  return { meta, orders: all };
}

function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function summarize(orders) {
  const by = {};
  for (const o of orders) {
    const op = o.order_price || {};
    const name = o.driver_name || '—';
    const d = by[name] || (by[name] = { name, net: 0, gross: 0, cash: 0, disc: 0, comm: 0, orders: 0 });
    if (op.net_earnings != null) { d.net += op.net_earnings; d.orders += 1; }
    if (op.ride_price != null) d.gross += op.ride_price;
    if (op.commission != null) d.comm += op.commission;
    if (op.in_app_discount != null) d.disc += op.in_app_discount;
    if (o.payment_method === 'cash' && op.ride_price != null) d.cash += op.ride_price;
  }
  const rows = Object.values(by).map(d => ({
    name: d.name, orders: d.orders,
    gross: r2(d.gross), net: r2(d.net), cash: r2(d.cash), disc: r2(d.disc), comm: r2(d.comm),
  })).sort((a, b) => b.net - a.net);
  const tot = rows.reduce((a, r) => ({
    orders: a.orders + r.orders, gross: a.gross + r.gross, net: a.net + r.net, cash: a.cash + r.cash,
  }), { orders: 0, gross: 0, net: 0, cash: 0 });
  return { rows, tot: { orders: tot.orders, gross: r2(tot.gross), net: r2(tot.net), cash: r2(tot.cash) } };
}

function htmlTable(dateStr, sum, totalOrders) {
  const f = n => n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rows = sum.rows.map(r => '<tr><td>' + r.name + '</td><td class=r>' + r.orders + '</td><td class=r>' + f(r.gross) + '</td><td class=r>' + f(r.comm) + '</td><td class=r><b>' + f(r.net) + '</b></td><td class=r>' + f(r.cash) + '</td></tr>').join('');
  return '<!doctype html><meta charset=utf-8><title>Bolt чисте ' + dateStr + '</title>'
    + '<style>body{font:14px/1.5 system-ui;margin:24px;color:#1a1c22}h2{margin:0 0 4px}p{color:#666;margin:0 0 16px;max-width:760px}'
    + 'table{border-collapse:collapse;width:100%;max-width:760px}th,td{padding:7px 10px;border-bottom:1px solid #eee;text-align:left}'
    + '.r{text-align:right;font-variant-numeric:tabular-nums}thead th{border-bottom:2px solid #ccc;font-size:12px;color:#666}'
    + 'tfoot td{border-top:2px solid #ccc;font-weight:700}</style>'
    + '<h2>Bolt · чисте по водіях · ' + dateStr + '</h2>'
    + '<p>Усього записів-замовлень: ' + totalOrders + '. «Чисте» = сума net_earnings із getFleetOrders (поїздки). Промо та відшкодування автопарку сюди НЕ входять — це окремі суми.</p>'
    + '<table><thead><tr><th>Водій</th><th class=r>Поїздок</th><th class=r>Валове</th><th class=r>Комісія</th><th class=r>Чисте</th><th class=r>Готівка</th></tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '<tfoot><tr><td>РАЗОМ</td><td class=r>' + sum.tot.orders + '</td><td class=r>' + f(sum.tot.gross) + '</td><td class=r></td><td class=r>' + f(sum.tot.net) + '</td><td class=r>' + f(sum.tot.cash) + '</td></tr></tfoot>'
    + '</table>';
}

export default async function handler(req, res) {
  try {
    let dateStr = (req.query && req.query.date) ? String(req.query.date) : null;
    if (!dateStr) {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Kyiv', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
      const g = t => p.find(x => x.type === t).value;
      dateStr = g('year')+'-'+g('month')+'-'+g('day');
    }
    const off = kyivOffsetSec(new Date(dateStr + 'T12:00:00Z'));
    const start_ts = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000) - off;
    const end_ts = start_ts + 86400;

    const token = await getToken();

    // ЗА ЗАМОВЧУВАННЯМ — звичайний режим (за часом створення), як було раніше: без нічних хвостів.
    // ?trt=price_review -> як рахує портал (точніше по чистому, але тягне нічні хвости попередньої доби).
    let trt = null;
    if (req.query && req.query.trt !== undefined) {
      const q = String(req.query.trt);
      trt = (q === 'none' || q === 'created' || q === '') ? null : q;
    }
    const { meta, orders } = await fetchAll(token, start_ts, end_ts, trt);

    if (req.query && req.query.summary) {
      const sum = summarize(orders);
      if (req.query.json) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.status(200).send(JSON.stringify({ ok: true, date: dateStr, total_orders: meta.total_orders, rows: sum.rows, tot: sum.tot }));
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(htmlTable(dateStr, sum, meta.total_orders != null ? meta.total_orders : orders.length));
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({
      ok: true, date: dateStr, start_ts, end_ts,
      orders: { company_id: meta.company_id, company_name: meta.company_name,
        total_orders: meta.total_orders, fetched: orders.length, orders },
    }));
  } catch (err) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ ok: false, error: err.message }));
  }
}
