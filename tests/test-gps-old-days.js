// Тест: GPS (Wialon) за старі дні (поза вікном свіжих у браузері) має бути видно
const { TextEncoder, TextDecoder } = require('util');
// у Звіті й на головній після перезапуску сторінки; кеш звіту оновлюється після «Оновити все».
// Запуск: node test-gps-old-days.js /шлях/до/index.html
const fs = require('fs');
const { JSDOM } = require('jsdom');
const FILE = process.argv[2];
let html = fs.readFileSync(FILE, 'utf8');
html = html.replace(/<script[^>]*src="https?:[^"]*"[^>]*><\/script>/g, ''); // без CDN

// ---- спільна «хмара» Supabase (app_data) між запусками ----
const CLOUD = new Map();
const PLATES = ['ВС1111АА', 'ВС2222ВВ'];
const NAMES = ['Іван Петренко', 'Олег Коваль'];

function mockSupabase(win) {
  function q(table) {
    let rows = () => [...CLOUD.entries()].map(([key, value]) => ({ key, value: JSON.parse(JSON.stringify(value)) }));
    let filt = [], ord = null, lim = null, single = false;
    const b = {
      select() { return b; },
      eq(c, v) { filt.push(r => r[c] === v); return b; },
      in(c, arr) { filt.push(r => arr.includes(r[c])); return b; },
      like(c, p) { const re = new RegExp('^' + p.replace(/%/g, '.*') + '$'); filt.push(r => re.test(r[c])); return b; },
      order(c, o) { ord = { c, asc: o && o.ascending }; return b; },
      limit(n) { lim = n; return b; },
      maybeSingle() { single = true; return b; },
      upsert(o) { (Array.isArray(o) ? o : [o]).forEach(x => CLOUD.set(x.key, typeof x.value === 'string' ? (() => { try { return JSON.parse(x.value); } catch (e) { return x.value; } })() : JSON.parse(JSON.stringify(x.value)))); return Promise.resolve({ error: null }); },
      delete() { return { eq(c, v) { CLOUD.delete(v); return Promise.resolve({ error: null }); } }; },
      then(res, rej) {
        let r = rows().filter(x => filt.every(f => f(x)));
        if (ord) r.sort((a, b2) => (a[ord.c] < b2[ord.c] ? -1 : 1) * (ord.asc ? 1 : -1));
        if (lim) r = r.slice(0, lim);
        const out = single ? { data: r[0] || null, error: null } : { data: r, error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  }
  const session = { access_token: 'tok' };
  win.supabase = { createClient: () => ({
    from: q,
    auth: { getSession: async () => ({ data: { session } }), onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }, signOut: async () => ({}) },
    channel() { const c = { on() { return c; }, subscribe() { return c; } }; return c; },
    removeChannel() {},
    rpc: async () => ({ data: null, error: null }),
  }) };
}

function ts(date, hh, mm) { return Math.floor(Date.parse(date + 'T' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00+02:00') / 1000); }
function apiFor(url) {
  const date = (url.match(/date=([\d-]+)/) || [])[1];
  if (url.startsWith('/api/bolt')) {
    const orders = [];
    NAMES.forEach((n, i) => { for (let k = 0; k < 5; k++) orders.push({ order_reference: date + n + k, order_status: 'finished', driver_name: n, vehicle_license_plate: PLATES[i], payment_method: 'in_app', order_created_timestamp: ts(date, 8 + k, 5), payment_confirmed_timestamp: ts(date, 8 + k, 30), order_pickup_timestamp: ts(date, 8 + k, 10), order_drop_off_timestamp: ts(date, 8 + k, 30), ride_distance: 5000, order_price: { ride_price: 200, net_earnings: 150 } }); });
    return { ok: true, orders };
  }
  if (url.startsWith('/api/uklon')) return { ok: true, count_orders: 2, uklon_agg: NAMES.map(n => ({ 'Водій': n, 'Кількість замовлень': '2', 'Разом, грн': '300', 'Вартість (Вся), грн': '400', 'Час онлайн, год': '5', 'Тривалість замовлень, год': '1' })), uklon_trips: [] };
  if (url.startsWith('/api/wialon')) {
    const trips = [], stops = [];
    PLATES.forEach((p, i) => {
      trips.push({ '№': '1', 'Групування': 'Toyota ' + p });
      trips.push({ '№': '1.1', 'Групування': 'Toyota ' + p, 'Початок': date + ' 08:00:00', 'Кінець': date + ' 09:00:00', 'Тривалість': '1:00:00', 'Пробіг': (40 + i) + ' km', 'Макс. швидкість': '80 km/h', 'Штраф': '0' });
      stops.push({ '№': '1.1', 'Групування': 'Toyota ' + p, 'Початок': '09:00:00', 'Кінець': '09:20:00', 'Тривалість': '0:20:00', 'Місцезнаходження': 'вул. Тест, Львів' });
    });
    return { ok: true, date, trips, stops };
  }
  if (url.startsWith('/api/rate')) return { ok: true, usd_buy: 41, usd_sale: 41.5 };
  return { ok: false, error: 'mock: ' + url };
}

async function boot(storage) {
  const dom = new JSDOM(html, {
    url: 'https://avtopark-taxi-lviv.com/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(win) {
      Object.entries(storage).forEach(([k, v]) => win.localStorage.setItem(k, v));
      // як у реальному браузері з переповненим сховищем: більше 3 днів із сирими даними не влазить
      const _set = win.Storage.prototype.setItem;
      win.Storage.prototype.setItem = function (k, v) { if (k === 'days_store' && (String(v).match(/"_parts"/g) || []).length > 3) { const e = new win.DOMException('quota', 'QuotaExceededError'); throw e; } return _set.call(this, k, v); };
      mockSupabase(win);
      win.fetch = async (u) => { const s = String(u); const j = apiFor(s); return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) }; };
      win.scrollTo = () => {}; win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      win.HTMLCanvasElement.prototype.getContext = () => null;
      win.alert = () => {}; win.confirm = () => true; win.TextEncoder = TextEncoder; win.TextDecoder = TextDecoder;
    },
  });
  const errs = [];
  dom.window.addEventListener('error', e => errs.push(String(e.message)));
  await new Promise(r => setTimeout(r, 1500));
  return { dom, w: dom.window, errs };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); } }
