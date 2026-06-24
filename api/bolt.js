export default async function handler(req, res) {
  const ID = process.env.BOLT_CLIENT_ID, SECRET = process.env.BOLT_CLIENT_SECRET;
  try {
    const tb = new URLSearchParams({ client_id: ID, client_secret: SECRET, grant_type: "client_credentials", scope: "fleet-integration:api" });
    const tr = await (await fetch("https://oidc.bolt.eu/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tb })).json();
    if (!tr.access_token) return res.status(401).json({ step: "token", response: tr });
    const token = tr.access_token;

    const urls = [
      "https://node.bolt.eu/fleet-integration/v1/test",
      "https://node.bolt.eu/fleet/integration/fleetIntegration/v1/test",
      "https://node.bolt.eu/partner/fleetIntegration/v1/test",
      "https://node.bolt.eu/fleetIntegrationGateway/fleetIntegration/v1/test",
      "https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1/test",
      "https://fleet-integration.taxify.eu/fleetIntegration/v1/test",
      "https://node.bolt.eu/fleetIntegration/fleetIntegrationGatewayAuth/fleetIntegration/v1/test",
    ];
    const out = [];
    for (const url of urls) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: "{}" });
        const txt = await r.text();
        out.push({ url, status: r.status, body: txt.slice(0, 120) });
      } catch (e) {
        out.push({ url, error: String(e).slice(0, 60) });
      }
    }
    res.status(200).json({ ok: true, tried: out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
