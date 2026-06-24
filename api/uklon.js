// /api/uklon.js — Uklon наживо: каса/чисте по водіях + УСІ окремі поїздки (cursor-пагінація)
// auth -> report-by-orders (uklon_agg) + orders з cursor (uklon_trips)
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
    return {
      'Водій': ((d.first_name || '') + ' ' + (d.last_name || '')).trim(),
      'Вартість (Вся), грн': uah(p.order).toFixed(2),
      'Разом, грн': uah(p.total).toFixed(2),
      'Чайові, грн': uah(it.tips).toFixed(2),
      'Кількість замовлень': String(it.total_orders_count || 0),
      'Тривалість замовлень, год': hoursStr(it.total_executing_time),
      'Час онлайн, год': '',
    };
  });
}

// тип продукту -> укр. підпис (щоб клас визначався як у CSV)
const PROD = {
  econom:'Економ', standard:'Стандарт', wagon:'Стандарт', van:'Стандарт', green:'Стандарт', pool:'Стандарт', covidprotected:'Стандарт', driver:'Стандарт',
  comfort:'Комфорт', comfortplus:'Комфорт', premium:'Комфорт', business:'Бізнес',
  delivery:'Доставка',
};
function ordersToTrips(items) {
  const fmtDate = ts => { const p = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Kyiv', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date(ts * 1000)); const g = t => p.find(x => x.type === t).value; return g('day')+'.'+g('month')+'.'+g('year')+' '+g('hour')+':'+g('minute'); };
  const stMap = s => { s = (s || '').toLowerCase(); if (s === 'completed') return 'Виконано'; if (s === 'running' || s === 'waiting_for_processing') return 'Виконується'; return 'Скасовано'; };
  const payMap = f => { f = (f || '').toLowerCase(); if (f === 'cash') return 'Готівка'; if (f.indexOf('mix') >= 0) return 'Змішаний'; return 'Безготівковий'; };
  return (items || []).map(o => {
    const pay = o.payment || {}, drv = o.driver || {}, veh = o.vehicle || {};
    return {
      'Водій': drv.fullName || '',
      'Держ номер авто': veh.licencePlate || '',
      'Подача': o.pickupTime ? fmtDate(o.pickupTime) : '',
      'Статус': stMap(o.status),
      'Тип продукту': PROD[(veh.productType || '').toLowerCase()] || veh.productType || '',
      'Метод': '',
      'Тип оплати': payMap(pay.feeType || pay.paymentType),
      'Відст. за маршрутом, км': (pay.distance != null) ? String(pay.distance) : '',
      'Вартість замовлення, грн': (pay.cost != null) ? String(pay.cost) : '',
    };
  });
}

// усі поїздки через cursor
async function fetchAllOrders(fleetId, from, to, H) {
  const all = []; let cursor = null; let guard = 0;
  do {
    let url = BASE + '/api/fleets/orders?fleetId=' + fleetId + '&from=' + from + '&to=' + to + '&limit=100';
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    const r = await fetch(url, { headers: H });
    const j = await r.json();
    const items = (j && j.items) ? j.items : [];
    all.push(...items);
    cursor = (j && (j.cursor || j.next_cursor || j.nextCursor || j.next || (j.paging && j.paging.cursor) || (j.pagination && j.pagination.cursor))) || null;
    if (!items.length) cursor = null;
    guard++;
  } while (cursor && guard < 60);
  return all;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const id = process.env.UKLON_CLIENT_ID, secret = process.env.UKLON_CLIENT_SECRET, fleetId = process.env.UKLON_FLEET_ID;
    if (!id || !secret) throw new Error('Немає UKLON_CLIENT_ID / UKLON_CLIENT_SECRET');
    if (!fleetId) throw new Error('Немає UKLON_FLEET_ID');

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
    const H = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };

    const rRep = await fetch(BASE + '/api/fleets/reports/' + fleetId + '/drivers-orders?dateFrom=' + from + '&dateTo=' + to, { headers: H });
    const jRep = await rRep.json();
    const aggItems = (jRep && jRep.items) ? jRep.items : [];

    const ordItems = await fetchAllOrders(fleetId, from, to, H);

    res.status(200).send(JSON.stringify({
      ok: true, date: dateStr,
      uklon_agg: reportToAgg(aggItems),
      uklon_trips: ordersToTrips(ordItems),
      count_drivers: aggItems.length, count_orders: ordItems.length,
    }));
  } catch (err) {
    res.status(200).send(JSON.stringify({ ok: false, error: err.message }));
  }
}
