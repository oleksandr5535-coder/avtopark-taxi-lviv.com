// /api/uklon-probe.js (раунд 3) — orders + report-by-orders з правильними датами
// Змінні: UKLON_CLIENT_ID, UKLON_CLIENT_SECRET, UKLON_FLEET_ID (вже встановлено)

const BASE = 'https://fleets-public-api.uklon.com.ua';

async function auth(id, secret){
  const r=await fetch(BASE+'/api/auth',{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'client_credentials',client_id:id,client_secret:secret}).toString()});
  const j=await r.json(); return j.access_token||null;
}
async function getJSON(path, token){
  try{
    const r=await fetch(BASE+path,{headers:{'Authorization':'Bearer '+token,'Accept':'application/json'}});
    const txt=await r.text(); let j=null; try{j=JSON.parse(txt);}catch(e){}
    return {status:r.status, sample: j!==null ? JSON.stringify(j).slice(0,1400) : txt.slice(0,500)};
  }catch(e){ return {error:e.message}; }
}

export default async function handler(req, res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const out={};
  try{
    const id=process.env.UKLON_CLIENT_ID, secret=process.env.UKLON_CLIENT_SECRET;
    const fleetId=(req.query&&req.query.fleetId)||process.env.UKLON_FLEET_ID;
    if(!id||!secret) throw new Error('Немає UKLON_CLIENT_ID / UKLON_CLIENT_SECRET');
    if(!fleetId) throw new Error('Немає UKLON_FLEET_ID');
    const token=await auth(id, secret);
    if(!token) throw new Error('Токен не отримано');
    out.fleetId=fleetId;

    // 15 червня 2026, київська доба (EEST = +03:00), unix-сек
    const from=Math.floor(Date.parse('2026-06-15T00:00:00+03:00')/1000);
    const to=Math.floor(Date.parse('2026-06-16T00:00:00+03:00')/1000);
    out.range={from,to};

    out.endpoints={};
    // ПОЇЗДКИ (per-trip)
    out.endpoints.orders = await getJSON('/api/fleets/orders?fleet_id='+fleetId+'&from='+from+'&to='+to+'&limit=10', token);
    // ЗВІТ ПО ВОДІЯХ (per-driver) — пробуємо варіанти назв дат
    out.endpoints.report_from_to   = await getJSON('/api/fleets/reports/'+fleetId+'/drivers-orders?from='+from+'&to='+to, token);
    out.endpoints.report_date_from = await getJSON('/api/fleets/reports/'+fleetId+'/drivers-orders?date_from='+from+'&date_to='+to, token);
    out.endpoints.report_camel     = await getJSON('/api/fleets/reports/'+fleetId+'/drivers-orders?dateFrom='+from+'&dateTo='+to, token);

    out.ok=true;
    res.status(200).send(JSON.stringify(out,null,2));
  }catch(err){
    out.ok=false; out.error=err.message;
    res.status(200).send(JSON.stringify(out,null,2));
  }
}
