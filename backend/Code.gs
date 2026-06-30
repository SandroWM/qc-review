/**
 * QC-Review-App — Backend (Google Apps Script Web App, JSON-API).
 * Kein Supabase: liest/schreibt direkt die Google Sheets, Auth ueber qc-users-Tab + signiertes Token.
 *
 * Reviewer-Entscheidung ist NUR approve/reject (OK/nicht-OK) + Grund. Ob daraus eine Revision oder
 * Neuerstellung wird, entscheidet die Prozess-Orchestrierung sop-09-05-content-qc-orchestration —
 * NICHT der Mensch. Diese App setzt daher nur QC-Status approved/rejected, kein Final-Decision/revision.
 *
 * Setup: CONFIG fuellen -> setup() einmal ausfuehren -> Deploy als Web-App ("Ausfuehren als: ich", "Zugriff: jeder").
 * Logins anlegen: createUser('va-008','StartPW','va','va-008','Maria').
 */

// ======================= CONFIG (ausfuellen) =======================
const CONFIG = {
  QUEUE_SSID:   "",            // Spreadsheet-ID von sheet-60-qc-queue
  QUEUE_TAB:    "Sheet1",      // Tab-Name darin (Default-Tab oft "Sheet1"/"Tabellenblatt1")
  GOLDEN_SSID:  "",            // sheet-64-qc-golden-set
  GOLDEN_TAB:   "Sheet1",
  RECRUIT_SSID: "",            // sheet-63-va-recruiting-pipeline
  RECRUIT_TAB:  "Sheet1",
  USERS_SSID:   "",            // Spreadsheet, in dem der qc-users-Tab liegt (z.B. dasselbe wie QUEUE_SSID)
  USERS_TAB:    "qc-users",
  DRIVE_FOLDER_ID: "",         // optional: Wurzel der Creator-Bilder (fuer Referenz-/Asset-URLs)
  QUOTA_PCT: 30,               // qc-begruendung-quote-prozent (Default; live aus sheet-48)
  RATE: { "Bild":0.025, "Video":0.06, "editiertes-Video":0.06, "Plan":0.10, "Konzept":0.10 },
  TOKEN_TTL_MIN: 720           // Token-Lebensdauer (Minuten)
};

// ======================= HTTP-Einstieg =======================
function doPost(e){
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    const out = route(body.action, body);
    return json(out);
  } catch (err) {
    return json({ ok:false, error:String(err) });
  }
}
function doGet(){ return json({ ok:true, info:"QC-Review-App backend. Use POST." }); }
function json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function route(action, body){
  if (action === "login")  return apiLogin(body);
  if (action === "next")   return apiNext(body);
  if (action === "submit") return apiSubmit(body);
  return { ok:false, error:"unknown action" };
}

// ======================= Auth =======================
function apiLogin(body){
  const u = findUser_(body.username);
  if (!u || u.Status === "entfernt") return { ok:false, error:"Falsche Zugangsdaten." };
  if (sha256Hex_(u.Salt + (body.password||"")) !== u.PasswordHash) return { ok:false, error:"Falsche Zugangsdaten." };
  const token = signToken_({ u:u.Username, r:u.Role, v:u["VA-ID"]||"", exp: Date.now() + CONFIG.TOKEN_TTL_MIN*60000 });
  return { ok:true, token, role:u.Role, name:u.Name||u.Username, vaId:u["VA-ID"]||"" };
}
function auth_(token){
  const p = verifyToken_(token);
  if (!p) throw "Sitzung abgelaufen — bitte neu einloggen.";
  return p;
}
function signToken_(payload){
  const secret = props_().getProperty("TOKEN_SECRET");
  const data = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(data, secret));
  return data + "." + sig;
}
function verifyToken_(token){
  if (!token || token.indexOf(".")<0) return null;
  const secret = props_().getProperty("TOKEN_SECRET");
  const [data, sig] = token.split(".");
  const expect = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(data, secret));
  if (sig !== expect) return null;
  const p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString());
  if (!p.exp || Date.now() > p.exp) return null;
  return p;
}
function sha256Hex_(s){
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ("0"+(b&0xff).toString(16)).slice(-2)).join("");
}
function props_(){ return PropertiesService.getScriptProperties(); }

