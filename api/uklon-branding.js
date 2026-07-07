// /api/uklon-branding.js — Uklon брендування по тижнях (окрема функція, не чіпає uklon.js)
// auth (client_credentials) -> активні програми -> періоди -> нарахування по авто
// Змінні оточення: UKLON_CLIENT_ID, UKLON_CLIENT_SECRET, UKLON_FLEET_ID
//
// Параметри запиту:
//   (без параметрів)     -> останні 8 тижнів
//   ?weeks=N             -> останні N тижнів
//   ?weeks=0             -> вся історія (для першого повного завантаження)
//   ?week=2026-06-29     -> лише конкретний тиждень (понеділок, Київ)

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

// YYYY-MM-DD у часовому поясі Києва з unix-секунд
function kyivYmd(unixSec) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(unixSec * 1000));
  const g = t => p.find(x => x.type === t).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}

async function getJSON(url, H) {
  const r = await fetch(url, { headers: H });
  const txt = await r.text();
  if (!r.ok) {
    if (r.status === 401) throw new Error('401 Unauthorized (перевір ключі UKLON_CLIENT_ID / UKLON_CLIENT_SECRET)');
    throw new Error(r.status + ' ' + txt.slice(0, 150));
  }
  try { return JSON.parse(txt); } catch (e) { throw new Error('Не JSON: ' + txt.slice(0, 150)); }
}

async function getActivePrograms(fleetId, H) {
  const list = await getJSON(BASE + '/api/bonuses/fleet-branding-bonus-programs/' + fleetId, H);
  return (list || []).filter(p => p && p.status === 'active');
}
async function getPeriods(fleetId, programId, H) {
  const list = await getJSON(
    BASE + '/api/bonuses/branding-periods?fleet_id=' + fleetId + '&program_id=' + programId, H
  );
  return (list || []).filter(p => p && p.period && Array.isArray(p.period.range));
}
async function getCalculation(calcId, fleetId, programId, H) {
  return await getJSON(
    BASE + '/api/bonuses/branding-programs/calculations/' + calcId +
    '?fleet_id=' + fleetId + '&program_id=' + programId, H
  );
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const id = process.env.UKLON_CLIENT_ID;
    const secret = process.env.UKLON_CLIENT_SECRET;
    const fleetId = process.env.UKLON_FLEET_ID;
    if (!id || !secret) throw new Error('Немає UKLON_CLIENT_ID / UKLON_CLIENT_SECRET');
    if (!fleetId) throw new Error('Немає UKLON_FLEET_ID');

    // параметри
    const q = req.query || {};
    const oneWeek = q.week ? String(q.week) : null;                 // конкретний тиждень
    let weeksLimit = 8;                                             // за замовчуванням
    if (q.weeks !== undefined) weeksLimit = parseInt(String(q.weeks), 10);
    if (isNaN(weeksLimit)) weeksLimit = 8;

    const token = await auth(id, secret);
    const H = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };

    const programs = await getActivePrograms(fleetId, H);
    if (!programs.length) {
      res.status(200).send(JSON.stringify({ ok: true, weeks: {}, count_weeks: 0, programs: [], note: 'Нема активних програм брендування' }));
      return;
    }

    // weeks[weekMonday] = { from, to, total, cars: { PLATE: {income, orders, driver, src} } }
    const weeks = {};
    const debug = [];

    for (const prog of programs) {
      let periods = await getPeriods(fleetId, prog.id, H);
      const totalPeriods = periods.length;
      periods.sort((a, b) => b.period.range[0] - a.period.range[0]); // новіші спершу
      const sampleMondays = periods.slice(0, 3).map(p => kyivYmd(p.period.range[0]));

      if (oneWeek) {
        periods = periods.filter(p => kyivYmd(p.period.range[0]) === oneWeek);
      } else if (weeksLimit > 0) {
        periods = periods.slice(0, weeksLimit);
      } // weeksLimit === 0 -> усі

      const dbg = { program: prog.name, periods_total: totalPeriods, sample_mondays: sampleMondays, after_filter: periods.length, calc: [] };
      debug.push(dbg);

      for (const per of periods) {
        const wk = kyivYmd(per.period.range[0]);
        const from = kyivYmd(per.period.range[0]);
        const to = kyivYmd(per.period.range[1]);
        let calc;
        try { calc = await getCalculation(per.calculation_id, fleetId, prog.id, H); }
        catch (e) { dbg.calc.push({ week: wk, error: e.message }); continue; }
        const items = (calc && calc.items) || [];
        dbg.calc.push({ week: wk, items: items.length });

        if (!weeks[wk]) weeks[wk] = { from, to, total: 0, cars: {} };
        for (const it of items) {
          const v = it.vehicle || {};
          const plate = (v.license_plate || '').trim();
          if (!plate) continue;
          const val = (it.bonus && typeof it.bonus.value === 'number') ? it.bonus.value : 0;
          const ord = (it.calculation_source && it.calculation_source.orders && it.calculation_source.orders.completed) || 0;
          const d = it.driver || {};
          const nm = [d.first_name, d.last_name].filter(Boolean).join(' ');
          const cars = weeks[wk].cars;
          if (!cars[plate]) cars[plate] = { income: 0, orders: 0, driver: nm, src: 'uklon' };
          cars[plate].income += val;         // сума по всіх активних програмах цього тижня
          cars[plate].orders += ord;
          if (nm) cars[plate].driver = nm;
        }
      }
    }

    // порахувати total по тижню
    let grand = 0;
    Object.keys(weeks).forEach(wk => {
      let t = 0;
      Object.keys(weeks[wk].cars).forEach(p => { t += weeks[wk].cars[p].income; });
      weeks[wk].total = t;
      grand += t;
    });

    res.status(200).send(JSON.stringify({
      ok: true,
      weeks,
      count_weeks: Object.keys(weeks).length,
      grand_total: grand,
      programs: programs.map(p => p.name),
      debug,
    }));
  } catch (err) {
    res.status(200).send(JSON.stringify({ ok: false, error: err.message }));
  }
}
