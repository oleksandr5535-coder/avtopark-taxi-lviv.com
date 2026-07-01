// /api/rate.js — актуальний курс USD. Основне джерело: goverla.ua (GraphQL),
// запасні: Приватбанк -> НБУ. Повертає {ok, usd_buy, usd_sale, src, ts}.
export const maxDuration = 20;

async function fetchT(url, opts, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 8000);
  try { return await fetch(url, Object.assign({}, opts, { signal: ac.signal })); }
  finally { clearTimeout(t); }
}

// у goverla absolute — ціле, де останні 2 цифри = копійки (напр. "4150" -> 41.50)
function govFmt(a) {
  a = String(a);
  if (a.indexOf('.') >= 0) return parseFloat(a);
  return parseFloat(a) / 100;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // 1) GOVERLA.UA (GraphQL) — bid = купівля, ask = продаж
  try {
    const body = JSON.stringify({
      operationName: 'Point',
      variables: { alias: 'goverla-ua' },
      query: 'query Point($alias: Alias!) {\n point(alias: $alias) {\n id\n rates {\n id\n currency {\n codeAlpha\n __typename\n }\n bid {\n absolute\n __typename\n }\n ask {\n absolute\n __typename\n }\n __typename\n }\n __typename\n }\n}\n',
    });
    const r = await fetchT('https://api.goverla.ua/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body,
    }, 8000);
    const j = await r.json();
    const rates = j && j.data && j.data.point && j.data.point.rates;
    if (rates) {
      const usd = rates.find(x => x.currency && x.currency.codeAlpha === 'USD');
      if (usd && usd.bid && usd.ask) {
        res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
        return res.status(200).send(JSON.stringify({
          ok: true, usd_buy: govFmt(usd.bid.absolute), usd_sale: govFmt(usd.ask.absolute),
          src: 'goverla', ts: Date.now(),
        }));
      }
    }
  } catch (e) { /* запасне джерело */ }

  // 2) Приватбанк (готівковий)
  try {
    const r = await fetchT('https://api.privatbank.ua/p24api/pubinfo?json&exchange&coursid=5', {}, 8000);
    const arr = await r.json();
    const usd = (arr || []).find(x => x.ccy === 'USD');
    if (usd && usd.buy) {
      res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
      return res.status(200).send(JSON.stringify({
        ok: true, usd_buy: parseFloat(usd.buy), usd_sale: parseFloat(usd.sale),
        src: 'privatbank', ts: Date.now(),
      }));
    }
  } catch (e) { /* далі НБУ */ }

  // 3) НБУ (офіційний)
  try {
    const r = await fetchT('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json', {}, 8000);
    const arr = await r.json();
    const usd = (arr || [])[0];
    if (usd && usd.rate) {
      return res.status(200).send(JSON.stringify({ ok: true, usd_buy: usd.rate, usd_sale: usd.rate, src: 'nbu', ts: Date.now() }));
    }
  } catch (e) { /* нижче помилка */ }

  return res.status(200).send(JSON.stringify({ ok: false, error: 'Курс недоступний' }));
}