// ======================= next =======================
function apiNext(body){
  const p = auth_(body.token);
  const mode = body.mode || "review";
  if (mode === "screening") return nextScreening_(body);

  const sh = sheet_(CONFIG.QUEUE_SSID, CONFIG.QUEUE_TAB);
  const t = table_(sh);
  let row = null;
  if (mode === "spotcheck"){
    row = t.rows.find(r => ["approved","rejected"].indexOf(r["QC-Status"])>=0
      && String(r["Reviewer-Tier"])==="1" && !String(r["Sandro-Spot-Check"]||"").trim());
  } else { // review
    row = t.rows.find(r => r["QC-Status"]==="pending")
       || t.rows.find(r => r["QC-Status"]==="in-review" && r["Assigned-Reviewer"]===(p.v||p.u));
    if (row && row["QC-Status"]==="pending"){
      setCells_(sh, t, row._row, { "QC-Status":"in-review",
        "Assigned-Reviewer": p.v||p.u, "Reviewer-Tier": p.r==="admin"?"0":"1" });
    }
  }
  if (!row) return { ok:true, item:null, stats:statsFor_(p, mode) };
  return { ok:true,
    item: { itemId:row["Item-ID"], contentTyp:row["Content-Typ"], sourceSop:row["Source-SOP"],
            creatorId:row["Creator-ID"], creatorName: creatorName_(row["Creator-ID"]),
            assetUrl: assetUrl_(row["Asset-Ref"]), vaDecision: mode==="spotcheck"? row["VA-Decision"]:null },
    reference: creatorReference_(row["Creator-ID"]),
    stats: statsFor_(p, mode) };
}

// ======================= submit =======================
function apiSubmit(body){
  const p = auth_(body.token);
  const mode = body.mode || "review";
  if (mode === "screening") return submitScreening_(body);

  // Reviewer entscheidet nur approve/reject. revision ist KEINE Reviewer-Option.
  if (["approve","reject"].indexOf(body.decision) < 0) return { ok:false, error:"Ungültige Entscheidung." };
  const sh = sheet_(CONFIG.QUEUE_SSID, CONFIG.QUEUE_TAB);
  const t = table_(sh);
  const row = t.rows.find(r => r["Item-ID"] === body.itemId);
  if (!row) return { ok:false, error:"Item nicht gefunden." };
  const just = String(body.begruendung||"").trim();
  if (body.decision==="reject" && !just) return { ok:false, error:"Begründung ist Pflicht bei Reject." };

  if (mode === "spotcheck"){
    const agree = body.decision === row["VA-Decision"];
    const tag = agree ? "agreement"
      : (row["VA-Decision"]==="approve" ? "abweichung-false-approve" : "abweichung-false-reject");
    const patch = { "Sandro-Spot-Check": "ja: "+tag };
    if (!agree) patch["Sandro-Begruendung"] = just;
    setCells_(sh, t, row._row, patch);
  } else { // review — nur Reviewer-Verdikt; Final-Decision/Revision = sop-09-05
    setCells_(sh, t, row._row, {
      "VA-Decision": body.decision, "VA-Rating": body.rating||"",
      "VA-Begruendung": just,
      "QC-Status": body.decision==="approve" ? "approved" : "rejected",
      "Reviewed-At": new Date().toISOString(), "Assigned-Reviewer": p.v||p.u });
  }
  return { ok:true, stats: statsFor_(p, mode, body.contentTyp) };
}

// ======================= Screening (Bewerber) =======================
function nextScreening_(body){
  const idx = Number(cache_().get("scr_idx_"+body.token) || 0);
  const t = table_(sheet_(CONFIG.GOLDEN_SSID, CONFIG.GOLDEN_TAB));
  const pool = t.rows.filter(r => ["screening","both"].indexOf(r["Verwendung"])>=0 && r["Status"]==="aktiv");
  if (idx >= pool.length) return { ok:true, item:null };
  const row = pool[idx];
  return { ok:true,
    item: { itemId:row["Golden-ID"], contentTyp:row["Content-Typ"], sourceSop:"golden-set",
            creatorId:"", creatorName:"", assetUrl: assetUrl_(row["Source-Item-Ref"]), vaDecision:null },
    reference: [], stats: { done: idx } };
}
function submitScreening_(body){
  const c = cache_();
  const idx = Number(c.get("scr_idx_"+body.token) || 0);
  const t = table_(sheet_(CONFIG.GOLDEN_SSID, CONFIG.GOLDEN_TAB));
  const pool = t.rows.filter(r => ["screening","both"].indexOf(r["Verwendung"])>=0 && r["Status"]==="aktiv");
  const row = pool[idx];
  let correct = Number(c.get("scr_ok_"+body.token) || 0);
  if (row && row["Ground-Truth-Decision"] === body.decision) correct++;
  c.put("scr_idx_"+body.token, String(idx+1), 21600);
  c.put("scr_ok_"+body.token,  String(correct), 21600);
  if (idx+1 >= pool.length){
    const pct = Math.round(correct/pool.length*100);
    writeScreeningResult_(body.token, pct, pool.length); // -> sheet-63 (sop-09-07 Auto-Scoring)
  }
  return { ok:true, stats:{ done: idx+1 } };
}
function writeScreeningResult_(token, pct, n){
  if (!CONFIG.RECRUIT_SSID) return;
  try {
    const sh = sheet_(CONFIG.RECRUIT_SSID, CONFIG.RECRUIT_TAB);
    const t = table_(sh);
    const row = t.rows.find(r => r["Test-Detail-Ref"] === token || r["Bewerber-ID"] === token);
    if (row) setCells_(sh, t, row._row, { "Golden-Set-Score":pct, "Test-Items-Anzahl":n,
      "Test-Status":"abgeschlossen", "Pipeline-Status":"getestet" });
  } catch(e){ /* sop-09-07 uebernimmt die Bewerber-Zeile sonst per API */ }
}

