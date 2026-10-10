// PLUVIA SENSE back end - zero dependencies, Node >= 18.  Run: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=+process.env.PORT||3000, KEY=process.env.NODE_KEY||'demo-key';
const DATA=path.join(__dirname,'data'),MEDIA=path.join(DATA,'media'),DBF=path.join(DATA,'db.json'),PUB=path.join(__dirname,'public');
fs.mkdirSync(MEDIA,{recursive:true});
let db={reports:[]};try{db=JSON.parse(fs.readFileSync(DBF,'utf8'))}catch{}
const persist=()=>fs.writeFile(DBF,JSON.stringify(db),()=>{});
const THRESH={rain:[10,20,40],wl:[15,30,50]}; // ILLUSTRATIVE (mm/h, cm): calibrate with local INM / field data
const ACT={flood:{1:['Raise monitoring frequency on this node','Notify the duty engineer'],
 2:['Alert civil protection','Send a team to inspect drains and the low point','Warn drivers near underpasses through the app'],
 3:['Alert civil protection and mobilise pumps','Close and divert flooded roads','Alert nearby schools and hospitals','Open the emergency coordination cell']},
 accident:['Alert emergency services (ambulance, civil protection)','Send traffic police and divert traffic','Publish an alternative route in the app'],
 drain:['Dispatch the drain-cleaning crew'],power:['Alert the utility and secure the area'],other:['Assign an operator to verify the report']};
