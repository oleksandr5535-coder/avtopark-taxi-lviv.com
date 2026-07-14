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
      'Вартість готівкою, грн': uah(p.cash || p.cash_amount || p.cash_collected).toFixed(2),
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

// метод отримання замовлення -> укр. підпис (як у порталі: «Швидкий пошук», «Ланцюжок», …)
const UMETHOD = {
  fast:'Швидкий пошук', fastsearch:'Швидкий пошук', fastorder:'Швидкий пошук', instant:'Швидкий пошук', search:'Швидкий пошук', regular:'Швидкий пошук', usual:'Швидкий пошук', standard:'Швидкий пошук', quick:'Швидкий пошук',
  chain:'Ланцюжок', chained:'Ланцюжок', orderchain:'Ланцюжок', chainorder:'Ланцюжок', consecutive:'Ланцюжок',
  prebooked:'Попереднє', preliminary:'Попереднє', scheduled:'Попереднє', reserve:'Попереднє', reserved:'Попереднє', preorder:'Попереднє', prearranged:'Попереднє',
};
// acceptance_method (як Uklon віддає в API) -> укр. підпис (як у порталі)
const ACC_METHOD = {
  byhomefilter:'Швидкий пошук', homefilter:'Швидкий пошук', fastsearch:'Швидкий пошук', bysearch:'Швидкий пошук', search:'Швидкий пошук', fast:'Швидкий пошук', quicksearch:'Швидкий пошук', byfilter:'Швидкий пошук',
  chain:'Ланцюжок', bychain:'Ланцюжок', orderchain:'Ланцюжок', bychainorder:'Ланцюжок',
  offer:'Пропозиція', byoffer:'Пропозиція', manual:'Пропозиція', bymanual:'Пропозиція', byoffermanual:'Пропозиція',
  radar:'Радар', byradar:'Радар',
  prebooked:'Попереднє', byprebooked:'Попереднє', scheduled:'Попереднє', preorder:'Попереднє', reserve:'Попереднє', byprebook:'Попереднє',
};

// Глибокий пошук методу отримання замовлення в сирому об'єкті замовлення.
// Не залежить від точної назви поля: рекурсивно обходимо весь об'єкт.
const METHOD_KEY_RE = /(acquisition|acceptance|assignment|pipeline|ordertype|order_type|searchtype|search_type|obtain|receiv|method|chain)/i;
function normCode(s) { return String(s).toLowerCase().replace(/[\s_-]+/g, ''); }
function mapMethodVal(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (!s) return '';
  if (/[а-яіїєґ]/i.test(s)) return s.length <= 40 ? s : '';   // вже українською — беремо як є
  const k = normCode(s);
  if (ACC_METHOD[k]) return ACC_METHOD[k];
  if (UMETHOD[k]) return UMETHOD[k];                          // впізнаний код
  return '';
}
function findMethod(obj, depth) {
  if (obj == null || typeof obj !== 'object' || depth > 5) return '';
  // Крок 1: ключі, що схожі на поле методу
  for (const key of Object.keys(obj)) {
    if (!METHOD_KEY_RE.test(key)) continue;
    const val = obj[key];
    if (key.toLowerCase().indexOf('chain') >= 0 && (val === true || val === 'true')) return 'Ланцюжок';
    if (typeof val === 'string' || typeof val === 'number') {
      const m = mapMethodVal(val);
      if (m) return m;
      const s = String(val).trim();                          // невідомий код, але з поля-методу — показуємо як є
      if (s && s.length <= 40 && !/^\d+$/.test(s) && s !== 'true' && s !== 'false') return s;
    }
  }
  // Крок 2: значення, що точно збігаються зі словником методів (де б не лежали)
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') { const m = mapMethodVal(val); if (m && !/[а-яіїєґ]/i.test(val)) return m; }
  }
  // Крок 3: рекурсія у вкладені об'єкти
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') { const r = findMethod(val, (depth || 0) + 1); if (r) return r; }
  }
  return '';
}
// Класифікатор коду acceptance_method за ключовими словами (стійкий до нових варіантів).
// Порядок важливий: спершу специфічні режими, потім фільтр/пошук, потім пропозиція.
function classifyAcc(code) {
  const s = String(code == null ? '' : code).toLowerCase();
  if (!s) return '';
  if (s.indexOf('chain') >= 0) return 'Ланцюжок';
  if (s.indexOf('prebook') >= 0 || s.indexOf('preorder') >= 0 || s.indexOf('scheduled') >= 0 || s.indexOf('reserve') >= 0) return 'Попереднє';
  if (s.indexOf('radar') >= 0) return 'Радар';
  if (s.indexOf('filter') >= 0 || s.indexOf('loop') >= 0 || s.indexOf('search') >= 0 || s.indexOf('fast') >= 0 || s.indexOf('home') >= 0) return 'Швидкий пошук';
  if (s.indexOf('offer') >= 0 || s.indexOf('manual') >= 0) return 'Пропозиція';
  return String(code).trim();   // зовсім невідоме — покажемо сире, щоб додати згодом
}
// Основне: читаємо acceptance_method напряму (як віддає Uklon API), класифікуємо в укр. підпис.
function methodOf(o) {
  const am = o && (o.acceptance_method != null ? o.acceptance_method : o.acceptanceMethod);
  if (am != null && am !== '') return classifyAcc(am);
  return findMethod(o, 0);
}