// ======================= Stats / Referenz / Assets =======================
function statsFor_(p, mode, lastTyp){
  if (mode === "spotcheck") return { done:null, agreementPct:null, describedToday:null, neededToday:null, earningsToday:null };
  const t = table_(sheet_(CONFIG.QUEUE_SSID, CONFIG.QUEUE_TAB));
  const today = new Date().toISOString().slice(0,10);
  const mine = t.rows.filter(r => r["Assigned-Reviewer"]===(p.v||p.u) && String(r["Reviewed-At"]||"").slice(0,10)===today);
  const done = mine.length;
  const described = mine.filter(r => String(r["VA-Begruendung"]||"").trim()).length;
  const earn = mine.reduce((s,r)=> s + (CONFIG.RATE[r["Content-Typ"]]||0.025), 0);
  return { done, agreementPct:null, describedToday:described,
           neededToday: Math.ceil(done*CONFIG.QUOTA_PCT/100), earningsToday: Math.round(earn*1000)/1000 };
}
function creatorName_(creatorId){
  return creatorId || "";  // optional: Join auf sheet-01-persona-stack fuer Klarnamen
}
function creatorReference_(creatorId){
  // Approved-Referenz = zuletzt approvte Items dieses Creators aus sheet-60 (+ optional Persona-Dataset)
  try {
    const t = table_(sheet_(CONFIG.QUEUE_SSID, CONFIG.QUEUE_TAB));
    return t.rows.filter(r => r["Creator-ID"]===creatorId && r["QC-Status"]==="approved")
      .slice(-4).map(r => ({ url: assetUrl_(r["Asset-Ref"]), label: creatorId }));
  } catch(e){ return []; }
}
function assetUrl_(ref){
  ref = String(ref||"");
  if (/^https?:\/\//.test(ref)) return ref;
  // Drive-Datei-ID -> Viewer-URL
  if (/^[A-Za-z0-9_-]{20,}$/.test(ref)) return "https://drive.google.com/uc?id=" + ref;
  return ref;
}

// ======================= Sheet-Helfer (header-basiert) =======================
function sheet_(ssid, tab){
  const ss = SpreadsheetApp.openById(ssid);
  return ss.getSheetByName(tab) || ss.getSheets()[0];
}
function table_(sh){
  const values = sh.getDataRange().getValues();
  const header = values[0].map(String);
  const rows = [];
  for (let i=1;i<values.length;i++){
    const o = { _row: i+1 };
    header.forEach((h,c)=> o[h] = values[i][c]);
    rows.push(o);
  }
  return { sh, header, rows };
}
function setCells_(sh, t, rowNum, patch){
  Object.keys(patch).forEach(col => {
    const c = t.header.indexOf(col);
    if (c >= 0) sh.getRange(rowNum, c+1).setValue(patch[col]);
  });
}
function cache_(){ return CacheService.getScriptCache(); }

// ======================= Setup / User-Verwaltung =======================
function setup(){
  if (!props_().getProperty("TOKEN_SECRET"))
    props_().setProperty("TOKEN_SECRET", Utilities.getUuid() + Utilities.getUuid());
  const ss = SpreadsheetApp.openById(CONFIG.USERS_SSID || CONFIG.QUEUE_SSID);
  let sh = ss.getSheetByName(CONFIG.USERS_TAB);
  if (!sh){
    sh = ss.insertSheet(CONFIG.USERS_TAB);
    sh.appendRow(["Username","Salt","PasswordHash","Role","VA-ID","Name","Status"]);
  }
  // Admin-Login anlegen (Passwort hier setzen, danach aendern/loeschen):
  createUser("sandro", "AendereMich!", "admin", "", "Sandro");
  Logger.log("Setup fertig. Admin 'sandro' angelegt — Passwort sofort per createUser aendern.");
}
function createUser(username, password, role, vaId, name){
  const ss = SpreadsheetApp.openById(CONFIG.USERS_SSID || CONFIG.QUEUE_SSID);
  const sh = ss.getSheetByName(CONFIG.USERS_TAB);
  const salt = Utilities.getUuid();
  const hash = sha256Hex_(salt + password);
  const t = table_(sh);
  const existing = t.rows.find(r => String(r.Username).toLowerCase() === String(username).toLowerCase());
  if (existing) setCells_(sh, t, existing._row, { Salt:salt, PasswordHash:hash, Role:role, "VA-ID":vaId||"", Name:name||username, Status:"aktiv" });
  else sh.appendRow([username, salt, hash, role, vaId||"", name||username, "aktiv"]);
  Logger.log("User gespeichert: " + username);
}
function findUser_(username){
  const ss = SpreadsheetApp.openById(CONFIG.USERS_SSID || CONFIG.QUEUE_SSID);
  const sh = ss.getSheetByName(CONFIG.USERS_TAB);
  if (!sh) return null;
  return table_(sh).rows.find(r => String(r.Username).toLowerCase() === String(username||"").toLowerCase());
}
