// Окремий діагностичний ендпойнт для перебору методів Bolt Fleet API.
// НЕ чіпає bolt.js. Самодостатній: власний токен, власні запити.
// Відкрити: https://<домен>/api/probe
// Потрібні ті самі env, що й у bolt.js: BOLT_CLIENT_ID, BOLT_CLIENT_SECRET (або як вони називаються).

export const maxDuration = 60;

const COMPANY_ID = 25859;

// fetch із таймаутом
async function fetchT(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 9000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getToken() {
  const id = process.env.BOLT_CLIENT_ID || process.env.BOLT_ID || process.env.CLIENT_ID;
  const secret = process.env.BOLT_CLIENT_SECRET || process.env.BOLT_SECRET || process.env.CLIENT_SECRET;
  if (!id || !secret) throw new Error('Немає BOLT_CLIENT_ID / BOLT_CLIENT_SECRET у змінних середовища');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: id,
    client_secret: secret,
    scope: 'fleet-integration:api',
  });
  const r = await fetchT('https://oidc.bolt.eu/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, 12000);
  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('Токен: не-JSON (' + r.status + '): ' + txt.slice(0, 160)); }
  if (!j.access_token) throw new Error('Токен: нема access_token (' + r.status + '): ' + txt.slice(0, 160));
  return j.access_token;
}

export default async function handler(req, res) {
  try {
    const token = await getToken();
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - 7 * 24 * 3600;

    const bases = [
      'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1',
      'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v2',
    ];
    const methods = [
      'getFleetOrders', 'getDrivers', 'getDriversByDateRange', 'getVehicles',
      'getCompanyState', 'getFleetState', 'getCompanyBalance', 'getBalance',
      'getDriverEarnings', 'getEarnings', 'getCompanyEarnings', 'getFleetEarnings',
      'getCompensations', 'getBonuses', 'getPayouts', 'getInvoices',
      'getFleetEngagementData', 'getDriverEngagementData', 'getCampaigns',
      'getCommission', 'getCommissionInvoices', 'getEngagementData',
      'getEarningsReport', 'getBalanceHistory', 'getFleetBalance', 'getCompensationsList',
    ];

    const body = {
      company_ids: [COMPANY_ID], company_id: COMPANY_ID,
      start_ts: weekAgo, end_ts: now,
      start_date: new Date(weekAgo * 1000).toISOString().slice(0, 10),
      end_date: new Date(now * 1000).toISOString().slice(0, 10),
      offset: 0, limit: 10,
    };

    const rows = [];
    for (const base of bases) {
      for (const m of methods) {
        const url = base + '/' + m;
        let status = '?', snippet = '';
        try {
          const r = await fetchT(url, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }, 9000);
          status = r.status;
          const txt = await r.text();
          snippet = txt.slice(0, 300);
        } catch (e) {
          status = 'ERR';
          snippet = (e.message || '').slice(0, 140);
        }
        rows.push({ ver: base.endsWith('v2') ? 'v2' : 'v1', method: m, status, snippet });
      }
    }

    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html =
      '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<style>body{font:13px/1.4 monospace;padding:14px;color:#111}table{border-collapse:collapse;width:100%}'
      + 'td,th{border:1px solid #ccc;padding:5px 7px;vertical-align:top;text-align:left}th{background:#eee;position:sticky;top:0}'
      + '.ok{background:#e7f7e7}.no{background:#fbeaea}.snip{max-width:70vw;word-break:break-all;color:#333}'
      + 'h3{margin:0 0 6px}p{margin:4px 0 12px;color:#555}</style></head><body>'
      + '<h3>Bolt Fleet API — перебір методів</h3>'
      + '<p>Зелене (200) = метод існує й відповів. Шукай у «Відповідь» слова: bonus, compensation, campaign, branding, balance, engagement, earnings.</p>'
      + '<table><thead><tr><th>API</th><th>Метод</th><th>Статус</th><th>Відповідь (початок)</th></tr></thead><tbody>'
      + rows.map(r => '<tr class="' + (String(r.status) === '200' ? 'ok' : 'no') + '"><td>' + r.ver + '</td><td>' + esc(r.method) + '</td><td>' + esc(r.status) + '</td><td class="snip">' + esc(r.snippet) + '</td></tr>').join('')
      + '</tbody></table></body></html>';

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (e) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send('<pre>ПОМИЛКА probe: ' + String(e && e.message || e) + '</pre>');
  }
}
