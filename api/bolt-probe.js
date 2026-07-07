// /api/bolt-probe.js — ОКРЕМА діагностична функція (не чіпає bolt.js).
// Логіниться тими ж ключами (BOLT_CLIENT_ID / BOLT_CLIENT_SECRET) і:
//   /api/bolt-probe?token=1   -> віддає свіжий access_token (щоб вставити в Swagger Authorize)
//   /api/bolt-probe           -> перебирає ймовірні методи (шукає брендування/бонуси/кампанії)
//
// Змінні оточення (вже є на Vercel): BOLT_CLIENT_ID, BOLT_CLIENT_SECRET

const COMPANY_ID = 25859;
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
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, 12000);
  const j = await r.json();
  if (!j.access_token) throw new Error('Токен не отримано: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

export default async function handler(req, res) {
  try {
    const token = await getToken();

    // ?token=1 -> просто віддати токен для Swagger Authorize
    if (req.query && req.query.token) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(token);
    }

    // інакше -> перебір методів у v1 і v2 (шукаємо брендування/бонуси/кампанії)
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - 7 * 24 * 3600;
    const bases = [
      'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1',
      'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v2',
    ];
    const methods = [
      'getCampaigns', 'getCampaignList', 'getFleetCampaigns', 'getActiveCampaigns',
      'getBonuses', 'getFleetBonuses', 'getBrandingBonuses', 'getBranding',
      'getCompensations', 'getFleetCompensations', 'getPayouts', 'getFleetPayouts',
      'getEarnings', 'getDriverEarnings', 'getFleetEarnings', 'getCompanyEarnings',
      'getInvoices', 'getEngagementData', 'getFleetEngagementData',
      'getCampaignParticipants', 'getIncentives', 'getFleetIncentives',
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
      const ver = base.endsWith('v2') ? 'v2' : 'v1';
      for (const m of methods) {
        const url = base + '/' + m;
        let status = '?', snippet = '';
        // спробувати POST, і якщо 404/405 — GET (раптом метод GET)
        try {
          let r = await fetchT(url, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 9000);
          if (r.status === 404 || r.status === 405) {
            const rg = await fetchT(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } }, 9000);
            if (rg.status !== 404 && rg.status !== 405) r = rg;
          }
          status = r.status;
          const txt = await r.text();
          snippet = txt.slice(0, 300).replace(/</g, '&lt;');
        } catch (e) { status = 'ERR'; snippet = (e.message || '').slice(0, 140); }
        rows.push({ ver, method: m, status, snippet });
      }
    }

    const esc = s => String(s);
    const found = rows.filter(r => String(r.status) === '200');
    const html = '<html><head><meta charset="utf-8"><style>'
      + 'body{font:13px monospace;padding:16px;color:#1a1c22}table{border-collapse:collapse;width:100%}'
      + 'td,th{border:1px solid #ccc;padding:5px 7px;vertical-align:top}th{background:#eee}'
      + '.ok{background:#e7f7e7}.no{background:#faf0f0;color:#a33}.snip{max-width:680px;word-break:break-all;color:#333}'
      + 'h3{margin:0 0 6px}</style></head><body>'
      + '<h3>Bolt Fleet API — пошук брендування / бонусів / кампаній</h3>'
      + '<p>Зелений (200) = метод існує. Дивись у відповідь на поля bonus / campaign / branding / amount.'
      + ' Знайдено робочих методів: <b>' + found.length + '</b>.</p>'
      + '<table><thead><tr><th>API</th><th>Метод</th><th>Статус</th><th>Відповідь (початок)</th></tr></thead><tbody>'
      + rows.map(r => '<tr class="' + (String(r.status) === '200' ? 'ok' : 'no') + '"><td>' + r.ver + '</td><td>' + r.method + '</td><td>' + esc(r.status) + '</td><td class=snip>' + esc(r.snippet) + '</td></tr>').join('')
      + '</tbody></table></body></html>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (err) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify({ ok: false, error: err.message }));
  }
}
