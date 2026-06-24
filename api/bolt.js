export default async function handler(req, res) {
  const ID = process.env.BOLT_CLIENT_ID, SECRET = process.env.BOLT_CLIENT_SECRET;
  try {
    const tb = new URLSearchParams({ client_id: ID, client_secret: SECRET, grant_type: "client_credentials", scope: "fleet-integration:api" });
    const tr = await (await fetch("https://oidc.bolt.eu/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tb })).json();
    if (!tr.access_token) return res.status(401).json({ step: "token", response: tr });
    const token = tr.access_token;

    // пробуємо кілька можливих базових адрес із ендпоінтом /test
    const hosts = [
      "https://node.bolt.eu/fleet-integration",
      "https://fleets.bolt.eu/fleet-integration",
      "https://node.bolt.eu",
      "https://fleet-integration.bolt.eu",
    ];
    const out = [];
    for (const h of hosts) {
      const url = `${h}/fleetIntegration/v1/test`;
      try {
        const r = await fetch(url, { method: "POST", headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" }, body: "{}" });
        const txt = await r.text();
        out.push({ url, status: r.status, body: txt.slice(0, 200) });
      } catch (e) {
        out.push({ url, error: String(e) });
      }
    }
    res.status(200).json({ ok: true, tried: out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
