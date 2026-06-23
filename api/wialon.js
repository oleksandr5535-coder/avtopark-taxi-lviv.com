export default async function handler(req, res) {
  const TOKEN = process.env.WIALON_TOKEN;
  const BASE = "https://hst-api.wialon.eu/wialon/ajax.html";
  if (!TOKEN) return res.status(500).json({ error: "WIALON_TOKEN не налаштовано" });

  const call = async (svc, params, sid) =>
    (await fetch(`${BASE}?svc=${svc}&params=${encodeURIComponent(JSON.stringify(params))}${sid ? "&sid=" + sid : ""}`)).json();

  try {
    const login = await call("token/login", { token: TOKEN });
    if (login.error) return res.status(401).json({ step: "login", error: login.error });
    const sid = login.eid;

    const resP = { spec: { itemsType: "avl_resource", propName: "sys_name", propValueMask: "*", sortType: "sys_name" }, force: 1, flags: 8193, from: 0, to: 100 };
    const resources = await call("core/search_items", resP, sid);

    res.status(200).json({
      ok: true,
      resources: (resources.items || []).map(r => ({
        resourceId: r.id,
        resourceName: r.nm,
        reports: Object.values(r.rep || {}).map(rp => ({ id: rp.id, name: rp.n })),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
