// /api/wialon-probe.js  — ДІАГНОСТИКА Wialon
// Мета: побачити реальну структуру ПІД-РЯДКІВ (окремі поїздки/стоянки),
// а не лише денні підсумки. Нічого не змінює у робочій /api/wialon.js.
// Змінна оточення: WIALON_TOKEN (той самий, що в /api/wialon).

const HOST = 'https://hst-api.wialon.eu';
const RESOURCE_ID = 600586295;  // ресурс "Holubkov"
const REPORT_ID   = 5;          // шаблон "Груповий звіт"
const GROUP_ID    = 600601067;  // група авто "Super-Sasha"

// Київ: EET/EEST. tzOffset для Wialon = пакет (зсув + прапор DST).
// 0x0CEA6000 — типове значення для України (UTC+2/+3 з автоматичним переходом).
// Якщо години зміщені — підкоригуємо за результатом діагностики.
const TZ_KYIV = 0x0CEA6000;

async function call(svc, params, sid) {
  let url = HOST + '/wialon/ajax.html?svc=' + svc + '&params=' + encodeURIComponent(JSON.stringify(params));
  if (sid) url += '&sid=' + sid;
  const r = await fetch(url);
  return r.json();
}

function ymd(d){ // unix(сек) -> межі доби за Києвом? ні: беремо просту добу UTC діапазону навколо дати
  return d;
}

export default async function handler(req, res) {
  const out = { steps: {} };
  try {
    const token = process.env.WIALON_TOKEN;
    if (!token) throw new Error('Немає WIALON_TOKEN у змінних оточення');

    // 1) ВХІД
    const login = await call('token/login', { token });
    if (!login || !login.eid) throw new Error('Вхід не вдався: ' + JSON.stringify(login).slice(0, 200));
    const sid = login.eid;
    out.steps.login = { ok: true, user: login.user && login.user.nm };

    // 2) ЛОКАЛІЗАЦІЯ (київський час + формат як у zip)
    const loc = await call('render/set_locale',
      { tzOffset: TZ_KYIV, language: 'uk', formatDate: '%Y-%m-%d %H:%M:%S' }, sid);
    out.steps.locale = loc;

    // 3) Інтервал: вибрана дата (?date=YYYY-MM-DD) або останні 24 год
    const dateStr = (req.query && req.query.date) ? String(req.query.date) : null;
    let from, to;
    if (dateStr) {
      // доба за Києвом ~ UTC-2; беремо з запасом
      const base = Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
      from = base - 3 * 3600;          // трохи раніше
      to   = base + 24 * 3600 + 3600;  // до кінця доби з запасом
    } else {
      to = Math.floor(Date.now() / 1000);
      from = to - 24 * 3600;
    }
    out.steps.interval = { from, to, dateStr };

    // 4) Очистити попередній результат (в сесії може бути лише один звіт)
    await call('report/cleanup_result', {}, sid);

    // 5) ВИКОНАТИ ЗВІТ
    const exec = await call('report/exec_report', {
      reportResourceId: RESOURCE_ID,
      reportTemplateId: REPORT_ID,
      reportObjectId: GROUP_ID,
      reportObjectSecId: 0,
      interval: { from, to, flags: 0 },
    }, sid);

    const rr = exec && exec.reportResult;
    if (!rr) throw new Error('Звіт не виконався: ' + JSON.stringify(exec).slice(0, 300));
    out.steps.exec = {
      ok: true,
      stats: rr.stats,
      tables: (rr.tables || []).map((t, i) => ({
        index: i, name: t.name, label: t.label, rows: t.rows, level: t.level,
        columns: t.columns, header: t.header,
      })),
    };

    // 6) ВИТЯГ ПІД-РЯДКІВ: для кожної таблиці беремо ВСІ рівні через select_result_rows
    out.steps.tables_data = [];
    const tables = rr.tables || [];
    for (let ti = 0; ti < tables.length; ti++) {
      const rowsCount = tables[ti].rows || 0;
      // запит діапазону всіх рядків з глибиною рівнів (level: великий, щоб дістати під-рядки)
      const sel = await call('report/select_result_rows', {
        tableIndex: ti,
        config: { type: 'range', data: { from: 0, to: Math.max(rowsCount - 1, 0), level: 8 } },
      }, sid);
      // показуємо лише ПЕРШІ елементи, щоб побачити структуру (не весь масив)
      let preview = sel;
      if (Array.isArray(sel)) {
        preview = sel.slice(0, 2).map(top => ({
          c: top.c, i1: top.i1, i2: top.i2, t: top.t, d: top.d,
          rows: Array.isArray(top.r) ? top.r.slice(0, 3) : top.r,
          _keys: Object.keys(top),
        }));
      }
      out.steps.tables_data.push({
        tableIndex: ti, name: tables[ti].name, label: tables[ti].label,
        rowsCount, sample: preview,
      });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ ok: true, ...out }, null, 2));
  } catch (err) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({ ok: false, error: err.message, ...out }, null, 2));
  }
}