function ev(w, code) { return w.eval(code); }

(async () => {
  const DATES = []; for (let d = 25; d <= 31; d++) DATES.push('2026-10-' + d); for (let d = 1; d <= 8; d++) DATES.push('2026-11-0' + d);

  // ---- Сесія 1: завантажуємо 15 днів через «Оновити все» ----
  console.log('Сесія 1: «Оновити все» за ' + DATES.length + ' днів');
  let s1 = await boot({});
  for (const d of DATES) { ev(s1.w, `document.getElementById('boltDate').value='${d}'`); await ev(s1.w, 'updateAll()'); }
  await sleep(300);
  const stat = ev(s1.w, "document.getElementById('boltStat').textContent");
  check('останнє «Оновити все» дало Bolt, Uklon і GPS', /GPS/.test(stat) && !/помилк/i.test(stat), stat);
  const c04 = CLOUD.get('day:2026-11-04');
  check('у хмарі за 04.11 є сирі рядки GPS', !!(c04 && c04._parts && c04._parts.wialon_trips_rows.length));
  const ls04 = JSON.parse(ev(s1.w, "localStorage.getItem('days_store')"))['2026-11-04'];
  check('у браузері 04.11 полегшений (без сирих) — так задумано', !!(ls04 && ls04._light && !ls04._parts));

  // кеш звіту: відкриваємо звіт за 05.11, далі «Оновити все» → звіт мусить бачити новий обʼєкт
  ev(s1.w, "var _h1=rptHy('2026-11-08')");
  ev(s1.w, "document.getElementById('boltDate').value='2026-11-08'"); await ev(s1.w, 'updateAll()');
  check('після «Оновити все» звіт не тримає стару копію дня', ev(s1.w, "rptHy('2026-11-08')!==_h1"));
  const storage = {}; for (let i = 0; i < s1.w.localStorage.length; i++) { const k = s1.w.localStorage.key(i); storage[k] = s1.w.localStorage.getItem(k); }
  s1.w.close();

  // ---- Сесія 2: перезапуск сторінки (як на іншому пристрої / наступного дня) ----
  console.log('Сесія 2: перезапуск, перевіряємо 04.11');
  let s2 = await boot(storage);
  await sleep(1000);
  check('після входу в памʼяті 04.11 має сирі дані (з хмари)', ev(s2.w, "!!(DAYS['2026-11-04']&&DAYS['2026-11-04']._parts)"));
  // Звіт за день 04.11
  ev(s2.w, "rptMode='day';rptDayKey='2026-11-04';showView&&showView('report');renderReport()");
  await sleep(500);
  const rptTxt = ev(s2.w, "(document.getElementById('rptOut')||{}).textContent||''");
  check('Звіт 04.11: секція GPS (Wialon) має рядки', /GPS \(Wialon\)/.test(rptTxt) && /ВС1111АА/.test(rptTxt) && /40\.00 км/.test(rptTxt), rptTxt.slice(0, 300));
  check('Звіт 04.11: BOLT і UKLON на місці', /Петренко/.test(rptTxt) && /UKLON/.test(rptTxt));
  // Головна: вибір дня 04.11
  ev(s2.w, "setDay('2026-11-04')"); await sleep(500);
  check('Головна 04.11: є трекерні дані (gps_raw)', ev(s2.w, "!!(DATA&&DATA.date==='2026-11-04'&&DATA.gps_raw&&Object.keys(DATA.gps_raw).length)"));

  // «Оновити все» за 04.11 після перезапуску → і головна, і звіт бачать GPS
  ev(s2.w, "rptMode='day';rptDayKey='2026-11-03';renderReport()"); await sleep(300);
  ev(s2.w, "rptHy('2026-11-03')");
  ev(s2.w, "document.getElementById('boltDate').value='2026-11-03'"); await ev(s2.w, 'updateAll()'); await sleep(300);
  const st3 = ev(s2.w, "document.getElementById('boltStat').textContent");
  check('«Оновити все» 03.11: GPS підтягнуто', /GPS 2026-11-03/.test(st3), st3);
  check('Головна 03.11 після оновлення: є GPS', ev(s2.w, "!!(DATA&&DATA.date==='2026-11-03'&&DATA.gps_raw&&Object.keys(DATA.gps_raw).length)"));
  ev(s2.w, "rptDayKey='2026-11-03';renderReport()"); await sleep(400);
  const r03 = ev(s2.w, "(document.getElementById('rptOut')||{}).textContent||''");
  check('Звіт 03.11 одразу після «Оновити все»: є GPS', /ВС1111АА/.test(r03), r03.slice(0,200));

  // ---- Сесія 3: день, якого НЕМАЄ повним у памʼяті (симулюємо: прибрали _parts) → має дотягнутись із хмари ----
  console.log('Сесія 3: полегшений день дотягується з хмари');
  ev(s2.w, "(function(){var d=DAYS['2026-10-27'];var o={};for(var k in d){if(k!=='_parts'&&k!=='gps_raw')o[k]=d[k];}o._light=1;DAYS['2026-10-27']=o;})()");
  ev(s2.w, "rptDayKey='2026-10-27';renderReport()"); await sleep(600);
  const r27 = ev(s2.w, "(document.getElementById('rptOut')||{}).textContent||''");
  check('Звіт 27.10: GPS підтягнувся з хмари', /ВС2222ВВ/.test(r27) && /41\.00 км/.test(r27), r27.slice(0, 200));
  ev(s2.w, "(function(){var d=DAYS['2026-10-28'];var o={};for(var k in d){if(k!=='_parts'&&k!=='gps_raw')o[k]=d[k];}o._light=1;DAYS['2026-10-28']=o;})()");
  ev(s2.w, "setDay('2026-10-28')"); await sleep(600);
  check('Головна 28.10: GPS підтягнувся з хмари', ev(s2.w, "!!(DATA&&DATA.date==='2026-10-28'&&DATA.gps_raw&&Object.keys(DATA.gps_raw).length)"));

  // ---- Усі екрани відкриваються без помилок, на кожному є вміст ----
  const VIEWS = ['overview','drivers','cars','week','compare','report','tracker','history','branding','coverage','standing','status','morning','rent','trent','settings','owner','cabinet','help','dyn'];
  ev(s2.w, "setDay('2026-11-04')"); await sleep(300);
  const before = s2.errs.length; const bad = [];
  for (const v of VIEWS) { try { ev(s2.w, "showView('" + v + "')"); await sleep(120); } catch (e) { bad.push(v + ': ' + e.message); } }
  check('усі ' + VIEWS.length + ' екранів відкриваються без помилок', bad.length === 0 && s2.errs.length === before, bad.concat(s2.errs.slice(before)).join(' | '));
  ev(s2.w, "showView('tracker')"); await sleep(200);
  const trk = ev(s2.w, "(document.getElementById('tracker')||{}).textContent||''");
  check('екран «Трекер» за 04.11 показує авто з GPS', /ВС1111АА|ВС 1111 АА|1111/.test(trk), trk.slice(0, 200));

  // ---- Гроші не змінились: суми з хмари == суми в памʼяті ----
  const money = ev(s2.w, "JSON.stringify(['2026-10-25','2026-11-04','2026-11-08'].map(function(k){var H=rptHy(k);return (H.drivers||[]).map(function(o){return Math.round((o.net||0)*100)}).sort()}))");
  const cloudMoney = JSON.stringify(['2026-10-25', '2026-11-04', '2026-11-08'].map(k => (CLOUD.get('day:' + k).drivers || []).map(o => Math.round((o.net || 0) * 100)).sort()));
  check('суми водіїв за минулі дні не змінились', money === cloudMoney, money + ' vs ' + cloudMoney);
  check('без помилок JS на сторінці', s2.errs.length === 0 && s1.errs.length === 0, [...s1.errs, ...s2.errs].join(' | '));

  console.log(`\nРезультат: ${pass} пройдено, ${fail} не пройдено`);
  s2.w.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
