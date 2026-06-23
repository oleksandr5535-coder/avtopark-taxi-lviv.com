export default async function handler(req, res) {
  const TOKEN = process.env.WIALON_TOKEN;
  const BASE = "https://hst-api.wialon.eu/wialon/ajax.html";
  const RESOURCE_ID = 600586295, REPORT_ID = 5, GROUP_ID = 600601067;
  if (!TOKEN) return res.status(500).json({ error: "no token" });

  const call = async (svc, params, sid) =>
    (await fetch(`${BASE}?svc=${svc}&params=${encodeURIComponent(JSON.stringify(params))}${sid ? "&sid=" + sid : ""}`)).json();

  const dStr = req.query.date || "2026-06-16";
  const from = Math.floor(new Date(dStr + "T00:00:00+03:00").getTime() / 1000);
  const to = from + 86400 - 1;

  try {
    const login = await call("token/login", { token: TOKEN });
    if (login.error) return res.status(401).json({ step: "login", error: login.error });
    const sid = login.eid;

    const exec = await call("report/exec_report", {
      reportResourceId: RESOURCE_ID, reportTemplateId: REPORT_ID,
      reportObjectId: GROUP_ID, reportObjectSecId: 0,
      interval: { from, to, flags: 0 },
    }, sid);
    if (exec.error) return res.status(500).json({ step: "exec", error: exec.error });

    const tables = (exec.reportResult && exec.reportResult.tables) || [];
    const meta = tables.map((t, i) => ({ i, label: t.label, rows: t.rows, level: t.level, header: t.header }));

    // сирий вивід перших рядків таблиці 0 (Поїздки) — щоб побачити структуру
    let raw0 = null;
    if (tables[0]) raw0 = await call("report/get_result_rows", { tableIndex: 0, indexFrom: 0, indexTo: Math.min(tables[0].rows || 0, 5) }, sid);

    await call("report/cleanup_result", {}, sid);
    res.status(200).json({ ok: true, meta, raw0 });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
