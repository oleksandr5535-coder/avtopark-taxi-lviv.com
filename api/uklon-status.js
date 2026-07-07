// /api/uklon-status.js — «хто зараз онлайн» по Uklon (окрема функція, дзеркало bolt-status)
//   GET /api/geolocation/{fleetId}/drivers  ->  статус + номер + координати
//   /api/uklon-status           -> JSON: лічильники + список авто зі статусом
//   /api/uklon-status?html=1    -> проста HTML-сторінка (глянути очима)
// Змінні оточення (вже є): UKLON_CLIENT_ID, UKLON_CLIENT_SECRET, UKLON_FLEET_ID

const BASE = 'https://fleets-public-api.uklon.com.ua';
export const maxDuration = 30;

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

// Uklon status -> наш загальний вигляд (за реальними значеннями з API)
const STATE = {
  OrderExecution: { label: 'На замовленні', group: 'on_order', dot: '🔵' },
  Waiting:        { label: 'Очікування', group: 'on_order', dot: '🔵' },
  Active:         { label: 'Вільний', group: 'free', dot: '🟢' },
  Free:           { label: 'Вільний', group: 'free', dot: '🟢' },
  OnBreak:        { label: 'Перерва', group: 'break', dot: '🟠' },
  Restricted:     { label: 'З обмеженнями', group: 'break', dot: '🟠' },
  Inactive:       { label: 'Офлайн', group: 'offline', dot: '⚪' },
};

export default async function handler(req, res) {
  try {
    const id = process.env.UKLON_CLIENT_ID, secret = process.env.UKLON_CLIENT_SECRET;
    const fleetId = process.env.UKLON_FLEET_ID;
    if (!id || !secret) throw new Error('Немає UKLON_CLIENT_ID / UKLON_CLIENT_SECRET');
    if (!fleetId) throw new Error('Немає UKLON_FLEET_ID');

    const token = await auth(id, secret);
    const r = await fetch(BASE + '/api/geolocation/' + fleetId + '/drivers', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    });
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch (e) { throw new Error('geolocation не-JSON (' + r.status + '): ' + txt.slice(0, 160)); }

    // масив водіїв може лежати в корені або в полі items/drivers/data
    const arr = Array.isArray(j) ? j : (j.items || j.drivers || j.data || []);

    const drivers = (arr || []).map(function (d) {
      const v = d.vehicle || {};
      const dr = d.driver || {};
      const rawStatus = d.status || d.state || '—';
      const st = STATE[rawStatus] || { label: rawStatus, group: 'other', dot: '⚫' };
      const name = [dr.first_name, dr.last_name].filter(Boolean).join(' ') || d.name || '';
      return {
        car: (v.license_plate || d.license_plate || '—'),
        driver: name,
        state: rawStatus, label: st.label, group: st.group, dot: st.dot,
        lat: (d.lat != null ? d.lat : (d.latitude != null ? d.latitude : null)),
        lng: (d.lng != null ? d.lng : (d.longitude != null ? d.longitude : null)),
        src: 'uklon',
      };
    });

    const order = { on_order: 0, free: 1, break: 2, other: 3, offline: 4 };
    drivers.sort((a, b) => (order[a.group] - order[b.group]) || String(a.car).localeCompare(String(b.car)));

    const counts = { free: 0, on_order: 0, break: 0, offline: 0, other: 0, total: drivers.length };
    for (const d of drivers) counts[d.group] = (counts[d.group] || 0) + 1;
    counts.online = counts.free + counts.on_order + counts.break;

    const payload = { ok: true, updated: new Date().toISOString(), counts, drivers };

    if (req.query && req.query.debug) {
      const statuses = {};
      drivers.forEach(d => { statuses[d.state] = (statuses[d.state] || 0) + 1; });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(JSON.stringify({ total: drivers.length, statuses, sample: drivers.slice(0, 3) }, null, 2));
    }

    if (req.query && req.query.html) {
      const rows = drivers.map(d =>
        '<tr><td>' + d.dot + ' ' + d.label + '</td><td><b>' + d.car + '</b></td><td>' + (d.driver || '') + '</td></tr>'
      ).join('');
      const html = '<!doctype html><meta charset=utf-8><title>Uklon статус</title>'
        + '<style>body{font:14px/1.5 system-ui;margin:22px;color:#1a1c22}h2{margin:0 0 4px}'
        + '.sum{font-size:15px;margin:0 0 14px}table{border-collapse:collapse;width:100%;max-width:640px}'
        + 'td,th{padding:7px 10px;border-bottom:1px solid #eee;text-align:left}'
        + 'thead th{border-bottom:2px solid #ccc;font-size:12px;color:#666}</style>'
        + '<h2>Uklon · статус водіїв</h2>'
        + '<p class=sum>🟢 Вільних: <b>' + counts.free + '</b> · 🔵 На замовленні: <b>' + counts.on_order + '</b> · 🟠 Перерва/обмеження: <b>' + counts.break + '</b> · ⚪ Офлайн: <b>' + counts.offline + '</b> &nbsp; (на лінії ' + counts.online + ' з ' + counts.total + ')</p>'
        + '<table><thead><tr><th>Статус</th><th>Авто</th><th>Водій</th></tr></thead><tbody>' + rows + '</tbody></table>';
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