const SEED=[['PS-01','Lac 1 (demo)',36.833,10.235],['PS-02','Ariana (demo)',36.8625,10.1956],['PS-03','Ben Arous (demo)',36.7531,10.2189],['PS-04','La Manouba (demo)',36.8081,10.0971],['PS-05','Tunis centre (demo)',36.7992,10.18]];
const sensors={},hist={},clients=new Set(),lastAuto={};
SEED.forEach(([id,name,lat,lon])=>sensors[id]={id,name,lat,lon,rain:0,wl:0,level:0,risk:0,offline:true,pred:{slope:0},actions:[]});
const lvl=(v,t)=>v>=t[2]?3:v>=t[1]?2:v>=t[0]?1:0, sum=a=>a.reduce((x,y)=>x+y,0);
const state=()=>({sensors:Object.values(sensors),reports:db.reports.slice(0,100)});
const emit=(type,data)=>{const m=`data:${JSON.stringify({type,data})}\n\n`;clients.forEach(c=>c.write(m))};
setInterval(()=>clients.forEach(c=>c.write(':\n\n')),25000);
function km(a,b,c,d){const R=6371,t=x=>x*Math.PI/180,h=Math.sin(t(c-a)/2)**2+Math.cos(t(a))*Math.cos(t(c))*Math.sin(t(d-b)/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function nearest(lat,lon){let best=null;for(const s of Object.values(sensors)){if(s.offline)continue;const d=km(lat,lon,s.lat,s.lon);if(!best||d<best.d)best={s,d}}return best}
function predict(id){const h=(hist[id]||[]).slice(-6);if(h.length<3)return{slope:0,in30:null,eta:null};
 const x=h.map(p=>(p.ts-h[0].ts)/60000),y=h.map(p=>p.wl),n=h.length,den=n*sum(x.map(v=>v*v))-sum(x)**2||1;
 const s=(n*sum(x.map((v,i)=>v*y[i]))-sum(x)*sum(y))/den,cur=y[n-1];
 return{slope:+s.toFixed(2),in30:+Math.max(0,cur+s*30).toFixed(1),eta:s>0.05&&cur<THRESH.wl[2]?Math.round((THRESH.wl[2]-cur)/s):null}}
function ingest(b){const id=String(b.id).slice(0,32),p=sensors[id]||{};
 const s=sensors[id]={...p,id,name:b.name||p.name||id,lat:+b.lat||p.lat,lon:+b.lon||p.lon,rain:+b.rain||0,wl:+b.wl||0,battery:b.battery??p.battery,ts:+b.ts||Date.now(),offline:false};
 (hist[id]=hist[id]||[]).push({ts:s.ts,wl:s.wl});if(hist[id].length>30)hist[id].shift();
 s.level=Math.max(lvl(s.rain,THRESH.rain),lvl(s.wl,THRESH.wl));s.pred=predict(id);
 s.risk=Math.min(100,Math.round(1.1*s.rain+s.wl+Math.max(0,s.pred.slope)*4));s.actions=s.level?ACT.flood[s.level]:[];
 if(b.snapshot&&s.level>=2&&Date.now()-(lastAuto[id]||0)>6e5){lastAuto[id]=Date.now();
  addReport({type:'flood',severity:s.level,description:`Automatic alert from ${s.name}: rain ${s.rain} mm/h, water level ${s.wl} cm.`,lat:s.lat,lon:s.lon,media:[{data:b.snapshot}],source:'sensor+camera'},true)}
 emit('sensor',s);return s}
const EXT={'image/jpeg':'jpg','image/png':'png','video/webm':'webm','video/mp4':'mp4','video/quicktime':'mov'};
function addReport(b,internal){const id=crypto.randomBytes(6).toString('hex'),media=[];
 (b.media||[]).slice(0,6).forEach((m,i)=>{const mt=/^data:([\w/+.-]+);base64,(.+)$/.exec(m.data||'');if(!mt)return;
  const ext=EXT[mt[1]]||(internal&&mt[1]==='image/svg+xml'?'svg':null);if(!ext)return; // SVG only from our own camera nodes
  const f=`${id}-${i}.${ext}`;fs.writeFileSync(path.join(MEDIA,f),Buffer.from(mt[2],'base64'));media.push({kind:/webm|mp4|mov/.test(ext)?'video':'image',url:'/media/'+f})});
 const lat=+b.lat,lon=+b.lon,near=nearest(lat,lon),sev=Math.min(3,Math.max(1,+b.severity||1));
 let v=(b.description?25:0)+Math.min(2,media.filter(m=>m.kind==='image').length)*20+(media.some(m=>m.kind==='video')?25:0)+(b.gps?10:0)+(near&&near.d<1.5&&near.s.level>=1?30:0);
 if(internal)v=100;
 const type=['flood','accident','drain','power','other'].includes(b.type)?b.type:'other';
 const r={id,type,severity:sev,description:String(b.description||'').slice(0,1000),lat,lon,gps:!!b.gps,media,source:internal?b.source:'citizen',verification:Math.min(100,v),status:'new',ts:Date.now(),
  actions:type==='flood'?ACT.flood[sev]:ACT[type],nearest:near&&{name:near.s.name,km:+near.d.toFixed(2),level:near.s.level}};
 db.reports.unshift(r);db.reports=db.reports.slice(0,300);persist();emit('report',r);return r}
let wx={t:0,d:null};
async function weather(){if(wx.d&&Date.now()-wx.t<6e5)return wx.d;
 try{const j=await(await fetch('https://api.open-meteo.com/v1/forecast?latitude=36.81&longitude=10.18&current=precipitation&hourly=precipitation&forecast_days=1&timezone=Africa%2FTunis')).json();
  const h=+j.current.time.slice(11,13);wx={t:Date.now(),d:{source:'Open-Meteo',now:j.current.precipitation,next6h:j.hourly.precipitation.slice(h,h+6)}}}catch{return{error:'weather unavailable'}}return wx.d}
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.webm':'video/webm','.mp4':'video/mp4','.mov':'video/quicktime'};
const send=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
const body=req=>new Promise((ok,no)=>{const ch=[];let n=0;req.on('data',c=>{n+=c.length;if(n>25e6){no(new Error('payload too large'));req.destroy()}else ch.push(c)});
 req.on('end',()=>{try{ok(JSON.parse(Buffer.concat(ch).toString()||'{}'))}catch(e){no(e)}})});
http.createServer(async(req,res)=>{try{const p=new URL(req.url,'http://x').pathname;
 if(p==='/api/stream'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});
  res.write(`data:${JSON.stringify({type:'state',data:state()})}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return}
 if(p==='/api/state')return send(res,200,state());
 if(p==='/api/weather')return send(res,200,await weather());
 if(p==='/api/readings'&&req.method==='POST'){if(req.headers['x-node-key']!==KEY)return send(res,401,{error:'bad node key'});
  const b=await body(req);if(!b.id)return send(res,400,{error:'id required'});return send(res,200,{level:ingest(b).level})}
 if(p==='/api/reports'&&req.method==='POST'){const b=await body(req);if(!isFinite(+b.lat)||!isFinite(+b.lon))return send(res,400,{error:'lat/lon required'});return send(res,201,addReport(b,false))}
 const m=/^\/api\/reports\/(\w+)$/.exec(p);
 if(m&&req.method==='PATCH'){const b=await body(req),r=db.reports.find(x=>x.id===m[1]);if(!r)return send(res,404,{});
  if(['new','acknowledged','dispatched','resolved'].includes(b.status))r.status=b.status;persist();emit('report',r);return send(res,200,r)}
 if(p.startsWith('/media/')){const f=path.join(MEDIA,path.basename(p));if(!fs.existsSync(f))return send(res,404,{});
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream','Content-Security-Policy':"default-src 'none'; sandbox"});return fs.createReadStream(f).pipe(res)}
 const f=path.join(PUB,p==='/'?'index.html':path.normalize(p));
 if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory())return send(res,404,{error:'not found'});
 res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'});fs.createReadStream(f).pipe(res)
}catch(e){send(res,400,{error:e.message})}}).listen(PORT,()=>console.log(`PLUVIA SENSE running on http://localhost:${PORT}`));
