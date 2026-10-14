// Спільна перевірка входу для всіх /api функцій.
// Пропускає лише увійшовшого співробітника (менеджер/власник) — через ту саму базу Supabase.
// Вимикач: поки змінна REQUIRE_AUTH у Vercel не дорівнює "1", функції працюють як раніше
// (лише пишуть у лог "AUTH: would block"), щоб нічого не зламати під час впровадження.
const SUPABASE_URL = 'https://lriixtvefevxindyiuck.supabase.co';
const SUPABASE_KEY = 'sb_publishable_NydeHBpAcKE5M6y8G8hwSg_qkEn7XwC'; // публічний ключ, його можна тримати в коді

export async function requireStaff(req, res) {
  const enforce = process.env.REQUIRE_AUTH === '1';
  let ok = false, why = 'no token';
  try {
    const h = String(req.headers['authorization'] || '');
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (token) {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/is_staff', {
        method: 'POST', signal: ctl.signal,
        headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: '{}'
      });
      clearTimeout(t);
      if (r.ok) { ok = (await r.json()) === true; why = ok ? '' : 'not staff'; } else why = 'supabase ' + r.status;
    }
  } catch (e) { why = 'error ' + (e && e.message); }
  if (ok) return true;
  if (!enforce) { console.warn('AUTH: would block (' + why + ') ' + req.url); return true; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(401).send(JSON.stringify({ ok: false, error: 'Потрібен вхід у дашборд' }));
  return false;
}
