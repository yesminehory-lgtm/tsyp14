"use strict";
// PluviaSense — zero-dependency Node backend (Node >= 18)
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = +process.env.PORT || 3000, DATA = process.env.DATA_DIR || path.join(__dirname, "data"), PUB = path.join(__dirname, "public");
const OPS = process.env.OPS_TOKEN || crypto.randomBytes(6).toString("hex");   // decision-makers' access code
const DEV = process.env.DEVICE_KEY || crypto.randomBytes(8).toString("hex");  // sensors' API key
const RISK = ["Normal", "Watch", "Warning", "Critical"], TYPES = ["Flooding", "Blocked drain", "Road cut off", "Accident", "Other"];
const STAT = ["New", "Verified", "Acknowledged", "Dispatched", "Resolved"], BOX = { lat: [36.5, 37.15], lon: [9.8, 10.75] };
fs.mkdirSync(path.join(DATA, "media"), { recursive: true });
const DBF = path.join(DATA, "db.json"); let db = { reports: [], alerts: [], subs: [], outbox: [], sent: {}, eps: [] };
try { db = JSON.parse(fs.readFileSync(DBF, "utf8")); } catch (e) {}
for (const k of ["subs", "outbox", "eps"]) db[k] = db[k] || []; db.sent = db.sent || {};
let tm; const save = () => { clearTimeout(tm); tm = setTimeout(() => fs.writeFile(DBF, JSON.stringify(db), () => {}), 400); };
const media = n => path.join(DATA, "media", n);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v)), esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const dist = (a, b) => { const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos((a.lat + b.lat) * r / 2), y = (b.lat - a.lat) * r; return Math.hypot(x, y) * 6371e3; };
const eq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
// Monitoring points: proposed placement in flood-prone areas of Greater Tunis (id must match the device's configured node id)
const NODES = [["Lac 2 outfall", 36.835, 10.27, 90], ["Ennasr / Ariana", 36.865, 10.16, 100], ["Manouba centre", 36.81, 10.095, 110], ["Sijoumi basin", 36.79, 10.136, 120],
  ["Ettadhamen", 36.835, 10.1, 100], ["Ben Arous", 36.753, 10.23, 110], ["Mégrine", 36.77, 10.233, 90], ["Oued Méliane", 36.72, 10.29, 130]]
  .map(([name, lat, lon, thr], i) => ({ id: "N" + (i + 1), name, lat, lon, thr, L: 14 + i, real: 0, f3: 0, boost: 0, rain: 0, devRain: 0, rate: 0, eta: Infinity, risk: 0, sim: true, lastReal: 0, frame: false, hourly: [], la: {}, stormy: i > 0 && i < 5 }));
let storm = false, wxOK = null, wxT = 0, fakeFc = null, EPS = [];
// ---- Decision support
const acts = (k, n) => k >= 3 ? [`Dispatch Protection Civile pumping and rescue units to ${n.name}`, "Close the nearest road or underpass and divert traffic", "Send an SMS / push alert to residents within 500 m", "Activate pumping stations and open retention basins", "Alert ONAS and the municipal crisis cell"]
  : k == 2 ? ["Pre-position pump trucks within 15 minutes", "Clear grates and culverts upstream", "Brief municipal crews and traffic police", "Raise sensor sampling to 1-minute readings"]
  : ["Keep monitoring and review the 3-hour forecast", "Inspect drains before the rain peak"];
