// /api/bolt-probe.js  (РАУНД 2 — ширший перебір + контрольні робочі ендпойнти)
// Логіниться в Bolt Fleet API і перебирає ймовірні "грошові" ендпойнти.
// Контрольні (відомо робочі) додані, щоб переконатись, що пробник коректний.
// Змінні оточення: BOLT_CLIENT_ID, BOLT_CLIENT_SECRET (ті самі, що в /api/bolt).

const COMPANY_ID = 25859;

const BASES = [
  'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1',
  'https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v2',
];

// КОНТРОЛЬНІ — мають віддати 200 (доказ, що пробник правильний)
const CONTROL = ['getFleetOrders', 'getDrivers', 'getVehicles'];

// КАНДИДАТИ на заробітки/виплати/бонуси/рахунки
const CANDIDATES = [
  'getFleetOrdersEarnings', 'getOrderEarnings', 'getOrdersEarnings',
  'getDriverEarnings', 'getDriverEarningsReport', 'getCompanyEarnings',
  'getFleetEarnings', 'getEarnings', 'getEarningsReport',
  'getFleetEarningStatement', 'getEarningStatement',
  'getDriverEngagementData', 'getFleetEngagementData',
  'getInvoices', 'getFleetInvoices', 'getDriverInvoices', 'getCompanyInvoices',
  'getPayouts', 'getFleetPayouts', 'getDriverPayouts',
  'getStatements', 'getFleetStatements',
  'getBalance', 'getFleetBalance', 'getCompanyBalance',
  'getRevenue', 'getFleetRevenue',
  'getReports', 'getFleetReports', 'getDriverReports',
  'getActivityReport', 'getDriverActivity', 'getFleetActivity',
  'getCampaignEarnings', 'getBonuses', 'getDriverBonuses',
  'getCompensations', 'getFleetCompensations',
  'getWeeklyReport', 'getDriverWeeklyReport',
];

async function getToken() {
  const id = process.env.BOLT_CLIENT_ID;
  const secret = process.env.BOLT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Немає BOLT_CLIENT_ID або BOLT_CLIENT_SECRET');
  const body = new URLSearchParams({
    client_id: id, client_secret: secret,
    grant_type: 'client_credentials', scope: 'fleet-integration:api',
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

async function probe(url, token, body) {
  let status = null, snippet = '';
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body,
    });
    status = r.status;
    snippet = (await r.text()).slice(0, 200);
  } catch (e) { snippet = 'fetch error: ' + e.message; }
  return { status, snippet };
}

export default async function handler(req, res) {
  try {
    const token = await getToken();
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - 7 * 24 * 3600;
    const body = JSON.stringify({
      company_ids: [COMPANY_ID], company_id: COMPANY_ID,
      start_ts: weekAgo, end_ts: now, offset: 0, limit: 50,
    });

    const control = [];
    const found = [];

    for (const base of BASES) {
      const ver = base.endsWith('v2') ? 'v2' : 'v1';
      for (const ep of CONTROL) {
        const { status, snippet } = await probe(base + '/' + ep, token, body);
        if (status !== 404) control.push({ ep, ver, status, snippet: snippet.slice(0, 80) });
      }
      for (const ep of CANDIDATES) {
        const { status, snippet } = await probe(base + '/' + ep, token, body);
        if (status !== 404) found.push({ ep, ver, status, snippet });
      }
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify({
      ok: true,
      hint: 'control = відомо робочі (мають бути 200). found = знайдені грошові ендпойнти (200 = є!).',
      control,
      found,
    }, null, 2));
  } catch (err) {
    res.status(200).send(JSON.stringify({ ok: false, error: err.message }, null, 2));
  }
}
