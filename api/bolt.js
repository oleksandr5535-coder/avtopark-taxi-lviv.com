export default async function handler(req, res) {
  const ID = process.env.BOLT_CLIENT_ID, SECRET = process.env.BOLT_CLIENT_SECRET;
  const BASE = "https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1";
  const COMPANY_ID = 25859; // твій автопарк

  try {
    const tb = new URLSearchParams({ client_id: ID, client_secret: SECRET, grant_type: "client_credentials", scope: "fleet-integration:api" });
    const tr = await (await fetch("https://oidc.bolt.eu/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tb })).json();
    if (!tr.access_token) return res.status(401).json({ step: "token", response: tr });
    const token = tr.access_token;

    // дата ?date=YYYY-MM-DD (за замовчуванням сьогодні, київський час)
    const dStr = req.query.date || new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" });
    const start_ts = Math.floor(new Date(dStr + "T00:00:00+03:00").getTime() / 1000);
    const end_ts = start_ts + 86400 - 1;

    const post = async (path, payload) => {
      const r = await fetch(`${BASE}/${path}`, {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return r.json();
    };

    const orders = await post("getFleetOrders", {
      company_ids: [COMPANY_ID],
      start_ts,
      end_ts,
      limit: 1000,
      offset: 0,
    });

    res.status(200).json({ ok: true, date: dStr, orders });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
