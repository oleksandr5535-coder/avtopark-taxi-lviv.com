// /api/uklon.js — каса/чисте по водіях Uklon за день (report-by-orders)
// auth -> GET /api/fleets/reports/{fleetId}/drivers-orders?dateFrom&dateTo -> uklon_agg
// Змінні оточення: UKLON_CLIENT_ID, UKLON_CLIENT_SECRET, UKLON_FLEET_ID

const BASE = 'https://fleets-public-api.uklon.com.ua';

async function auth(id, secret) {
  const r = await fetch(BASE + '/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Токен Uklon не отримано: ' + JSON.stringify(j).slice(0, 150));
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

function reportToAgg(items) {
  const uah = c => (c && typeof c.amount === 'number') ? (c.amount / 100) : 0;
  const hoursStr = sec => { if (!sec) return ''; const m = Math.round(sec / 60); return Math.floor(m / 60) + ' год ' + (m % 60) + ' хв'; };
  return (items || []).map(it => {
    const d = it.driver || {}, p = it.profit || {};
    const name = ((d.first_name || '') + ' ' + (d.last_name || '')).trim();
    return {
      'Водій': name,
      'Вартість (Вся), грн': uah(p.order).toFixed(2),
      'Разом, грн': uah(p.total).toFixed(2),
      'Чайові, грн': uah(it.tips).toFixed(2),
      'Кількість замовлень': String(it.total_orders_count || 0),
      'Тривалість замовлень, год': hoursStr(it.total_executing_time),
      'Час онлайн, год': '',
    };
  });
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const id = process.env.UKLON_CLIENT_ID, secret = process.env.UKLON_CLIENT_SECRET, fleetId = process.env.UKLON_FLEET_ID;
    if (!id || !secret) throw new Error('Немає UKLON_CLIENT_ID / UKLON_CLIENT_SECRET');
    if (!fleetId) throw new Error('Немає UKLON_FLEET_ID');

    // дата (?date=YYYY-MM-DD) або сьогодні за Києвом
    let dateStr = (req.query && req.query.date) ? String(req.query.date) : null;
    if (!dateStr) {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Kyiv', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
      const g = t => p.find(x => x.type === t).value;
      dateStr = g('year')+'-'+g('month')+'-'+g('day');
    }
    const off = kyivOffsetSec(new Date(dateStr + 'T12:00:00Z'));
    const from = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000) - off;
    const to = from + 86400;

    const token = await auth(id, secret);
    const r = await fetch(BASE + '/api/fleets/reports/' + fleetId + '/drivers-orders?dateFrom=' + from + '&dateTo=' + to, {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    });
    const j = await r.json();
    const items = (j && j.items) ? j.items : [];
    res.status(200).send(JSON.stringify({ ok: true, date: dateStr, uklon_agg: reportToAgg(items), count: items.length, has_more: !!(j && j.has_more_items) }));
  } catch (err) {
    res.status(200).send(JSON.stringify({ ok: false, error: err.message }));
  }
}
