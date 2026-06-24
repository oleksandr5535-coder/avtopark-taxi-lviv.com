// /api/wialon.js  — ПОВНА ВЕРСІЯ з витягом окремих поїздок/стоянок (під-рядків)
// Логіниться, виконує груповий звіт, тягне під-рядки через select_result_rows,
// бере час із надійного поля v (unix) і переводить у київський сам.
// Повертає { ok, date, trips:[...], stops:[...] } — рядки в форматі, який розуміє дашборд.
// Змінна оточення: WIALON_TOKEN

const HOST = 'https://hst-api.wialon.eu';
const RESOURCE_ID = 600586295;  // ресурс "Holubkov"
const REPORT_ID   = 5;          // шаблон "Груповий звіт"
const GROUP_ID    = 600601067;  // група авто "Super-Sasha"

async function call(svc, params, sid) {
  let url = HOST + '/wialon/ajax.html?svc=' + svc + '&params=' + encodeURIComponent(JSON.stringify(params));
  if (sid) url += '&sid=' + sid;
  const r = await fetch(url);
  return r.json();
}

// unix(сек) -> київський рядок. withDate=true: "YYYY-MM-DD HH:MM:SS"; false: "HH:MM:SS"
function fmtKyiv(v, withDate) {
  const d = new Date(v * 1000);
  const opt = withDate
    ? { timeZone:'Europe/Kyiv', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }
    : { timeZone:'Europe/Kyiv', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false };
  const p = new Intl.DateTimeFormat('en-CA', opt).formatToParts(d);
  const g = t => { const x = p.find(z => z.type === t); return x ? x.value : ''; };
  if (withDate) return g('year')+'-'+g('month')+'-'+g('day')+' '+g('hour')+':'+g('minute')+':'+g('second');
  return g('hour')+':'+g('minute')+':'+g('second');
}
const cellText = c => (c && typeof c === 'object') ? (c.t || '') : (c == null ? '' : String(c));
const cellTime = (c, withDate) => (c && typeof c === 'object' && typeof c.v === 'number' && c.v > 0) ? fmtKyiv(c.v, withDate) : cellText(c);
function flatten(rows, acc) { (rows || []).forEach(r => { if (r && r.c) acc.push(r); if (r && Array.isArray(r.r)) flatten(r.r, acc); }); return acc; }

// київський зсув (сек) для конкретного моменту
function kyivOffsetSec(date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone:'Europe/Kyiv', hour12:false,
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 1000;
}

export default async function handler(req, res) {
  try {
    const token = process.env.WIALON_TOKEN;
    if (!token) throw new Error('Немає WIALON_TOKEN');

    // дата (?date=YYYY-MM-DD) або сьогодні за Києвом
    let dateStr = (req.query && req.query.date) ? String(req.query.date) : null;
    if (!dateStr) {
      const p = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Kyiv', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
      const g = t => p.find(x => x.type === t).value;
      dateStr = g('year')+'-'+g('month')+'-'+g('day');
    }
    // точна київська доба [00:00, 24:00)
    const off = kyivOffsetSec(new Date(dateStr + 'T12:00:00Z'));
    const from = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000) - off;
    const to = from + 86400;

    // 1) вхід
    const login = await call('token/login', { token });
    if (!login || !login.eid) throw new Error('Вхід не вдався: ' + JSON.stringify(login).slice(0, 200));
    const sid = login.eid;

    // 2) локалізація (мова; час усе одно беремо з v)
    await call('render/set_locale', { tzOffset: 10800, language: 'uk', formatDate: '%Y-%m-%d %H:%M:%S' }, sid);

    // 3) очистити попередній звіт у сесії
    await call('report/cleanup_result', {}, sid);

    // 4) виконати звіт
    const exec = await call('report/exec_report', {
      reportResourceId: RESOURCE_ID, reportTemplateId: REPORT_ID,
      reportObjectId: GROUP_ID, reportObjectSecId: 0,
      interval: { from, to, flags: 0 },
    }, sid);
    const rr = exec && exec.reportResult;
    if (!rr) throw new Error('Звіт не виконався: ' + JSON.stringify(exec).slice(0, 300));

    const tables = rr.tables || [];
    const tripsTblIdx = tables.findIndex(t => t.name === 'unit_group_trips');
    const stopsTblIdx = tables.findIndex(t => t.name === 'unit_group_stays');

    async function pull(idx) {
      if (idx < 0) return [];
      const rowsCount = tables[idx].rows || 0;
      const sel = await call('report/select_result_rows', {
        tableIndex: idx,
        config: { type: 'range', data: { from: 0, to: Math.max(rowsCount - 1, 0), level: 8 } },
      }, sid);
      return Array.isArray(sel) ? sel : [];
    }
    const tripsRaw = await pull(tripsTblIdx);
    const stopsRaw = await pull(stopsTblIdx);

    const trips = [];
    flatten(tripsRaw, []).forEach(r => {
      const c = r.c; const num = cellText(c[0]); if (num.indexOf('.') < 0) return;
      trips.push({
        '№': num, 'Групування': cellText(c[1]),
        'Початок': cellTime(c[2], true), 'Кінець': cellTime(c[3], true),
        'Тривалість': cellText(c[4]), 'Пробіг': cellText(c[5]),
        'Макс. швидкість': cellText(c[6]), 'Штраф': cellText(c[7]),
      });
    });

    const stops = [];
    flatten(stopsRaw, []).forEach(r => {
      const c = r.c; const num = cellText(c[0]); if (num.indexOf('.') < 0) return;
      const start = cellTime(c[2], false); if (!start) return; // відсіяти порожні
      stops.push({
        '№': num, 'Групування': cellText(c[1]),
        'Початок': start, 'Кінець': cellTime(c[3], false),
        'Тривалість': cellText(c[4]), 'Місцезнаходження': cellText(c[5]),
      });
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ ok: true, date: dateStr, trips, stops }));
  } catch (err) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ ok: false, error: err.message }));
  }
}