const near = p => NODES.reduce((a, n) => dist(n, p) < dist(a, p) ? n : a);
function cred(r) {
  let s = 10; const w = ["Report received"], n = near(r), d = dist(n, r);
  if (r.np || r.vext || r.video) { s += 25; w.push("Live photo or video evidence +25"); } else w.push("No live photo or video attached");
  if (r.vext || r.video) { s += 10; w.push("Video +10"); }
  if (r.src === "gps" && r.acc < 50) { s += 20; w.push("GPS fix under 50 m +20"); } else if (r.src === "gps") { s += 10; w.push("GPS fix +10"); } else { s += 5; w.push("Pin placed by hand +5"); }
  if (d < 2500 && r.type !== "Accident") { if (n.risk >= 2) { s += 25; w.push(`${n.name} sensor at ${RISK[n.risk]} +25`); } else if (n.risk == 1) { s += 10; w.push(`${n.name} sensor at Watch +10`); } }
  const o = db.reports.filter(x => x.id !== r.id && Date.now() - x.t < 36e5 && dist(x, r) < 400).length; if (o) { s += 15; w.push(`${o} other report(s) within 400 m +15`); }
  if (n.rain > .1 && d < 5000) { s += 5; w.push("Rain confirmed by weather data +5"); }
  return { s: Math.min(100, s), w };
}
function advise(r) {
  const n = near(r), d = dist(n, r), a = [];
  if (r.type === "Accident") return ["Call SAMU 190 / Police 197 and dispatch the nearest unit", "Divert traffic and warn drivers of standing water on the route"];
  if (d < 2500 && n.risk >= 2) a.push(`Nearest sensor (${n.name}, ${(d / 1000).toFixed(1)} km) is at ${RISK[n.risk]}${isFinite(n.eta) ? `, overflow in about ${Math.round(n.eta)} min` : ""}`);
  return a.concat(acts(Math.max(n.risk, r.sev >= 3 ? 3 : r.sev == 2 ? 2 : 1), n));
}
const svgFrame = n => { const h = Math.round(Math.min(1, n.L / n.thr) * 120), t = (y, s) => `<text x="8" y="${y}" fill="#fff" font-size="12" font-family="sans-serif">${esc(s)}</text>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#2b3a42"/><rect y="${180 - h}" width="320" height="${h}" fill="#3A86B8" opacity=".85"/>${t(16, `CAM ${n.id} · ${n.name}`)}${t(32, `level ${Math.round(n.L)} cm · rain ${Math.round(n.rain)} mm/h`)}${t(172, n.sim ? "simulated frame" : "sensor frame")}</svg>`); };
const EVENT_TEXT = { water_rising: "Camera detected rising water", suspicious: "Camera detected something suspicious near the water", blocked_drain: "Camera detected a blocked drain or debris" };
function forecastSvg(n) {
  const H = nodeHourly(n).filter(x => x.t > Date.now()).slice(0, 12), pk = Math.max(0, ...H.map(x => x.mm)), mx = Math.max(8, pk);
  const bars = H.map((x, i) => `<rect x="${12 + i * 25}" y="${150 - x.mm / mx * 110}" width="20" height="${x.mm / mx * 110}" fill="${x.mm >= HEAVY ? "#D93036" : "#3A86B8"}"/>`).join("");
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#EEF4F8"/>${bars}<text x="8" y="16" fill="#0B3669" font-size="12" font-family="sans-serif">Forecast rain, next 12 h · ${esc(n.name)}</text><text x="8" y="172" fill="#587087" font-size="11" font-family="sans-serif">peak ${pk.toFixed(1)} mm/h</text></svg>`);
}
function raise(n, k, trigger = "sensor", reason = "Water level above the alert threshold", frameFile) {
  const id = "A" + Date.now().toString(36) + crypto.randomBytes(2).toString("hex"); let img = svgFrame(n);
  if (trigger === "forecast") img = forecastSvg(n);
  else if (frameFile || (n.frame && !n.sim)) { try { fs.copyFileSync(media(frameFile || `node-${n.id}.jpg`), media(`alert-${id}.jpg`)); img = `/api/media/alert-${id}.jpg`; } catch (e) {} }
  const a = { id, kind: "alert", node: n.id, lat: n.lat, lon: n.lon, risk: k, t: Date.now(), status: "New", img, acts: acts(k, n), trigger, reason };
  db.alerts.unshift(a); db.alerts.length = Math.min(db.alerts.length, 200); save();
  push("alert", { id, node: n.id, risk: k, trigger, reason }); push("alertfull", a, true); return a;
}
// Suspicious behaviour at a monitoring point (independent of the overflow threshold)
function suspicious(n, now) {
  const can = k => !n.la[k] || now - n.la[k] > 6e5;
  if (n.rate >= (n.sim ? .9 : 2) && n.L / n.thr >= .2 && can("rapid")) { n.la.rapid = now; raise(n, Math.max(2, n.risk), "rapid", `Water level rising fast (${n.rate.toFixed(1)} cm per minute)`); }
  else if (n.rate >= (n.sim ? .5 : 1) && n.rain < 1 && n.L > 25 && can("norain")) { n.la.norain = now; raise(n, 2, "norain", "Water rising without rainfall: check for a blocked drain, a burst pipe or an upstream release"); }
}
// ---- Risk engine (runs every 2 s). Nodes with a recent device reading use it; others are simulated, driven by live rainfall.
function tick() {
  const now = Date.now();
  NODES.forEach(n => {
    n.sim = now - n.lastReal > 120000;
    if (n.sim) {
      n.boost = storm && n.stormy ? Math.min(50, n.boost + 4) : Math.max(0, n.boost - 5);
      n.rain = n.real + n.boost; const pL = n.L;
      n.L = clamp(n.L + n.rain * .035 - .2 - n.L * .004 + (Math.random() - .5) * .1, 8, n.thr * 1.5); n.rate = n.L - pL;
    } else n.rain = n.devRain;
    const r = n.L / n.thr; n.eta = n.rate > .05 ? (n.thr - n.L) / n.rate : Infinity;
    let k = 0; if (r >= .4 || n.rain >= 5 || n.f3 >= 10) k = 1; if (r >= .65 || n.rain >= 15) k = 2; if (r >= .9 || (n.eta < 20 && n.rain >= 20)) k = 3;
    if (k > n.risk && k >= 2) raise(n, k, "sensor", `Water level at ${Math.round(r * 100)}% of the overflow threshold`);
    n.risk = k; suspicious(n, now);
  });
  broadcast();
}
// ---- Weather, forecast and warnings (schools, parents, authorities)
const HEAVY = +process.env.HEAVY_MM_H || 8, MOD = 3;
const TW = { sid: process.env.TWILIO_SID, token: process.env.TWILIO_TOKEN, from: process.env.TWILIO_FROM }, WEBHOOK = process.env.WEBHOOK_URL;
const tf = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tunis", hour: "2-digit", minute: "2-digit", hour12: false }), hhmm = ms => tf.format(ms);
const fmtDur = ms => { const m = Math.round(ms / 6e4), h = Math.floor(m / 60); return `${h} h${m % 60 ? " " + (m % 60) + " min" : ""}`; };
function nodeHourly(n) {
  if (!fakeFc) return n.hourly;
  const base = n.hourly.length ? n.hourly : Array.from({ length: 36 }, (_, i) => ({ t: Math.ceil(Date.now() / 36e5) * 36e5 + i * 36e5, mm: 0 }));
  return base.map(h => { const ov = Math.min(h.t, fakeFc.start + fakeFc.len) - Math.max(h.t - 36e5, fakeFc.start); return ov >= 18e5 ? { t: h.t, mm: Math.max(h.mm, fakeFc.peak) } : h; });
}
async function loadWx() {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${NODES.map(n => n.lat).join()}&longitude=${NODES.map(n => n.lon).join()}&current=precipitation&hourly=precipitation&forecast_hours=36&timezone=GMT`;
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(r.status); const j = await r.json();
    (Array.isArray(j) ? j : [j]).forEach((x, i) => { const n = NODES[i]; n.real = x.current.precipitation || 0; n.hourly = x.hourly.time.map((t, k) => ({ t: Date.parse(t + "Z"), mm: x.hourly.precipitation[k] || 0 })); });
    wxOK = true; wxT = Date.now();
  } catch (e) { wxOK = false; }
  NODES.forEach(n => { const now = Date.now(); n.f3 = nodeHourly(n).filter(h => h.t > now && h.t <= now + 3 * 36e5).reduce((a, h) => a + h.mm, 0); });
  episodes();
}
// Intense-rain windows in the next hours. Open-Meteo hourly rain at time T covers the hour BEFORE T.
function windows(n) {
  const H = nodeHourly(n), out = []; let i = 0;
  while (i < H.length) {
    if (H[i].mm >= MOD) { let j = i, peak = 0, sum = 0; while (j < H.length && H[j].mm >= MOD) { peak = Math.max(peak, H[j].mm); sum += H[j].mm; j++; }
      if (peak >= HEAVY || sum >= 25) out.push({ start: H[i].t - 36e5, end: H[j - 1].t, peak: +peak.toFixed(1), sum: +sum.toFixed(1) }); i = j; } else i++;
  }
  return out;
}
const MSG = {
  en: { hd: { early: "Heads-up", soon: "WARNING: in about 1 hour", clear: "ALL CLEAR", wait: "Roads still closed" },
    body: a => `Intense rainfall expected from ${a.from} to ${a.to} (up to ${a.peak} mm/h) near ${a.area}. Roads may be cut off until about ${a.reopen} (about ${a.dur}). Do not risk the roads.`,
    clr: a => `The intense rainfall near ${a.area} has ended and roads are reopening.`,
    adv: { school: "Keep pupils inside the school until the all-clear message. Do not let children leave during the event.", parent: "Do not travel to pick up your child during the event. Your child stays safe at school until the all-clear.", authority: "Pre-position pumps and crews, prepare road closures and inform schools and residents." },
    advC: { school: "You may organise pupils' return, following local instructions.", parent: "Roads are reopening. Follow your school's instructions to collect your child.", authority: "Check road status and stand down teams after inspection." },
    pub: "Stay safe and do not risk the roads. Pupils stay at school until the all-clear." },
  fr: { hd: { early: "Information préalable", soon: "ALERTE : dans environ 1 heure", clear: "FIN D'ALERTE", wait: "Routes encore coupées" },
    body: a => `Fortes pluies attendues de ${a.from} à ${a.to} (jusqu'à ${a.peak} mm/h) près de ${a.area}. Les routes peuvent être coupées jusqu'à environ ${a.reopen} (environ ${a.dur}). Ne prenez pas de risque sur la route.`,
    clr: a => `Les fortes pluies près de ${a.area} sont terminées, les routes rouvrent progressivement.`,
    adv: { school: "Gardez les élèves à l'école jusqu'au message de fin d'alerte. Ne laissez pas partir les enfants pendant l'épisode.", parent: "Ne vous déplacez pas pour récupérer votre enfant pendant l'épisode. Il reste en sécurité à l'école jusqu'à la fin d'alerte.", authority: "Pré-positionnez pompes et équipes, préparez les fermetures de routes et informez écoles et habitants." },
    advC: { school: "Vous pouvez organiser le retour des élèves selon les consignes locales.", parent: "Les routes rouvrent. Suivez les consignes de l'école pour récupérer votre enfant.", authority: "Vérifiez l'état des routes et levez le dispositif après inspection." },
    pub: "Restez en sécurité et ne prenez pas de risque sur la route. Les élèves restent à l'école jusqu'à la fin d'alerte." },
  ar: { hd: { early: "تنبيه مسبق", soon: "تحذير: بعد حوالي ساعة", clear: "انتهى الخطر", wait: "الطرق ما زالت مقطوعة" },
    body: a => `أمطار غزيرة متوقعة من ${a.from} إلى ${a.to} (حتى ${a.peak} مم/س) قرب ${a.area}. قد تُقطع الطرق إلى حدود ${a.reopen} (حوالي ${a.dur}). لا تخاطروا بالطرقات.`,
    clr: a => `توقفت الأمطار الغزيرة قرب ${a.area} وبدأت الطرق تُفتح.`,
    adv: { school: "أبقوا التلاميذ داخل المدرسة إلى حين رسالة انتهاء الخطر ولا تسمحوا بالمغادرة أثناء الحدث.", parent: "لا تتنقلوا لاصطحاب أبنائكم أثناء الحدث. أبناؤكم في أمان داخل المدرسة إلى حين انتهاء الخطر.", authority: "جهّزوا المضخات وفرق التدخل وحضّروا غلق الطرق وأعلموا المدارس والسكان." },
    advC: { school: "يمكنكم تنظيم عودة التلاميذ وفق التعليمات المحلية.", parent: "بدأت الطرق تُفتح. اتبعوا تعليمات المدرسة لاصطحاب أبنائكم.", authority: "راجعوا حالة الطرق وأوقفوا الفرق بعد المعاينة." },
    pub: "حافظوا على سلامتكم ولا تخاطروا بالطرقات. يبقى التلاميذ في المدرسة إلى حين انتهاء الخطر." } };
const vars = e => ({ from: hhmm(e.start), to: hhmm(e.end), peak: e.peak, reopen: hhmm(e.reopen), dur: fmtDur(e.reopen - e.start), area: e.area });
const joinAreas = L => { L = [...new Set(L)]; return L.length > 3 ? L.slice(0, 3).join(", ") + ` +${L.length - 3}` : L.join(", "); };
const mask = s => s.phone ? "•••" + s.phone.slice(-3) : s.email ? s.email.replace(/^(.).*(@.*)$/, "$1***$2") : "in-app only";
async function deliver(s, text, stage, a) {
  const out = [];
  try {
    if (s.phone && TW.sid) { const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TW.sid}/Messages.json`, { method: "POST", headers: { authorization: "Basic " + Buffer.from(TW.sid + ":" + TW.token).toString("base64"), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ To: s.phone, From: TW.from, Body: text }), signal: AbortSignal.timeout(10000) }); out.push(r.ok ? "SMS sent" : "SMS failed " + r.status); }
    if (WEBHOOK) { const r = await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: { phone: s.phone, email: s.email, name: s.name }, role: s.role, lang: s.lang, stage, area: a.area, text }), signal: AbortSignal.timeout(10000) }); out.push(r.ok ? "webhook sent" : "webhook failed " + r.status); }
  } catch (e) { out.push("failed: " + e.message); }
  return out.length ? out.join(", ") : "not sent: no SMS provider configured";
}
async function send(s, stage, a) {
  const M = MSG[s.lang] || MSG.en, text = `PLUVIA SENSE · ${M.hd[stage]}\n${stage === "clear" ? M.clr(a) : M.body(a)}\n${(stage === "clear" ? M.advC : M.adv)[s.role]}`;
  const o = { id: crypto.randomBytes(4).toString("hex"), t: Date.now(), stage, role: s.role, lang: s.lang, area: a.area, to: mask(s), text, status: "queued" };
  db.outbox.unshift(o); db.outbox.length = Math.min(db.outbox.length, 300); save();
  o.status = await deliver(s, text, stage, a); save();
}
function announce(ep, stage) {
  const k = `${ep.key}:${stage}`; if (db.sent[k]) return; db.sent[k] = Date.now();
  if (!db.eps.find(e => e.key === ep.key)) db.eps.unshift({ ...ep, cleared: false });
  const hk = Math.round(ep.start / 36e5), n = NODES.find(x => x.id === ep.node), a = vars(ep), gk = `G:${hk}:${stage}${fakeFc ? ":" + fakeFc.id : ""}`, first = !db.sent[gk];
  if (stage !== "clear") a.areas = joinAreas(EPS.filter(e => Math.round(e.start / 36e5) === hk).map(e => e.area));
  if (first) db.sent[gk] = Date.now();
  if (stage !== "clear" && first) { raise(n, ep.peak >= 20 ? 3 : 2, "forecast", `${stage === "soon" ? "Within 1 hour" : "Forecast"}: intense rainfall ${a.from} to ${a.to} (up to ${a.peak} mm/h). Roads may be cut off until about ${a.reopen}.`); }
  db.subs.filter(s => s.node === ep.node || (s.node === "all" && stage !== "clear" && first)).forEach(s => send(s, stage, s.node === "all" ? { ...a, area: a.areas } : a)); save();
}
function episodes() {
  const now = Date.now(); EPS = [];
  NODES.forEach(n => windows(n).forEach(w => {
    if (w.end <= now || w.start - now > 24 * 36e5) return;
    const lag = clamp(Math.round(w.peak / 6), 1, 3) * 36e5, ep = { ...w, node: n.id, area: n.name, reopen: w.end + lag, key: `${n.id}:${Math.round(w.start / 36e5)}${fakeFc ? ":" + fakeFc.id : ""}`, fake: !!fakeFc };
    EPS.push(ep);
  }));
  EPS.forEach(e => announce(e, e.start - now > 36e5 ? "early" : "soon"));
  db.eps.forEach(e => { const n = NODES.find(x => x.id === e.node); if (!e.cleared && now >= e.reopen && n && n.risk < 2) { e.cleared = true; announce(e, "clear"); } });   // all-clear only when roads are due to reopen AND sensors are calm
  for (const k in db.sent) if (now - db.sent[k] > 3 * 864e5) delete db.sent[k];
  db.eps = db.eps.filter(e => now - e.reopen < 864e5).slice(0, 50);
}
function forecastView() { const now = Date.now(), m = new Map(); NODES.forEach(n => nodeHourly(n).forEach(h => { if (h.t > now) m.set(h.t, Math.max(m.get(h.t) || 0, h.mm)); })); return [...m].sort((a, b) => a[0] - b[0]).slice(0, 12).map(([t, mm]) => ({ t, mm: +mm.toFixed(1) })); }
function warnView() {
  const now = Date.now(), L = EPS.map(e => ({ ...e, ph: e.start - now > 36e5 ? "early" : "soon" }));
  db.eps.forEach(e => { if (!e.cleared && now >= e.end && !L.find(x => x.key === e.key)) L.push({ ...e, ph: "wait" }); });
  const g = new Map();   // one public card per time window, listing the affected areas
  L.forEach(e => { const k = e.ph + Math.round(e.start / 36e5); if (!g.has(k)) g.set(k, { e, areas: [] }); g.get(k).areas.push(e.area); });
  return [...g.values()].map(({ e, areas }) => { const a = { ...vars(e), area: joinAreas(areas) }; return { area: a.area, from: a.from, to: a.to, reopen: a.reopen, peak: e.peak, ph: e.ph, tx: Object.fromEntries(Object.keys(MSG).map(l => [l, `${MSG[l].hd[e.ph]}: ${MSG[l].body(a)} ${MSG[l].pub}`])) }; });
}
// ---- Report triage: intensity and a suggested decision
const INT = ["", "Low", "Moderate", "High", "Critical"];
function intensity(r) { const n = near(r), d = dist(n, r), o = db.reports.filter(x => x.id !== r.id && Date.now() - x.t < 36e5 && dist(x, r) < 400).length; let l = r.sev; if ((d < 2500 && n.risk >= 2) || o >= 2) l++; if (n.risk >= 3 && d < 2500 && r.sev >= 2) l = 4; l = clamp(l, 1, 4); return { l, label: INT[l] }; }
function headline(r) { if (r.type === "Accident") return "Dispatch SAMU 190 / Police 197 to the location"; const l = intensity(r).l; return acts(l >= 3 ? 3 : l, near(r))[0]; }
// ---- Views and real-time push (Server-Sent Events)
const full = r => { const c = cred(r); return { id: r.id, t: r.t, lat: r.lat, lon: r.lon, type: r.type, sev: r.sev, status: r.status, src: r.src, acc: r.acc, desc: r.desc, photos: r.np, video: !!(r.video || r.vext), vext: r.vext || null, noMedia: !!r.noMedia, score: c.s, why: c.w, advice: advise(r), intensity: intensity(r), decision: headline(r) }; };
function view(ops) {
  return { t: Date.now(), storm, wx: wxOK, wxT, fake: !!fakeFc, ops, forecast: forecastView(), warnings: warnView(), outbox: ops ? db.outbox.slice(0, 30) : [], subs: ops ? db.subs.length : 0,
    nodes: NODES.map(n => ({ id: n.id, name: n.name, lat: n.lat, lon: n.lon, thr: n.thr, L: +n.L.toFixed(1), rain: +n.rain.toFixed(1), f3: +n.f3.toFixed(1), eta: isFinite(n.eta) ? Math.round(n.eta) : null, risk: n.risk, sim: n.sim })),
    reports: db.reports.slice(0, 100).filter(r => ops || r.status !== "Resolved").map(r => ops ? full(r) : { id: r.id, t: r.t, lat: r.lat, lon: r.lon, type: r.type, sev: r.sev, status: r.status }),
    alerts: ops ? db.alerts.slice(0, 50) : [] };
}
const clients = new Set();
function push(ev, data, opsOnly) { const s = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) if (!opsOnly || c.ops) c.res.write(s); }
function broadcast() { if (!clients.size) return; const p = JSON.stringify(view(false)), o = JSON.stringify(view(true)); for (const c of clients) c.res.write(`event: state\ndata: ${c.ops ? o : p}\n\n`); }
// ---- HTTP
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".jpg": "image/jpeg", ".webm": "video/webm", ".mp4": "video/mp4" };
const hits = new Map(); const limited = (ip, max = 8, k = "r") => { const t = Date.now(), key = k + ip, a = (hits.get(key) || []).filter(x => t - x < 6e4); a.push(t); hits.set(key, a); if (hits.size > 5000) hits.clear(); return a.length > max; };
async function body(req, max) { const c = []; let n = 0; for await (const x of req) { n += x.length; if (n > max) throw Object.assign(new Error("Payload too large"), { code: 413 }); c.push(x); } return Buffer.concat(c); }
const J = (res, code, o) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
const isOps = (req, u) => eq(req.headers["x-ops-token"] || u.searchParams.get("token") || "", OPS);
const jpg = (s, max) => { const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(s || ""); if (!m) return null; const b = Buffer.from(m[1], "base64"); return b.length <= max ? b : null; };
// ---- Static front end: index.html next to server.js (or in ./public). Only whitelisted names are served from the app folder.
const WEB = ["index.html", "favicon.png", "logo-mark.png", "logo-full.png"];
const hasFront = () => [path.join(PUB, "index.html"), path.join(__dirname, "index.html")].some(f => fs.existsSync(f));
const MISSING = `<!doctype html><meta charset="utf-8"><title>PLUVIA SENSE</title><body style="font:16px system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h2>PLUVIA SENSE server is running</h2><p>But the web page <b>index.html</b> was not found next to <b>server.js</b>. Upload <b>index.html</b> to the same place as <b>server.js</b> in your repository, then redeploy.</p><p>Le serveur fonctionne, mais le fichier <b>index.html</b> est introuvable à côté de <b>server.js</b>. Ajoutez-le dans le dépôt puis redéployez.</p></body>`;
function serveStatic(p, res) {
  const rel = p === "/" ? "index.html" : p.replace(/^\/+/, ""), tries = [], a = path.normalize(path.join(PUB, rel));
  if (a.startsWith(PUB + path.sep)) tries.push(a); if (WEB.includes(rel)) tries.push(path.join(__dirname, rel));
  const next = i => { if (i >= tries.length) { res.writeHead(404, { "content-type": "text/html; charset=utf-8" }); return res.end(p === "/" ? MISSING : "Not found"); }
    fs.readFile(tries[i], (e, d) => { if (e) return next(i + 1); res.writeHead(200, { "content-type": MIME[path.extname(tries[i])] || "application/octet-stream", "cache-control": "no-cache" }); res.end(d); }); };
  next(0);
}
const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "content-type,x-ops-token,x-device-key"); res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("x-content-type-options", "nosniff"); res.setHeader("referrer-policy", "no-referrer"); res.setHeader("permissions-policy", "camera=(self), geolocation=(self)");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  let u; try { u = new URL(req.url.replace(/^\/{2,}/, "/"), "http://x"); } catch (e) { res.writeHead(400); return res.end("Bad request"); }
  const p = u.pathname, ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  try {
    if (p === "/api/health") return J(res, 200, { ok: true, weather: wxOK, frontend: hasFront() });
    if (p === "/api/state" && req.method === "GET") return J(res, 200, view(isOps(req, u)));
    if (p === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      const c = { res, ops: isOps(req, u) }; clients.add(c); res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(view(c.ops))}\n\n`); req.on("close", () => clients.delete(c)); return;
    }
    if (p === "/api/reports" && req.method === "POST") {
      if (limited(ip)) return J(res, 429, { error: "Too many reports. Wait a minute." });
      const b = JSON.parse((await body(req, 8e6)).toString() || "{}"), lat = +b.lat, lon = +b.lon;
      if (!(lat >= BOX.lat[0] && lat <= BOX.lat[1] && lon >= BOX.lon[0] && lon <= BOX.lon[1])) return J(res, 400, { error: "Location is outside the coverage area" });
      if (!TYPES.includes(b.type) || ![1, 2, 3].includes(+b.sev)) return J(res, 400, { error: "Invalid type or severity" });
      const id = "R" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 4).map(s => jpg(s, 1.5e6)).filter(Boolean);
      if (!photos.length && b.video !== true && b.noMedia !== true) return J(res, 400, { error: "A live photo or video is required" });
      photos.forEach((buf, i) => fs.writeFileSync(media(`${id}-${i}.jpg`), buf));
      const r = { id, kind: "report", t: Date.now(), lat, lon, src: b.src === "gps" ? "gps" : "tap", acc: isFinite(+b.acc) ? +b.acc : null, type: b.type, sev: +b.sev, desc: String(b.desc || "").slice(0, 1000), np: photos.length, video: b.video === true, noMedia: b.noMedia === true, status: "New" };
      db.reports.unshift(r); db.reports.length = Math.min(db.reports.length, 500); save(); { const f = full(r); push("report", { id, type: r.type, sev: r.sev, lat, lon, photos: r.np, video: r.video, noMedia: r.noMedia, int: f.intensity, decision: f.decision }, true); } broadcast(); return J(res, 201, { id });
    }
    let m;
    if ((m = /^\/api\/reports\/(R[\w]+)\/video$/.exec(p)) && req.method === "POST") {
      const r = db.reports.find(x => x.id === m[1]); if (!r || r.vext || Date.now() - r.t > 6e5) return J(res, 404, { error: "Report not found" });
      const ext = /mp4/.test(req.headers["content-type"] || "") ? "mp4" : "webm"; fs.writeFileSync(media(`${r.id}-v.${ext}`), await body(req, 15e6)); r.vext = ext; save(); broadcast(); return J(res, 200, { ok: true });
    }
    if (p === "/api/readings" && req.method === "POST") {   // sensor ingestion
      if (!eq(req.headers["x-device-key"] || "", DEV)) return J(res, 401, { error: "Invalid device key" });
      const b = JSON.parse((await body(req, 3e6)).toString() || "{}"), n = NODES.find(x => x.id === b.node), L = +b.level_cm;
      if (!n) return J(res, 404, { error: "Unknown node id" }); if (!isFinite(L) || L < 0 || L > 1000) return J(res, 400, { error: "level_cm out of range" });
      const t = Date.now(), dt = Math.max(.1, (t - n.lastReal) / 6e4); n.rate = n.lastReal && t - n.lastReal < 6e5 ? (L - n.L) / dt : 0;
      n.L = L; n.devRain = clamp(+b.rain_mmh || 0, 0, 300); n.lastReal = t; n.sim = false;
      const f = jpg(b.frame, 2e6); if (f) { fs.writeFileSync(media(`node-${n.id}.jpg`), f); n.frame = true; }
      if (EVENT_TEXT[b.event] && (!n.la.cam || t - n.la.cam > 3e5)) { n.la.cam = t; raise(n, Math.max(2, n.risk), "camera", EVENT_TEXT[b.event], f ? `node-${n.id}.jpg` : undefined); }   // on-device camera detection
      return J(res, 200, { ok: true });
    }
    if ((m = /^\/api\/items\/(\w+)$/.exec(p)) && req.method === "PATCH") {
      if (!isOps(req, u)) return J(res, 401, { error: "Operations access code required" });
      const b = JSON.parse((await body(req, 1e4)).toString() || "{}"), it = db.reports.find(x => x.id === m[1]) || db.alerts.find(x => x.id === m[1]);
      if (!it || !STAT.includes(b.status)) return J(res, 400, { error: "Unknown item or status" }); it.status = b.status; save(); broadcast(); return J(res, 200, { ok: true });
    }
    if (p === "/api/sim/storm" && req.method === "POST") {
      if (!isOps(req, u)) return J(res, 401, { error: "Operations access code required" });
      storm = !!JSON.parse((await body(req, 1e3)).toString() || "{}").on; broadcast(); return J(res, 200, { storm });
    }
    if ((m = /^\/api\/media\/([\w.-]+)$/.exec(p))) {
      if (!isOps(req, u)) return J(res, 401, { error: "Operations access code required" });
      return fs.readFile(media(m[1]), (e, d) => { if (e) return J(res, 404, { error: "Not found" }); res.writeHead(200, { "content-type": MIME[path.extname(m[1])] || "application/octet-stream", "cache-control": "private, max-age=3600" }); res.end(d); });
    }
        const wcache = new Map();
    if (p === "/api/weather") {
      if (limited(ip, 40, "w")) return J(res, 429, { error: "Too many requests" });
      const lat = +u.searchParams.get("lat"), lon = +u.searchParams.get("lon");
      if (!(lat >= BOX.lat[0] && lat <= BOX.lat[1] && lon >= BOX.lon[0] && lon <= BOX.lon[1])) return J(res, 400, { error: "Outside the coverage area" });
      const k = lat.toFixed(2) + "," + lon.toFixed(2), c = wcache.get(k); if (c && Date.now() - c.t < 6e5) return J(res, 200, c.v);
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,wind_speed_10m&hourly=precipitation&forecast_hours=6&timezone=GMT`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!r || !r.ok) return J(res, 502, { error: "Weather service unavailable" });
      const j = await r.json(), v = { t: Date.now(), temp: j.current.temperature_2m, rain: j.current.precipitation || 0, wind: j.current.wind_speed_10m, next: j.hourly.time.map((t, i) => ({ t: Date.parse(t + "Z"), mm: j.hourly.precipitation[i] || 0 })) };
      if (wcache.size > 300) wcache.clear(); wcache.set(k, { t: Date.now(), v }); return J(res, 200, v);
    }
    if (p === "/api/subscribe" && req.method === "POST") {
      if (limited(ip, 10, "s")) return J(res, 429, { error: "Too many requests. Try again in a minute." });
      const b = JSON.parse((await body(req, 1e4)).toString() || "{}"), role = b.role, lang = ["en", "fr", "ar"].includes(b.lang) ? b.lang : "en";
      if (!["school", "parent", "authority"].includes(role)) return J(res, 400, { error: "Choose school, parent or authority" });
      if (role === "authority" && !isOps(req, u)) return J(res, 401, { error: "Authority subscriptions need the operations code" });
      const ph = String(b.phone || "").replace(/[\s-]/g, ""), mail = String(b.email || "").trim().slice(0, 120), okP = /^\+\d{8,15}$/.test(ph), okM = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail);
      if (!okP && !okM) return J(res, 400, { error: "Enter a phone number with country code (+216…) or an e-mail address" });
      let node = NODES.find(x => x.id === b.node) ? b.node : role === "authority" && b.node === "all" ? "all" : null;
      if (!node && isFinite(+b.lat) && isFinite(+b.lon) && b.lat !== "" && b.lon !== "") node = near({ lat: +b.lat, lon: +b.lon }).id;
      if (!node) return J(res, 400, { error: "Choose your area" }); if (db.subs.length >= 5000) return J(res, 507, { error: "Subscriber limit reached" });
      const sub = { id: crypto.randomBytes(8).toString("hex"), t: Date.now(), role, lang, name: String(b.name || "").slice(0, 80), phone: okP ? ph : "", email: okM ? mail : "", node };
      db.subs.push(sub); save(); return J(res, 201, { id: sub.id, node });
    }
    if ((m = /^\/api\/subscribers\/(\w+)$/.exec(p)) && req.method === "DELETE") { const i = db.subs.findIndex(x => x.id === m[1]); if (i < 0) return J(res, 404, { error: "Not found" }); db.subs.splice(i, 1); save(); return J(res, 200, { ok: true }); }
    if (p === "/api/sim/forecast" && req.method === "POST") {
      if (!isOps(req, u)) return J(res, 401, { error: "Operations access code required" });
      const b = JSON.parse((await body(req, 1e3)).toString() || "{}");
      fakeFc = b.on ? { id: Date.now().toString(36), start: Date.now() + (isFinite(+b.startMin) ? +b.startMin : 55) * 6e4, len: (+b.lenH || 3) * 36e5, peak: +b.peak || 22 } : null;
      if (!fakeFc) db.eps = db.eps.filter(e => !e.fake); NODES.forEach(n => n.f3 = 0); episodes(); broadcast(); return J(res, 200, { fake: !!fakeFc });
    }
    if (p === "/api/sim/event" && req.method === "POST") {
      if (!isOps(req, u)) return J(res, 401, { error: "Operations access code required" });
      const b = JSON.parse((await body(req, 1e3)).toString() || "{}"), n = NODES.find(x => x.id === b.node) || NODES[3], ev = EVENT_TEXT[b.event] ? b.event : "water_rising";
      if (n.sim) n.L = clamp(n.L + 18, 8, n.thr * 1.5); raise(n, Math.max(2, n.risk), "camera", EVENT_TEXT[ev]); broadcast(); return J(res, 200, { ok: true });
    }
    if (p.startsWith("/api/")) return J(res, 404, { error: "Not found" });
    return serveStatic(p, res);
  } catch (e) { if (!res.headersSent) J(res, e.code === 413 ? 413 : e instanceof SyntaxError ? 400 : 500, { error: e.code === 413 ? e.message : e instanceof SyntaxError ? "Invalid JSON" : "Server error" }); }
});
process.on("uncaughtException", e => console.error("uncaught:", e)); process.on("unhandledRejection", e => console.error("unhandled:", e));
loadWx(); setInterval(loadWx, 3e5); setInterval(tick, 2000); setInterval(episodes, 3e4);
server.listen(PORT, () => console.log(`PluviaSense on :${PORT}\n  Operations code : ${OPS}\n  Device key      : ${DEV}\n  (set OPS_TOKEN and DEVICE_KEY env vars to make these permanent)`));
