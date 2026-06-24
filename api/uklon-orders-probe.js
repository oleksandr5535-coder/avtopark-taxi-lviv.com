// /api/uklon-orders-probe.js — розкручуємо ендпойнт ОКРЕМИХ поїздок Uklon
// Перебирає варіанти параметрів для /api/fleets/orders і показує, який дає 200 + структуру.
// Змінні: UKLON_CLIENT_ID, UKLON_CLIENT_SECRET, UKLON_FLEET_ID

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
    return {status:r.status, sample: j!==null ? JSON.stringify(j).slice(0,1400) : txt.slice(0,400)};
  }catch(e){ return {error:e.message}; }
}

export default async function handler(req, res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const out={};
  try{
    const id=process.env.UKLON_CLIENT_ID, secret=process.env.UKLON_CLIENT_SECRET, fleetId=process.env.UKLON_FLEET_ID;
    if(!id||!secret||!fleetId) throw new Error('Немає UKLON_CLIENT_ID / SECRET / FLEET_ID');
    const token=await auth(id, secret);
    if(!token) throw new Error('Токен не отримано');

    // 15 червня 2026, київська доба, unix-сек
    const from=Math.floor(Date.parse('2026-06-15T00:00:00+03:00')/1000);
    const to=Math.floor(Date.parse('2026-06-16T00:00:00+03:00')/1000);
    out.range={from,to};

    // перебір варіантів назв параметрів
    const variants = {
      'fleet_id+from+to':        '/api/fleets/orders?fleet_id='+fleetId+'&from='+from+'&to='+to+'&limit=5',
      'fleetId+from+to':         '/api/fleets/orders?fleetId='+fleetId+'&from='+from+'&to='+to+'&limit=5',
      'fleet_id+dateFrom':       '/api/fleets/orders?fleet_id='+fleetId+'&dateFrom='+from+'&dateTo='+to+'&limit=5',
      'fleetId+dateFrom':        '/api/fleets/orders?fleetId='+fleetId+'&dateFrom='+from+'&dateTo='+to+'&limit=5',
      'fleet_id+from_to+offset': '/api/fleets/orders?fleet_id='+fleetId+'&from='+from+'&to='+to+'&offset=0&limit=5',
      'path_fleet':              '/api/fleets/'+fleetId+'/orders?from='+from+'&to='+to+'&limit=5',
    };
    out.tries={};
    for(const k of Object.keys(variants)){
      out.tries[k]=await getJSON(variants[k], token);
    }
    out.ok=true;
    res.status(200).send(JSON.stringify(out,null,2));
  }catch(err){
    out.ok=false; out.error=err.message;
    res.status(200).send(JSON.stringify(out,null,2));
  }
}
