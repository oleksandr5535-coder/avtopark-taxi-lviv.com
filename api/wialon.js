export default async function handler(req, res) {
  const TOKEN = process.env.WIALON_TOKEN;
  const BASE = "https://hst-api.wialon.eu/wialon/ajax.html";

  if (!TOKEN) {
    return res.status(500).json({ error: "WIALON_TOKEN не налаштовано у Vercel" });
  }

  try {
    // 1) Логін за токеном -> отримуємо sid (ідентифікатор сесії)
    const loginUrl = `${BASE}?svc=token/login&params=${encodeURIComponent(JSON.stringify({ token: TOKEN }))}`;
    const loginResp = await fetch(loginUrl);
    const login = await loginResp.json();
    if (login.error) {
      return res.status(401).json({ step: "login", error: login.error, hint: "Перевір токен і що сервер саме .eu" });
    }
    const sid = login.eid;

    // 2) Список обʼєктів (авто/групи)
    const itemsParams = {
      spec: { itemsType: "avl_unit", propName: "sys_name", propValueMask: "*", sortType: "sys_name" },
      force: 1, flags: 1, from: 0, to: 50,
    };
    const itemsUrl = `${BASE}?svc=core/search_items&params=${encodeURIComponent(JSON.stringify(itemsParams))}&sid=${sid}`;
    const items = await (await fetch(itemsUrl)).json();

    // 3) Список груп обʼєктів
    const grpParams = {
      spec: { itemsType: "avl_unit_group", propName: "sys_name", propValueMask: "*", sortType: "sys_name" },
      force: 1, flags: 1, from: 0, to: 50,
    };
    const groups = await (await fetch(`${BASE}?svc=core/search_items&params=${encodeURIComponent(JSON.stringify(grpParams))}&sid=${sid}`)).json();

    // 4) Список шаблонів звітів (ресурси)
    const resParams = {
      spec: { itemsType: "avl_resource", propName: "sys_name", propValueMask: "*", sortType: "sys_name" },
      force: 1, flags: 0x2002, from: 0, to: 50,
    };
    const resources = await (await fetch(`${BASE}?svc=core/search_items&params=${encodeURIComponent(JSON.stringify(resParams))}&sid=${sid}`)).json();

    const units = (items.items || []).map(u => ({ id: u.id, name: u.nm }));
    const grps = (groups.items || []).map(g => ({ id: g.id, name: g.nm, units: g.u }));
    const reps = (resources.items || []).map(r => ({
      resourceId: r.id, resourceName: r.nm,
      reports: Object.values(r.rep || {}).map(rp => ({ id: rp.id, name: rp.n })),
    }));

    res.status(200).json({ ok: true, units, groups: grps, resources: reps });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
