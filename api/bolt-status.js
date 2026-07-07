// /api/bolt-status.js — «хто зараз онлайн» по Bolt (окрема функція, не чіпає bolt.js)
//   getFleetStateLogs -> останній стан кожного водія  +  getVehicles -> номер авто
//   /api/bolt-status            -> JSON: лічильники + список авто зі статусом
//   /api/bolt-status?hours=12   -> вікно пошуку станів (за замовч. 6 год)
//   /api/bolt-status?html=1     -> проста HTML-сторінка (глянути очима)
// Змінні оточення (вже є): BOLT_CLIENT_ID, BOLT_CLIENT_SECRET

const COMPANY_ID = 25859;
const API = 'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1';
export const maxDuration = 60;

async function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 12000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); }
  finally { clearTimeout(t); }
}

async function getToken() {
  const id = process.env.BOLT_CLIENT_ID, secret = process.env.BOLT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Немає BOLT_CLIENT_ID або BOLT_CLIENT_SECRET');
  const body = new URLSearchParams({
    client_id: id, client_secret: secret,
    grant_type: 'client_credentials', scope: 'fleet-integration:api',
  });
  const r = await fetchT('https://oidc.bolt.eu/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  }, 12000);
  const j = await r.json();
  if (!j.access_token) throw new Error('Токен не отримано: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function post(token, method, bodyObj) {
  const r = await fetchT(API + '/' + method, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj),
  }, 15000);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) { throw new Error(method + ' не-JSON (' + r.status + '): ' + txt.slice(0, 160)); }
}

// uuid авто -> номер (широке вікно + кілька пошуків, щоб зловити всі авто)
async function vehicleMap(token) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 30 * 24 * 3600; // 30 днів — авто нікуди не діваються
  const map = {};
  const searches = ['BC', 'B', 'A', 'C', 'K', 'X', 'T', 'E', 'O', 'I', 'M', 'P', 'H'];
  for (const s of searches) {
    let j;
    try {
      j = await post(token, 'getVehicles', {
        company_id: COMPANY_ID, start_ts: start, end_ts: now, offset: 0, limit: 1000,
        portal_status: 'active', search: s,
      });
    } catch (e) { continue; }
    const list = (j && j.data && j.data.vehicles) || [];
    for (const v of list) if (v.uuid) map[v.uuid] = v.reg_number || '—';
    if (Object.keys(map).length >= 40) break; // вистачить
  }
  return map;
}

// усі стани за вікно (з пагінацією) -> останній стан кожного водія
async function latestStates(token, start_ts, end_ts) {
  const limit = 1000; let offset = 0, total = null; const byDriver = {};
  for (let guard = 0; guard < 30; guard++) {
    const j = await post(token, 'getFleetStateLogs', { company_id: COMPANY_ID, start_ts, end_ts, offset, limit });
    const d = (j && j.data) ? j.data : {};
    const arr = Array.isArray(d.state_logs) ? d.state_logs : [];
    if (offset === 0 && typeof d.total_rows === 'number') total = d.total_rows;
    for (const s of arr) {
      const k = s.driver_uuid; if (!k) continue;
      if (!byDriver[k] || (s.created || 0) > (byDriver[k].created || 0)) byDriver[k] = s;
    }
    offset += arr.length;
    if (arr.length < limit) break;
    if (total != null && offset >= total) break;
  }
  return byDriver;
}

const STATE = {
  waiting_orders: { label: 'Вільний', group: 'free', dot: '🟢' },
  has_order:      { label: 'На замовленні', group: 'on_order', dot: '🔵' },
  busy:           { label: 'Зайнятий', group: 'on_order', dot: '🟠' },
  inactive:       { label: 'Офлайн', group: 'offline', dot: '⚪' },
};

export default async function handler(req, res) {
  try {
    const hours = Math.max(1, Math.min(48, parseInt((req.query && req.query.hours) || '6', 10) || 6));
    const now = Math.floor(Date.now() / 1000);
    const start_ts = now - hours * 3600;

    const token = await getToken();
    const [vmap, states] = await Promise.all([
      vehicleMap(token),
      latestStates(token, start_ts, now),
    ]);

    const drivers = Object.keys(states).map(k => {
      const s = states[k];
      const st = STATE[s.state] || { label: s.state || '—', group: 'offline', dot: '⚪' };
      const minsAgo = Math.round((now - (s.created || now)) / 60);
      return {
        car: vmap[s.vehicle_uuid] || '—',
        state: s.state, label: st.label, group: st.group, dot: st.dot,
        mins_ago: minsAgo,
        lat: s.lat, lng: s.lng,
        order: s.active_order ? { pickup: s.active_order.pickup_address, dest: s.active_order.destination_address } : null,
      };
    });

    // сортування: спочатку на замовленні, потім вільні, потім офлайн; всередині — за номером
    const order = { on_order: 0, free: 1, offline: 2 };
    drivers.sort((a, b) => (order[a.group] - order[b.group]) || String(a.car).localeCompare(String(b.car)));

    const counts = { free: 0, on_order: 0, offline: 0, total: drivers.length };
    for (const d of drivers) counts[d.group]++;
    counts.online = counts.free + counts.on_order;

    const payload = { ok: true, updated: new Date().toISOString(), window_hours: hours, counts, drivers };

    // ?debug=1 — діагностика звʼязки авто
    if (req.query && req.query.debug) {
      const vkeys = Object.keys(vmap);
      const sampleStateUuids = Object.keys(states).slice(0, 5).map(k => states[k].vehicle_uuid);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(JSON.stringify({
        vehicles_found: vkeys.length,
        vehicle_sample: vkeys.slice(0, 3).map(u => ({ uuid: u, plate: vmap[u] })),
        state_vehicle_uuids_sample: sampleStateUuids,
        match_test: sampleStateUuids.map(u => ({ uuid: u, plate: vmap[u] || 'НЕ ЗНАЙДЕНО' })),
      }, null, 2));
    }

    if (req.query && req.query.html) {
      const rows = drivers.map(d =>
        '<tr><td>' + d.dot + ' ' + d.label + '</td><td><b>' + d.car + '</b></td><td class=r>' + d.mins_ago + ' хв тому</td><td>' + (d.order ? (d.order.pickup || '') + ' → ' + (d.order.dest || '') : '') + '</td></tr>'
      ).join('');
      const html = '<!doctype html><meta charset=utf-8><title>Bolt статус</title>'
        + '<style>body{font:14px/1.5 system-ui;margin:22px;color:#1a1c22}h2{margin:0 0 4px}'
        + '.sum{font-size:15px;margin:0 0 14px}table{border-collapse:collapse;width:100%;max-width:820px}'
        + 'td,th{padding:7px 10px;border-bottom:1px solid #eee;text-align:left}.r{text-align:right}'
        + 'thead th{border-bottom:2px solid #ccc;font-size:12px;color:#666}</style>'
        + '<h2>Bolt · статус водіїв</h2>'
        + '<p class=sum>🟢 Вільних: <b>' + counts.free + '</b> · 🔵 На замовленні: <b>' + counts.on_order + '</b> · ⚪ Офлайн: <b>' + counts.offline + '</b> &nbsp; (усього ' + counts.total + ', вікно ' + hours + ' год)</p>'
        + '<table><thead><tr><th>Статус</th><th>Авто</th><th class=r>Оновлено</th><th>Замовлення</th></tr></thead><tbody>' + rows + '</tbody></table>';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify(payload));
  } catch (err) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify({ ok: false, error: err.message }));
  }
}
