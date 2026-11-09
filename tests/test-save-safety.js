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
const FAIL = { upsert: false, select: false };
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
      upsert(o) { if (FAIL.upsert) return Promise.resolve({ error: { message: 'JWT expired' } }); (Array.isArray(o) ? o : [o]).forEach(x => CLOUD.set(x.key, typeof x.value === 'string' ? (() => { try { return JSON.parse(x.value); } catch (e) { return x.value; } })() : JSON.parse(JSON.stringify(x.value)))); return Promise.resolve({ error: null }); },
      delete() { return { eq(c, v) { CLOUD.delete(v); return Promise.resolve({ error: null }); } }; },
      then(res, rej) {
        if (FAIL.select) return Promise.resolve({ data: null, error: { message: 'network' } }).then(res, rej);
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
  const DATES = []; for (let d = 1; d <= 31; d++) DATES.push('2026-10-' + String(d).padStart(2, '0')); for (let d = 1; d <= 8; d++) DATES.push('2026-11-0' + d);
  // хмара: 39 повних днів (як зараз у Supabase), робимо через справжній дашборд
  let s1 = await boot({});
  for (const d of DATES) { ev(s1.w, `document.getElementById('boltDate').value='${d}'`); await ev(s1.w, 'updateAll()'); }
  await sleep(300);
  const full = k => { const c = CLOUD.get('day:' + k); return c && c._parts ? { g: c._parts.wialon_trips_rows.length, u: c._parts.uklon_agg.length, b: c._parts.bolt_income.length } : null; };
  check('підготовка: у хмарі 39 повних днів', DATES.every(k => { const f = full(k); return f && f.g && f.u && f.b; }));

  console.log('№1 — окрема кнопка Bolt не затирає Uklon і GPS');
  // а) полегшений день у памʼяті
  ev(s1.w, "(function(){var d=DAYS['2026-10-05'];var o={};for(var k in d){if(k!=='_parts'&&k!=='gps_raw')o[k]=d[k];}o._light=1;DAYS['2026-10-05']=o;})()");
  ev(s1.w, "document.getElementById('boltDate').value='2026-10-05'"); await ev(s1.w, 'updateBolt()'); await sleep(2600);
  let f = full('2026-10-05');
  check('полегшений 05.10 → «Оновити Bolt»: у хмарі лишились GPS і Uklon', f && f.g > 0 && f.u > 0, JSON.stringify(f));
  check('полегшений 05.10 → у памʼяті день повний з GPS', ev(s1.w, "!!(DAYS['2026-10-05']._parts&&DAYS['2026-10-05']._parts.wialon_trips_rows.length)"));
  // б) дня в памʼяті немає зовсім (старий, поза 45 днями)
  ev(s1.w, "delete DAYS['2026-10-02']");
  ev(s1.w, "document.getElementById('boltDate').value='2026-10-02'"); await ev(s1.w, 'updateBolt()'); await sleep(2600);
  f = full('2026-10-02');
  check('дня 02.10 немає в браузері → «Оновити Bolt»: GPS і Uklon у хмарі цілі', f && f.g > 0 && f.u > 0, JSON.stringify(f));
  // в) хмара не відповідає → оновлення зупиняється, хмара не чіпається
  ev(s1.w, "(function(){var d=DAYS['2026-10-06'];var o={};for(var k in d){if(k!=='_parts'&&k!=='gps_raw')o[k]=d[k];}o._light=1;DAYS['2026-10-06']=o;})()");
  const before06 = JSON.stringify(CLOUD.get('day:2026-10-06'));
  FAIL.select = true;
  ev(s1.w, "document.getElementById('boltDate').value='2026-10-06'"); await ev(s1.w, 'updateBolt()'); await sleep(2600);
  FAIL.select = false;
  const st06 = ev(s1.w, "document.getElementById('boltStat').textContent");
  check('хмара мовчить → Bolt не оновлює, пише зрозумілу помилку', /не вдалося взяти повний день/.test(st06), st06);
  check('хмара мовчить → день 06.10 у хмарі не змінився', JSON.stringify(CLOUD.get('day:2026-10-06')) === before06);
  // г) новий день, якого ніде немає — працює як раніше
  ev(s1.w, "document.getElementById('boltDate').value='2026-11-09'"); await ev(s1.w, 'updateAll()'); await sleep(2600);
  f = full('2026-11-09');
  check('новий день 09.11 → «Оновити все» працює як раніше', f && f.g > 0 && f.u > 0 && f.b > 0, JSON.stringify(f));
  // д) Uklon/GPS окремо на полегшеному дні — тепер самі беруть повний день
  ev(s1.w, "(function(){var d=DAYS['2026-10-07'];var o={};for(var k in d){if(k!=='_parts'&&k!=='gps_raw')o[k]=d[k];}o._light=1;DAYS['2026-10-07']=o;})()");
  ev(s1.w, "document.getElementById('boltDate').value='2026-10-07'"); await ev(s1.w, 'updateGPS()'); await sleep(2600);
  const st07 = ev(s1.w, "document.getElementById('boltStat').textContent");
  check('полегшений 07.10 → «GPS» окремо: підтягнувся без «спершу Bolt»', /✓ GPS 2026-10-07/.test(st07), st07);
  f = full('2026-10-07');
  check('…і Bolt з Uklon за 07.10 у хмарі цілі', f && f.b > 0 && f.u > 0, JSON.stringify(f));

  console.log('№2 — збереження перевіряється');
  // полегшену копію в хмару не пишемо ніколи
  const b10 = JSON.stringify(CLOUD.get('day:2026-10-10'));
  await ev(s1.w, "cloudSaveDay({date:'2026-10-10',_light:1,drivers:[]})");
  check('полегшена копія не може затерти повний день у хмарі', JSON.stringify(CLOUD.get('day:2026-10-10')) === b10);
  // Supabase відмовляє (прострочений вхід)
  FAIL.upsert = true;
  ev(s1.w, "document.getElementById('boltDate').value='2026-10-12'"); await ev(s1.w, 'updateAll()'); await sleep(7000);
  const unsync = JSON.parse(ev(s1.w, "localStorage.getItem('days_unsynced')||'{}'"));
  check('Supabase відмовив → 12.10 у списку «не збережено»', !!unsync['2026-10-12'], JSON.stringify(unsync));
  const ban = ev(s1.w, "(document.getElementById('unsyncBanner')||{}).textContent||''");
  check('на екрані червона плашка «Не збережено в хмару: 12.10»', /Не збережено в хмару: .*12\.10/.test(ban), ban);
  const ls = JSON.parse(ev(s1.w, "localStorage.getItem('days_store')"));
  check('браузер тримає 12.10 повністю (сирі дані не полегшено)', !!(ls['2026-10-12'] && ls['2026-10-12']._parts), Object.keys(ls).length + ' днів');
  const storage = {}; for (let i = 0; i < s1.w.localStorage.length; i++) { const k = s1.w.localStorage.key(i); storage[k] = s1.w.localStorage.getItem(k); }
  const ts12local = ev(s1.w, "DAYS['2026-10-12']._ts");
  s1.w.close();
  // інтернет/вхід повернувся → при наступному вході зберігається саме
  FAIL.upsert = false;
  let s2 = await boot(storage); await sleep(3500);
  check('після входу 12.10 сам дозберігся в хмару', (CLOUD.get('day:2026-10-12') || {})._ts === ts12local);
  check('список «не збережено» очистився, плашки немає', !ev(s2.w, "localStorage.getItem('days_unsynced')") && !ev(s2.w, "document.getElementById('unsyncBanner')"));
  // кнопка «Повторити» на плашці
  FAIL.upsert = true;
  ev(s2.w, "document.getElementById('boltDate').value='2026-10-13'"); await ev(s2.w, 'updateAll()'); await sleep(7000);
  FAIL.upsert = false;
  ev(s2.w, "document.querySelector('#unsyncBanner button').click()"); await sleep(1500);
  check('кнопка «Повторити» зберегла 13.10 і прибрала плашку', (CLOUD.get('day:2026-10-13') || {})._ts === ev(s2.w, "DAYS['2026-10-13']._ts") && !ev(s2.w, "document.getElementById('unsyncBanner')"));

  // кнопка «Новий тиждень» прибрана, масове видалення вимкнене
  check('кнопки «Новий тиждень» на головній немає', !ev(s2.w, "document.getElementById('newWeek')") && !ev(s2.w, "[].some.call(document.querySelectorAll('button'),function(b){return /Новий тиждень/.test(b.textContent)})"));
  check('блок «Дані наживо» на місці: Оновити все, Bolt/Uklon/GPS, Завантажити файли', ev(s2.w, "!!(document.querySelector('.liveblk')&&document.getElementById('allBtn')&&document.getElementById('gpsBtn')&&/Завантажити файли/.test(document.querySelector('.liveblk').textContent))"));
  const nDays = [...CLOUD.keys()].filter(k => k.startsWith('day:')).length;
  await ev(s2.w, 'cloudDeleteAllDays()');
  check('навіть прямий виклик не видаляє дні з хмари (' + nDays + ' днів цілі)', [...CLOUD.keys()].filter(k => k.startsWith('day:')).length === nDays && nDays > 30);

  // все решта як було
  const bad = []; const VIEWS = ['overview','drivers','cars','week','compare','report','tracker','history','branding','coverage','standing','status','morning','rent','trent','settings','owner','cabinet','help','dyn'];
  const e0 = s2.errs.length;
  for (const v of VIEWS) { try { ev(s2.w, "showView('" + v + "')"); await sleep(100); } catch (e) { bad.push(v + ': ' + e.message); } }
  check('усі 20 екранів відкриваються без помилок', !bad.length && s2.errs.length === e0, bad.concat(s2.errs.slice(e0)).join(' | '));
  const cm = k => (CLOUD.get('day:' + k).drivers || []).map(o => Math.round((o.net || 0) * 100)).sort().join(',');
  check('суми водіїв за минулі дні не змінились', ['2026-10-01','2026-10-05','2026-11-04'].every(k => cm(k) === ev(s2.w, "(rptHy('" + k + "').drivers||[]).map(function(o){return Math.round((o.net||0)*100)}).sort().join(',')")));
  check('без помилок JS', s1.errs.length === 0 && s2.errs.length === 0, [...s1.errs, ...s2.errs].join(' | '));
  console.log(`\nРезультат: ${pass} пройдено, ${fail} не пройдено`);
  s2.w.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
