// /api/bolt-probe.js
// Діагностика: логіниться в Bolt Fleet API і перебирає ймовірні "грошові" ендпойнти.
// Показує, який віддає 200 (існує) — щоб знайти справжній звіт заробітків.
// Використовує ті самі змінні оточення, що й /api/bolt: BOLT_CLIENT_ID, BOLT_CLIENT_SECRET.

const COMPANY_ID = 25859;

const BASES = [
  'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1',
  'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v2',
];

// кандидати-ендпойнти, які можуть віддавати заробітки/виплати/рахунки
const CANDIDATES = [
  'getDriverEarnings',
  'getCompanyEarnings',
  'getFleetEarnings',
  'getEarnings',
  'getOrdersEarnings',
  'getDriverEngagementData',
  'getFleetEngagementData',
  'getInvoices',
  'getDriverInvoices',
  'getCompanyInvoices',
  'getPayouts',
  'getFleetPayouts',
  'getStatements',
  'getFleetStatements',
  'getBalance',
  'getFleetBalance',
  'getWeeklyReport',
  'getDriverReports',
  'getReports',
];

async function getToken() {
  const id = process.env.BOLT_CLIENT_ID;
  const secret = process.env.BOLT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Немає BOLT_CLIENT_ID або BOLT_CLIENT_SECRET у змінних оточення');
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    grant_type: 'client_credentials',
    scope: 'fleet-integration:api',
  });
  const r = await fetch('https://oidc.bolt.eu/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Токен не отримано: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

export default async function handler(req, res) {
  try {
    const token = await getToken();

    // діапазон: останні 7 днів (щоб точно були дані)
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - 7 * 24 * 3600;
    const body = JSON.stringify({
      company_ids: [COMPANY_ID],
      company_id: COMPANY_ID,
      start_ts: weekAgo,
      end_ts: now,
      offset: 0,
      limit: 50,
    });

    const results = [];
    for (const base of BASES) {
      for (const ep of CANDIDATES) {
        const url = base + '/' + ep;
        let status = null, ok = false, snippet = '';
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + token,
              'Content-Type': 'application/json',
            },
            body,
          });
          status = r.status;
          ok = r.ok;
          const t = await r.text();
          snippet = t.slice(0, 240);
        } catch (e) {
          snippet = 'fetch error: ' + e.message;
        }
        // показуємо лише цікаве: існуючі (200) або "є, але параметри не ті" (400/422), ховаємо 404
        if (status !== 404) {
          results.push({ ep, version: base.endsWith('v2') ? 'v2' : 'v1', status, ok, snippet });
        }
      }
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({
      ok: true,
      hint: 'status 200 = ендпойнт працює. 400/422 = існує, треба інші параметри. Якщо список порожній — жоден з кандидатів не підійшов.',
      found: results,
    }, null, 2));
  } catch (err) {
    res.status(200).send(JSON.stringify({ ok: false, error: err.message }, null, 2));
  }
}