function ordersToTrips(items) {
  const fmtDate = ts => { const p = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Kyiv', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date(ts * 1000)); const g = t => p.find(x => x.type === t).value; return g('day')+'.'+g('month')+'.'+g('year')+' '+g('hour')+':'+g('minute'); };
  const stMap = s => { s = (s || '').toLowerCase(); if (s === 'completed') return 'Виконано'; if (s === 'running' || s === 'waiting_for_processing') return 'Виконується'; return 'Скасовано'; };
  const payMap = f => { f = (f || '').toLowerCase(); if (f === 'cash') return 'Готівка'; if (f.indexOf('mix') >= 0) return 'Змішаний'; return 'Безготівковий'; };
  return (items || []).map(o => {
    const pay = o.payment || {}, drv = o.driver || {}, veh = o.vehicle || {};
    // Доїзд до клієнта у хвилинах: acceptedAt -> pickupTime (беремо лише правдоподібні значення 0..60 хв)
    let deadheadMin = '';
    if (o.acceptedAt && o.pickupTime) {
      const dm = Math.round((o.pickupTime - o.acceptedAt) / 60);
      if (dm >= 0 && dm <= 60) deadheadMin = String(dm);
    }
    return {
      'Водій': drv.fullName || '',
      'Держ номер авто': veh.licencePlate || '',
      'Подача': o.pickupTime ? fmtDate(o.pickupTime) : '',
      'Статус': stMap(o.status),
      'Тип продукту': PROD[(veh.productType || '').toLowerCase()] || veh.productType || '',
      'Метод': methodOf(o),
      'Доїзд хв': deadheadMin,
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

// звіт по водіях з пагінацією (cursor -> offset fallback), дедуплікація по водію
async function fetchAllReport(fleetId, from, to, H) {
  const base = BASE + '/api/fleets/reports/' + fleetId + '/drivers-orders?dateFrom=' + from + '&dateTo=' + to;
  const all = []; const seen = new Set();
  let cursor = null, offset = 0, useOffset = false, guard = 0;
  do {
    let url = base;
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    else if (useOffset) url += '&offset=' + offset;
    const r = await fetch(url, { headers: H });
    const j = await r.json();
    const items = (j && j.items) ? j.items : [];
    let added = 0;
    for (const it of items) {
      const d = it.driver || {};
      const key = (d.id != null ? String(d.id) : ((d.first_name || '') + '|' + (d.last_name || '')));
      if (seen.has(key)) continue;
      seen.add(key); all.push(it); added++;
    }
    const more = !!(j && (j.has_more_items || j.has_more || j.hasMore));
    cursor = (j && (j.cursor || j.next_cursor || j.nextCursor || j.next || (j.paging && j.paging.cursor) || (j.pagination && j.pagination.cursor))) || null;
    if (more && !cursor) { useOffset = true; offset += items.length; }
    if (!more || added === 0 || items.length === 0) { cursor = null; useOffset = false; }
    guard++;
  } while ((cursor || useOffset) && guard < 60);
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

    // Діагностика: /api/uklon?date=YYYY-MM-DD&debug=1 -> повертає ЛИШЕ сире перше замовлення
    // (без сотень поїздок), щоб знайти точну назву поля з методом («Швидкий пошук», «Ланцюжок»…).
    if (req.query && (req.query.debug === '1' || req.query.debug === 'true')) {
      const ordItemsD = await fetchAllOrders(fleetId, from, to, H);
      const sample = ordItemsD.find(o => (o.status || '').toLowerCase() === 'completed') || ordItemsD[0] || null;
      res.status(200).send(JSON.stringify({
        ok: true, date: dateStr, count_orders: ordItemsD.length,
        _sample_keys: sample ? Object.keys(sample) : [],
        _sample_order: sample,
      }, null, 2));
      return;
    }

    const aggItems = await fetchAllReport(fleetId, from, to, H);

    const ordItems = await fetchAllOrders(fleetId, from, to, H);

    const trips = ordersToTrips(ordItems);
    const methodFound = trips.filter(t => t['Метод']).length;

    const out = {
      ok: true, date: dateStr,
      _v: 'uklon-method-4', _method_found: methodFound + '/' + trips.length,
      uklon_agg: reportToAgg(aggItems),
      uklon_trips: trips,
      count_drivers: aggItems.length, count_orders: ordItems.length,
    };

    res.status(200).send(JSON.stringify(out));
  } catch (err) {
    res.status(200).send(JSON.stringify({ ok: false, error: err.message }));
  }
}
