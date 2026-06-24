// /api/bolt.js  — РОБОЧА функція: тягне поїздки Bolt за день
// OAuth2 (client_credentials) -> getFleetOrders -> повертає { ok, date, orders }
// Змінні оточення: BOLT_CLIENT_ID, BOLT_CLIENT_SECRET

const COMPANY_ID = 25859;
const API = 'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1';

async function getToken() {
  const id = process.env.BOLT_CLIENT_ID, secret = process.env.BOLT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Немає BOLT_CLIENT_ID або BOLT_CLIENT_SECRET');
  const body = new URLSearchParams({
    client_id: id, client_secret: secret,
    grant_type: 'client_credentials', scope: 'fleet-integration:api',
  });
  const r = await fetch('https://oidc.bolt.eu/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Токен не отримано: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

// київський зсув (сек) для моменту
function kyivOffsetSec(date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone:'Europe/Kyiv', hour12:false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 1000;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    // дата (?date=YYYY-MM-DD) або сьогодні за Києвом
    let dateStr = (req.query && req.query.date) ? String(req.query.date) : null;
    if (!dateStr) {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Kyiv', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
      const g = t => p.find(x => x.type === t).value;
      dateStr = g('year')+'-'+g('month')+'-'+g('day');
    }
    // точна київська доба [00:00, 24:00)
    const off = kyivOffsetSec(new Date(dateStr + 'T12:00:00Z'));
    const start_ts = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000) - off;
    const end_ts = start_ts + 86400;

    const token = await getToken();
    const r = await fetch(API + '/getFleetOrders', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company_ids: [COMPANY_ID], company_id: COMPANY_ID,
        start_ts, end_ts, offset: 0, limit: 1000,
      }),
    });
    const j = await r.json();
    // повертаємо все, що прийшло; дашборд сам знайде масив поїздок
    res.status(200).send(JSON.stringify({ ok: true, date: dateStr, start_ts, end_ts, orders: (j && j.data) ? j.data : j }));
  } catch (err) {
    res.status(200).send(JSON.stringify({ ok: false, error: err.message }));
  }
}
