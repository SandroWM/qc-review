/**
 * QC-Review-App — Backend (Google Apps Script Web App, JSON-API). V2 (W2-Haertung 2026-07-02).
 * Kein Supabase: liest/schreibt direkt die Google Sheets, Auth ueber qc-users-Tab + signiertes Token.
 *
 * Reviewer-Entscheidung ist NUR approve/reject (OK/nicht-OK) + Grund. Ob daraus eine Revision oder
 * Neuerstellung wird, entscheidet die Prozess-Orchestrierung sop-09-05-content-qc-orchestration —
 * NICHT der Mensch. Diese App setzt daher nur QC-Status approved/rejected, kein Final-Decision/revision.
 *
 * V2-Haertung (Audit 2026-07-02):
 *  - Serverseitige Rechte-Pruefung: Item-Eigentuemerschaft bei submit (IDOR-Fix), Spot-Check nur admin.
 *  - LockService um Claim + Submit (Race-Fix bei parallelen VAs).
 *  - Login-Rate-Limit (Lockout nach 8 Fehlversuchen / 15 min) + iteriertes Passwort-Hashing (v2$iter$hash,
 *    Salt+Pepper, Auto-Upgrade von Alt-Hashes beim naechsten Login) + timing-sichere Vergleiche.
 *  - 30%-Begruendungs-Quote serverseitig erzwungen; Spot-Check-Abweichungs-Begruendung serverseitig Pflicht.
 *  - Screening VOR auth_ (Bewerber haben kein Login); Test-Ref wird gegen sheet-63 validiert;
 *    NSFW-Consent-Zeitstempel in sheet-63:Notiz (Sandro-Vorgabe: Feststellung mid-funnel).
 *  - Typ-Tabs (Board): queueSummary je Content-Typ + optionaler typ-Filter bei next (Sandro-Vorgabe, D22).
 *  - Skript-Items: Asset-Ref "sheet-32:<Reel-ID>" wird zu Skript-Text aufgeloest (Content-Typ Skript).
 *  - Token traegt Versions-Claim (Notfall-Revoke via bumpTokenVersion()).
 *  - Rating-Clamp, doPost-Body-Guard, Referenz-Cache.
 *
 * Setup: CONFIG fuellen -> setup('EinmalAdminPasswort') einmal ausfuehren -> Deploy als Web-App
 * ("Ausfuehren als: ich", "Zugriff: jeder"). Logins: createUser('va-008','StartPW','va','va-008','Maria').
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
  SKRIPT_SSID:  "",            // sheet-32-marketingtabelle (fuer Content-Typ Skript: Skript-Text-Aufloesung)
  SKRIPT_TAB:   "Sheet1",
  DRIVE_FOLDER_ID: "",         // optional: Wurzel der Creator-Bilder (fuer Referenz-/Asset-URLs)
  QUOTA_PCT: 30,               // qc-begruendung-quote-prozent (Default; live aus sheet-48)
  RATE: { "Bild":0.025, "Video":0.06, "editiertes-Video":0.06, "Skript":0.05, "Plan":0.10, "Konzept":0.10 },
  TOKEN_TTL_MIN: 720,          // Token-Lebensdauer (Minuten)
  HASH_ITER: 5000,             // Passwort-Hash-Iterationen (v2-Format)
  LOGIN_MAX_FAILS: 8,          // Lockout-Schwelle
  LOGIN_LOCK_MIN: 15,          // Lockout-Dauer (Minuten)
  SCREENING_ITEMS: 20          // va-screening-items-anzahl (Default; sop-09-07)
};
const TYPES = ["Bild","Video","editiertes-Video","Skript","Plan","Konzept"];

// ======================= HTTP-Einstieg =======================
function doPost(e){
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    const body = JSON.parse(raw || "{}");
    const out = route(String(body.action||""), body);
    return json(out);
  } catch (err) {
    return json({ ok:false, error:String(err) });
  }
}
function doGet(){ return json({ ok:true, info:"QC-Review-App backend. Use POST." }); }
function json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function route(action, body){
  // Screening (Bewerber, KEIN Login-Token) — bewusst VOR jeder auth_ (W2-Fix: auth blockte Bewerber).
  if (body.mode === "screening" || action === "screening_next" || action === "screening_submit"){
    if (action === "next"   || action === "screening_next")   return nextScreening_(body);
    if (action === "submit" || action === "screening_submit") return submitScreening_(body);
  }
  if (action === "login")  return apiLogin(body);
  if (action === "next")   return apiNext(body);
  if (action === "submit") return apiSubmit(body);
  return { ok:false, error:"unknown action" };
}

// ======================= Auth =======================
function apiLogin(body){
  const uname = String(body.username||"").trim().toLowerCase();
  if (!uname) return { ok:false, error:"Falsche Zugangsdaten." };

  // Rate-Limit: Lockout nach LOGIN_MAX_FAILS Fehlversuchen pro Username (W2-Fix: Brute-Force-Schutz).
  const c = cache_();
  const failKey = "login_fail_" + uname;
  const fails = Number(c.get(failKey) || 0);
  if (fails >= CONFIG.LOGIN_MAX_FAILS)
    return { ok:false, error:"Zu viele Fehlversuche — bitte in " + CONFIG.LOGIN_LOCK_MIN + " Minuten erneut." };

  const u = findUser_(uname);
  const ok = u && u.Status !== "entfernt" && checkPassword_(u, String(body.password||""));
  if (!ok){
    c.put(failKey, String(fails+1), CONFIG.LOGIN_LOCK_MIN*60);
    Utilities.sleep(300 + Math.floor(Math.random()*200));   // Antwortzeit angleichen
    return { ok:false, error:"Falsche Zugangsdaten." };
  }
  c.remove(failKey);
  maybeUpgradeHash_(u, String(body.password||""));          // Alt-Hash -> v2 (transparent)
  const token = signToken_({ u:u.Username, r:u.Role, v:u["VA-ID"]||"", tv: tokenVersion_(),
                             exp: Date.now() + CONFIG.TOKEN_TTL_MIN*60000 });
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
  const parts = String(token).split(".");
  const expect = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], secret));
  if (!constEq_(parts[1]||"", expect)) return null;                       // timing-sicher (W2)
  let p; try { p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString()); }
  catch(e){ return null; }
  if (!p.exp || Date.now() > p.exp) return null;
  if (String(p.tv||"") !== tokenVersion_()) return null;                  // Notfall-Revoke (W2)
  return p;
}
function tokenVersion_(){ return props_().getProperty("TOKEN_VERSION") || "1"; }
function bumpTokenVersion(){   // manuell im Editor ausfuehren -> ALLE Sessions sofort ungueltig
  const v = String(Number(tokenVersion_())+1);
  props_().setProperty("TOKEN_VERSION", v);
  Logger.log("Token-Version -> " + v + " (alle Sessions revoked).");
}

// --- Passwort-Hashing: v2 = iteriertes SHA-256 mit Salt + Server-Pepper; Legacy = 1x SHA-256(salt+pw) ---
function hashPwV2_(salt, password){
  const pepper = props_().getProperty("PW_PEPPER") || "";
  let h = salt + "|" + password + "|" + pepper;
  for (let i=0; i<CONFIG.HASH_ITER; i++)
    h = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  return "v2$" + CONFIG.HASH_ITER + "$" + h;
}
function checkPassword_(u, password){
  const stored = String(u.PasswordHash||"");
  if (stored.indexOf("v2$") === 0){
    const iter = Number(stored.split("$")[1]) || CONFIG.HASH_ITER;
    const pepper = props_().getProperty("PW_PEPPER") || "";
    let h = String(u.Salt||"") + "|" + password + "|" + pepper;
    for (let i=0; i<iter; i++)
      h = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
    return constEq_("v2$"+iter+"$"+h, stored);
  }
  return constEq_(sha256Hex_(String(u.Salt||"") + password), stored);     // Legacy-Fallback
}
function maybeUpgradeHash_(u, password){
  if (String(u.PasswordHash||"").indexOf("v2$") === 0) return;
  try {
    const ss = SpreadsheetApp.openById(CONFIG.USERS_SSID || CONFIG.QUEUE_SSID);
    const sh = ss.getSheetByName(CONFIG.USERS_TAB);
    const t = table_(sh);
    const row = t.rows.find(r => String(r.Username).toLowerCase() === String(u.Username).toLowerCase());
    if (row) setCells_(sh, t, row._row, { PasswordHash: hashPwV2_(String(row.Salt||""), password) });
  } catch(e){ /* Upgrade optional */ }
}
function sha256Hex_(s){
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}
function bytesToHex_(bytes){ return bytes.map(b => ("0"+(b&0xff).toString(16)).slice(-2)).join(""); }
function constEq_(a, b){
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i=0; i<a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function props_(){ return PropertiesService.getScriptProperties(); }

// ======================= next =======================
function apiNext(body){
  const p = auth_(body.token);
  const mode = body.mode || "review";
  if (mode === "spotcheck" && p.r !== "admin")
    return { ok:false, error:"Kein Zugriff auf diesen Modus." };          // W2-Fix: Rollen-Gate serverseitig
  if (mode !== "review" && mode !== "spotcheck")
    return { ok:false, error:"Unbekannter Modus." };

  const typ = TYPES.indexOf(String(body.typ||"")) >= 0 ? String(body.typ) : null;  // Typ-Tab-Filter (D22)
  const sh = sheet_(CONFIG.QUEUE_SSID, CONFIG.QUEUE_TAB);

  const lock = LockService.getScriptLock();                               // W2-Fix: Race beim Claim
  lock.waitLock(10000);
  let row = null, t = null;
  try {
    t = table_(sh);
    if (mode === "spotcheck"){
      row = t.rows.find(r => eligibleSpot_(r) && (!typ || r["Content-Typ"]===typ));
    } else {
      const me = p.v || p.u;
      row = t.rows.find(r => r["QC-Status"]==="in-review" && r["Assigned-Reviewer"]===me && (!typ || r["Content-Typ"]===typ))
         || t.rows.find(r => r["QC-Status"]==="pending" && (!typ || r["Content-Typ"]===typ));
      if (row && row["QC-Status"]==="pending"){
        setCells_(sh, t, row._row, { "QC-Status":"in-review",
          "Assigned-Reviewer": me, "Reviewer-Tier": p.r==="admin"?"0":"1" });
        row["QC-Status"]="in-review"; row["Assigned-Reviewer"]=me;
      }
    }
  } finally { lock.releaseLock(); }

  const summary = queueSummary_(t, p, mode);
  if (!row) return { ok:true, item:null, stats:statsFor_(t, p, mode), queueSummary:summary };
  return { ok:true,
    item: { itemId:row["Item-ID"], contentTyp:row["Content-Typ"], sourceSop:row["Source-SOP"],
            creatorId:row["Creator-ID"], creatorName: creatorName_(row["Creator-ID"]),
            asset: assetFor_(row),
            vaDecision: mode==="spotcheck" ? row["VA-Decision"] : null },
    reference: creatorReference_(row["Creator-ID"]),
    stats: statsFor_(t, p, mode), queueSummary: summary };
}
function eligibleSpot_(r){
  return ["approved","rejected"].indexOf(r["QC-Status"])>=0
    && String(r["Reviewer-Tier"])==="1" && !String(r["Sandro-Spot-Check"]||"").trim();
}
function queueSummary_(t, p, mode){
  const out = {};
  TYPES.forEach(typ => out[typ] = 0);
  const me = p.v || p.u;
  t.rows.forEach(r => {
    const typ = r["Content-Typ"]; if (!(typ in out)) return;
    if (mode === "spotcheck"){ if (eligibleSpot_(r)) out[typ]++; }
    else if (r["QC-Status"]==="pending" || (r["QC-Status"]==="in-review" && r["Assigned-Reviewer"]===me)) out[typ]++;
  });
  return out;
}

// ======================= submit =======================
function apiSubmit(body){
  const p = auth_(body.token);
  const mode = body.mode || "review";
  if (mode === "spotcheck" && p.r !== "admin")
    return { ok:false, error:"Kein Zugriff auf diesen Modus." };          // W2-Fix
  if (mode !== "review" && mode !== "spotcheck")
    return { ok:false, error:"Unbekannter Modus." };

  // Reviewer entscheidet nur approve/reject. revision ist KEINE Reviewer-Option (sop-09-05 entscheidet).
  if (["approve","reject"].indexOf(body.decision) < 0) return { ok:false, error:"Ungültige Entscheidung." };
  const rating = clampRating_(body.rating);                               // W2-Fix: Rating validieren
  const just = String(body.begruendung||"").trim();
  if (body.decision==="reject" && !just) return { ok:false, error:"Begründung ist Pflicht bei Reject." };

  const sh = sheet_(CONFIG.QUEUE_SSID, CONFIG.QUEUE_TAB);
  const lock = LockService.getScriptLock();                               // W2-Fix: atomarer Submit
  lock.waitLock(10000);
  try {
    const t = table_(sh);
    const row = t.rows.find(r => r["Item-ID"] === body.itemId);
    if (!row) return { ok:false, error:"Item nicht gefunden." };

    if (mode === "spotcheck"){
      if (!eligibleSpot_(row)) return { ok:false, error:"Item nicht (mehr) spot-check-fähig." };
      const agree = body.decision === row["VA-Decision"];
      if (!agree && !just) return { ok:false, error:"Begründung ist Pflicht bei Abweichung." };  // W2: serverseitig
      const tag = agree ? "agreement"
        : (row["VA-Decision"]==="approve" ? "abweichung-false-approve" : "abweichung-false-reject");
      const patch = { "Sandro-Spot-Check": "ja: "+tag };
      if (!agree) patch["Sandro-Begruendung"] = just;
      setCells_(sh, t, row._row, patch);
      return { ok:true, stats: statsFor_(t, p, mode) };
    }

    // review — W2-Fix (IDOR): nur das MIR zugewiesene, offene Item darf entschieden werden.
    const me = p.v || p.u;
    if (row["QC-Status"] !== "in-review" || row["Assigned-Reviewer"] !== me)
      return { ok:false, error:"Item ist dir nicht (mehr) zugewiesen." };

    // W2-Fix: 30%-Begruendungs-Quote SERVERSEITIG erzwingen (aus sheet-60 gerechnet, nicht Client-State).
    if (body.decision === "approve" && !just){
      const mine = myToday_(t, me);
      const doneAfter = mine.done + 1;
      const describedAfter = mine.described;
      if (mine.done >= 1 && (describedAfter/doneAfter) < (CONFIG.QUOTA_PCT/100))
        return { ok:false, error:"Begründungs-Quote: mind. "+CONFIG.QUOTA_PCT+"% — bitte dieses Item kurz begründen.", quota:true };
    }

    setCells_(sh, t, row._row, {
      "VA-Decision": body.decision, "VA-Rating": rating,
      "VA-Begruendung": just,
      "QC-Status": body.decision==="approve" ? "approved" : "rejected",
      "Reviewed-At": new Date().toISOString() });
    return { ok:true, stats: statsFor_(t, p, mode, true) };
  } finally { lock.releaseLock(); }
}
function clampRating_(r){
  const n = Number(r);
  if (!n || isNaN(n)) return "";
  return String(Math.min(5, Math.max(1, Math.round(n))));
}

// ======================= Screening (Bewerber — KEIN Login-Token, Test-Ref aus sheet-63) =======================
function screeningRow_(testRef){
  if (!CONFIG.RECRUIT_SSID) return { err:"Screening ist nicht konfiguriert." };
  const sh = sheet_(CONFIG.RECRUIT_SSID, CONFIG.RECRUIT_TAB);
  const t = table_(sh);
  const row = t.rows.find(r => String(r["Test-Detail-Ref"]) === String(testRef) || String(r["Bewerber-ID"]) === String(testRef));
  if (!row) return { err:"Ungültiger oder abgelaufener Test-Link." };
  if (String(row["Test-Status"]) === "abgeschlossen") return { err:"Dieser Test wurde bereits abgeschlossen." };
  return { sh, t, row };
}
function screeningPool_(testRef){
  const t = table_(sheet_(CONFIG.GOLDEN_SSID, CONFIG.GOLDEN_TAB));
  let pool = t.rows.filter(r => ["screening","both"].indexOf(r["Verwendung"])>=0 && r["Status"]==="aktiv");
  pool = shuffleDet_(pool, String(testRef));                              // deterministisch je Bewerber randomisiert
  return pool.slice(0, CONFIG.SCREENING_ITEMS);
}
function nextScreening_(body){
  const ref = String(body.test || body.token || "");
  const s = screeningRow_(ref);
  if (s.err) return { ok:false, error:s.err };
  const c = cache_();
  const idx = Number(c.get("scr_idx_"+ref) || 0);
  if (idx === 0 && !String(s.row["Notiz"]||"").match(/NSFW-Consent/)){
    // Consent-Doku (Sandro-Vorgabe: NSFW-Feststellung mid-funnel; Teilnahme = Bestätigung 18+/Einverständnis)
    setCells_(s.sh, s.t, s.row._row, { "Notiz": (String(s.row["Notiz"]||"")+" | NSFW-Consent bestätigt "+new Date().toISOString()).replace(/^ \| /,"") });
  }
  const pool = screeningPool_(ref);
  if (idx >= pool.length) return { ok:true, item:null, stats:{ done:idx, total:pool.length } };
  const row = pool[idx];
  return { ok:true,
    item: { itemId:row["Golden-ID"], contentTyp:row["Content-Typ"], sourceSop:"golden-set",
            creatorId:"", creatorName:"", asset: assetFor_(row, true), vaDecision:null },
    reference: [], stats: { done: idx, total: pool.length } };
}
function submitScreening_(body){
  const ref = String(body.test || body.token || "");
  const s = screeningRow_(ref);
  if (s.err) return { ok:false, error:s.err };
  if (["approve","reject"].indexOf(body.decision) < 0) return { ok:false, error:"Ungültige Entscheidung." };
  const c = cache_();
  const idx = Number(c.get("scr_idx_"+ref) || 0);
  const pool = screeningPool_(ref);
  const row = pool[idx];
  let correct = Number(c.get("scr_ok_"+ref) || 0);
  let faWrong = Number(c.get("scr_fa_"+ref) || 0);   // Bewerber approve bei Ground-Truth reject
  let gtRej   = Number(c.get("scr_gr_"+ref) || 0);   // Anzahl Ground-Truth-reject-Items
  if (row){
    if (row["Ground-Truth-Decision"] === body.decision) correct++;
    if (row["Ground-Truth-Decision"] === "reject"){ gtRej++; if (body.decision === "approve") faWrong++; }
  }
  c.put("scr_idx_"+ref, String(idx+1), 21600);
  c.put("scr_ok_"+ref,  String(correct), 21600);
  c.put("scr_fa_"+ref,  String(faWrong), 21600);
  c.put("scr_gr_"+ref,  String(gtRej), 21600);
  if (idx+1 >= pool.length){
    const pct = pool.length ? Math.round(correct/pool.length*100) : 0;
    const faPct = gtRej ? Math.round(faWrong/gtRej*100) : 0;
    setCells_(s.sh, s.t, s.row._row, { "Golden-Set-Score":pct, "Test-False-Approve-Quote":faPct,
      "Test-Items-Anzahl":pool.length, "Test-Status":"abgeschlossen", "Pipeline-Status":"getestet" });
    return { ok:true, stats:{ done: idx+1, total: pool.length, finished:true, scorePct:pct } };
  }
  return { ok:true, stats:{ done: idx+1, total: pool.length } };
}
function shuffleDet_(arr, seedStr){
  // deterministische Fisher-Yates-Mischung, Seed = Test-Ref (gleiche Reihenfolge je Bewerber ueber Requests)
  const out = arr.slice();
  let seed = 0;
  const hex = sha256Hex_(seedStr);
  for (let i=0;i<8;i++) seed = (seed*16 + parseInt(hex[i],16)) >>> 0;
  const rnd = () => { seed = (seed*1664525 + 1013904223) >>> 0; return seed/4294967296; };
  for (let i=out.length-1;i>0;i--){ const j = Math.floor(rnd()*(i+1)); const tmp=out[i]; out[i]=out[j]; out[j]=tmp; }
  return out;
}

// ======================= Stats / Referenz / Assets =======================
function myToday_(t, me){
  const today = new Date().toISOString().slice(0,10);
  const mine = t.rows.filter(r => r["Assigned-Reviewer"]===me && String(r["Reviewed-At"]||"").slice(0,10)===today);
  return { rows:mine, done:mine.length,
           described: mine.filter(r => String(r["VA-Begruendung"]||"").trim()).length };
}
function statsFor_(t, p, mode, fresh){
  if (mode === "spotcheck") return { done:null, agreementPct:null, describedToday:null, neededToday:null, earningsToday:null };
  if (!t || fresh) t = table_(sheet_(CONFIG.QUEUE_SSID, CONFIG.QUEUE_TAB));
  const me = p.v || p.u;
  const m = myToday_(t, me);
  const earn = m.rows.reduce((s,r)=> s + (CONFIG.RATE[r["Content-Typ"]]||0.025), 0);
  return { done:m.done, agreementPct:null, describedToday:m.described,
           neededToday: Math.ceil(m.done*CONFIG.QUOTA_PCT/100), earningsToday: Math.round(earn*1000)/1000 };
}
function creatorName_(creatorId){
  return creatorId || "";  // optional: Join auf sheet-01-persona-stack fuer Klarnamen
}
function creatorReference_(creatorId){
  // Approved-Referenz = zuletzt approvte Items dieses Creators aus sheet-60 (+ optional Persona-Dataset).
  // W2: 60s-Cache gegen Voll-Scans je Request.
  if (!creatorId) return [];
  const c = cache_();
  const key = "ref_" + creatorId;
  const hit = c.get(key);
  if (hit) { try { return JSON.parse(hit); } catch(e){} }
  try {
    const t = table_(sheet_(CONFIG.QUEUE_SSID, CONFIG.QUEUE_TAB));
    const out = t.rows.filter(r => r["Creator-ID"]===creatorId && r["QC-Status"]==="approved"
        && ["Bild","Video","editiertes-Video"].indexOf(r["Content-Typ"])>=0)
      .slice(-4).map(r => ({ url: assetUrl_(r["Asset-Ref"]), label: String(creatorId) }));
    c.put(key, JSON.stringify(out), 60);
    return out;
  } catch(e){ return []; }
}
function assetFor_(row, isGolden){
  const typ = String(row["Content-Typ"]||"");
  const ref = String((isGolden ? row["Source-Item-Ref"] : row["Asset-Ref"]) || "");
  if (typ === "Skript") return { kind:"text", text: resolveSkript_(ref) };
  if (typ === "Plan" || typ === "Konzept"){
    // Plan/Konzept: Sheet-Zeilen-FK -> als Text-Verweis anzeigen (Reviewer oeffnet die Quelle)
    if (!/^https?:\/\//.test(ref)) return { kind:"text", text: "Konzept-/Plan-Item — Quelle: " + ref };
  }
  return { kind:"image", url: assetUrl_(ref) };
}
function resolveSkript_(ref){
  // Asset-Ref-Konvention: "sheet-32:<Reel-ID>" -> skript_text aus sheet-32-marketingtabelle
  const m = String(ref).match(/sheet-32[:\/](.+)$/);
  if (m && CONFIG.SKRIPT_SSID){
    try {
      const t = table_(sheet_(CONFIG.SKRIPT_SSID, CONFIG.SKRIPT_TAB));
      const row = t.rows.find(r => String(r["Reel-ID"]) === m[1].trim());
      if (row) return "Reel " + row["Reel-ID"] + " · " + (row["Format"]||"reel") + "\n\n" + String(row["skript_text"]||"(leer)")
        + (row["caption"] ? "\n\n— Caption —\n" + row["caption"] : "");
    } catch(e){ /* faellt auf Ref-Anzeige zurueck */ }
  }
  return "Skript-Item — Quelle: " + ref;
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
function setup(adminPassword){
  if (!adminPassword) throw "setup('EinmalAdminPasswort') mit einem Passwort-Argument aufrufen (kein Hardcode im Repo — W2).";
  if (!props_().getProperty("TOKEN_SECRET"))
    props_().setProperty("TOKEN_SECRET", Utilities.getUuid() + Utilities.getUuid());
  if (!props_().getProperty("PW_PEPPER"))
    props_().setProperty("PW_PEPPER", Utilities.getUuid() + Utilities.getUuid());
  if (!props_().getProperty("TOKEN_VERSION"))
    props_().setProperty("TOKEN_VERSION", "1");
  const ss = SpreadsheetApp.openById(CONFIG.USERS_SSID || CONFIG.QUEUE_SSID);
  let sh = ss.getSheetByName(CONFIG.USERS_TAB);
  if (!sh){
    sh = ss.insertSheet(CONFIG.USERS_TAB);
    sh.appendRow(["Username","Salt","PasswordHash","Role","VA-ID","Name","Status"]);
  }
  createUser("sandro", adminPassword, "admin", "", "Sandro");
  Logger.log("Setup fertig. Admin 'sandro' angelegt.");
}
function createUser(username, password, role, vaId, name){
  const ss = SpreadsheetApp.openById(CONFIG.USERS_SSID || CONFIG.QUEUE_SSID);
  const sh = ss.getSheetByName(CONFIG.USERS_TAB);
  const salt = Utilities.getUuid();
  const hash = hashPwV2_(salt, password);
  const t = table_(sh);
  const existing = t.rows.find(r => String(r.Username).toLowerCase() === String(username).toLowerCase());
  if (existing) setCells_(sh, t, existing._row, { Salt:salt, PasswordHash:hash, Role:role, "VA-ID":vaId||"", Name:name||username, Status:"aktiv" });
  else sh.appendRow([username, salt, hash, role, vaId||"", name||username, "aktiv"]);
  Logger.log("User gespeichert: " + username);
}
function deactivateUser(username){   // W2: VA-Offboarding — Login sperren
  const ss = SpreadsheetApp.openById(CONFIG.USERS_SSID || CONFIG.QUEUE_SSID);
  const sh = ss.getSheetByName(CONFIG.USERS_TAB);
  const t = table_(sh);
  const row = t.rows.find(r => String(r.Username).toLowerCase() === String(username).toLowerCase());
  if (row) setCells_(sh, t, row._row, { Status:"entfernt" });
  Logger.log("User deaktiviert: " + username);
}
function findUser_(username){
  const ss = SpreadsheetApp.openById(CONFIG.USERS_SSID || CONFIG.QUEUE_SSID);
  const sh = ss.getSheetByName(CONFIG.USERS_TAB);
  if (!sh) return null;
  return table_(sh).rows.find(r => String(r.Username).toLowerCase() === String(username||"").toLowerCase());
}
