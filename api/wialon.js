export default async function handler(req, res) {
  const TOKEN = process.env.WIALON_TOKEN;
  const BASE = "https://hst-api.wialon.eu/wialon/ajax.html";
  const RESOURCE_ID = 600586295;   // Holubkov
  const REPORT_ID = 5;             // Груповий звіт
  const GROUP_ID = 600601067;      // Super-Sasha

  if (!TOKEN) return res.status(500).json({ error: "WIALON_TOKEN не налаштовано" });

  const call = async (svc, params, sid) =>
    (await fetch(`${BASE}?svc=${svc}&params=${encodeURIComponent(JSON.stringify(params))}${sid ? "&sid=" + sid : ""}`)).json();

  // дата: ?date=YYYY-MM-DD (за замовчуванням сьогодні, київський час)
  const dStr = (req.query.date || new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Kyiv" }));
  const dayStart = Math.floor(new Date(dStr + "T00:00:00+03:00").getTime() / 1000);
  const dayEnd = dayStart + 86400 - 1;

  try {
    const login = await call("token/login", { token: TOKEN });
    if (login.error) return res.status(401).json({ step: "login", error: login.error });
    const sid = login.eid;

    // виконати звіт по групі за добу
    const execP = {
      reportResourceId: RESOURCE_ID,
      reportTemplateId: REPORT_ID,
      reportObjectId: GROUP_ID,
      reportObjectSecId: 0,
      interval: { from: dayStart, to: dayEnd, flags: 0 },
    };
    const exec = await call("report/exec_report", execP, sid);
    if (exec.error) return res.status(500).json({ step: "exec", error: exec.error });

    const tables = (exec.reportResult && exec.reportResult.tables) || [];
    const out = { date: dStr, sheets: {} };

    // забрати рядки кожної таблиці (Поїздки, Стоянки тощо)
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      const rowsResp = await call("report/get_result_rows", { tableIndex: i, indexFrom: 0, indexTo: t.rows || 0 }, sid);
      out.sheets[t.label || ("table" + i)] = {
        header: t.header || [],
        rows: Array.isArray(rowsResp) ? rowsResp.map(r => (r.c || []).map(c => (c && c.t !== undefined ? c.t : c))) : [],
      };
    }

    await call("report/cleanup_result", {}, sid);
    res.status(200).json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
