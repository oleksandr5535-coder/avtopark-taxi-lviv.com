export default async function handler(req, res) {
  const ID = process.env.BOLT_CLIENT_ID;
  const SECRET = process.env.BOLT_CLIENT_SECRET;

  if (!ID || !SECRET) {
    return res.status(500).json({ error: "Немає BOLT_CLIENT_ID або BOLT_CLIENT_SECRET у Vercel" });
  }

  try {
    const body = new URLSearchParams({
      client_id: ID,
      client_secret: SECRET,
      grant_type: "client_credentials",
      scope: "fleet-integration:api",
    });

    const r = await fetch("https://oidc.bolt.eu/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    });

    const data = await r.json();

    if (!data.access_token) {
      return res.status(401).json({ ok: false, step: "token", response: data });
    }

    res.status(200).json({ ok: true, gotToken: true, expires_in: data.expires_in, scope: data.scope });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
