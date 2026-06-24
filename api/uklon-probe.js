// /api/uklon-probe.js — ДІАГНОСТИКА Uklon Fleet API
// Підбирає формат авторизації, тоді смикає ключові методи й показує структуру.
// Змінні оточення: UKLON_CLIENT_ID, UKLON_CLIENT_SECRET, UKLON_FLEET_ID (або ?fleetId=)
// fleetId також можна передати в URL: /api/uklon-probe?fleetId=XXXX

const BASE = 'https://fleets-public-api.uklon.com.ua';

function pickToken(j){
  if(!j||typeof j!=='object')return null;
  return j.access_token||j.accessToken||j.token||j.jwt||j.id_token||
         (j.data&&(j.data.access_token||j.data.token))||null;
}

async function tryAuth(id, secret){
  const attempts = [
    { name:'form/client_credentials', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'client_credentials',client_id:id,client_secret:secret}).toString() },
    { name:'json/client_credentials', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({grant_type:'client_credentials',client_id:id,client_secret:secret}) },
    { name:'json/plain', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({client_id:id,client_secret:secret}) },
    { name:'json/camel', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({clientId:id,clientSecret:secret,grantType:'client_credentials'}) },
  ];
  const log=[];
  for(const a of attempts){
    try{
      const r=await fetch(BASE+'/api/auth',{method:'POST',headers:a.headers,body:a.body});
      const txt=await r.text(); let j=null; try{j=JSON.parse(txt);}catch(e){}
      const tok=pickToken(j);
      log.push({attempt:a.name,status:r.status,gotToken:!!tok,snippet:txt.slice(0,160)});
      if(tok) return {token:tok, used:a.name, tokenResp:j, log};
    }catch(e){ log.push({attempt:a.name,error:e.message}); }
  }
  return {token:null, log};
}

async function getJSON(path, token){
  try{
    const r=await fetch(BASE+path,{headers:{'Authorization':'Bearer '+token,'Accept':'application/json'}});
    const txt=await r.text(); let j=null; try{j=JSON.parse(txt);}catch(e){}
    return {status:r.status, sample: j!==null ? JSON.stringify(j).slice(0,900) : txt.slice(0,400)};
  }catch(e){ return {error:e.message}; }
}

export default async function handler(req, res){
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const out={};
  try{
    const id=process.env.UKLON_CLIENT_ID, secret=process.env.UKLON_CLIENT_SECRET;
    if(!id||!secret) throw new Error('Немає UKLON_CLIENT_ID або UKLON_CLIENT_SECRET');
    const fleetId=(req.query&&req.query.fleetId)||process.env.UKLON_FLEET_ID||null;

    const auth=await tryAuth(id, secret);
    out.auth_log=auth.log;
    out.auth_used=auth.used||null;
    out.fleetId_seen=fleetId;
    if(!auth.token){ out.ok=false; out.error='Жоден формат авторизації не дав токен'; return res.status(200).send(JSON.stringify(out,null,2)); }
    out.tokenResp_keys = auth.tokenResp ? Object.keys(auth.tokenResp) : null;

    if(!fleetId){ out.ok=true; out.note='Авторизація працює, але немає fleetId — додай ?fleetId=XXXX або env UKLON_FLEET_ID'; return res.status(200).send(JSON.stringify(out,null,2)); }

    const today=new Date().toISOString().slice(0,10);
    out.endpoints={};
    out.endpoints.drivers       = await getJSON('/api/fleets/'+fleetId+'/drivers', auth.token);
    out.endpoints.orders        = await getJSON('/api/fleets/orders?fleetId='+fleetId+'&limit=5', auth.token);
    out.endpoints.report_orders = await getJSON('/api/fleets/reports/'+fleetId+'/drivers-orders', auth.token);
    out.endpoints.drivers_wallets = await getJSON('/api/fleets/'+fleetId+'/finance/drivers/wallets', auth.token);

    out.ok=true;
    res.status(200).send(JSON.stringify(out,null,2));
  }catch(err){
    out.ok=false; out.error=err.message;
    res.status(200).send(JSON.stringify(out,null,2));
  }
}
