/**
 * Daily Check-in — Backend-Erweiterung der QC-Review-App. ADMIN-ONLY (Sandro).
 * Actions: ci_get (Eintraege + effektives Datum + Kalender-Soll) · ci_save (Tages-Eintrag schreiben).
 *
 * Zweck: Minimaltag-System (definiert 2026-08-25, Memory project_musik_dj_producing):
 *   gruen = Kernblock erledigt · joker = vorher deklarierter Aus-Tag · rot = ungeplant nichts.
 *   Regel: nie zwei rote Tage in Folge. Streak/Matrix rechnet das Frontend (ci.js).
 *
 * Seit 2026-09-10 (Sandro-Feedback): Business wird in STUNDEN erfasst (Feld `stunden`, Viertel-
 *   stunden, 0–24). `kernblock` wird daraus abgeleitet (ab CI_KERNBLOCK_H) und bleibt als Feld
 *   erhalten — fuer alte Eintraege (ohne `stunden`) und den Wochenreport-Task. Fehlt `stunden`
 *   (alter, gecachter Client), gilt `kernblock` wie bisher.
 * Kalender-Soll: os-data/checkin-soll.json (regeln je Item als Wochentagsliste 0=So..6=Sa +
 *   ausnahmen je Datum, z. B. Musik an Spaetschicht-Tagen geloescht) — gepflegt vom Scheduled Task
 *   kalender-schichtregeln. ci_get liefert die Datei unveraendert als `soll` mit (null, wenn sie
 *   fehlt oder nicht parsebar ist — das Frontend nimmt dann seine Standardregeln).
 *
 * Ablage: os-data/checkins.json im Drive (agentic-os) — ein Objekt { "YYYY-MM-DD": {eintrag} }.
 * ci_save ersetzt den Tages-Schluessel komplett: idempotent, der letzte Eintrag pro Tag gewinnt.
 * Der Drive-Sync bringt die Datei auf den PC (G:\...\agentic-os\os-data\), dort auswertbar.
 *
 * Datumsgrenze 04:00 Europe/Berlin: Sandros Tag endet erst gegen 01:00 (DHL-Nachtschicht,
 * Schlaf 07-15 Uhr) — ein Check-in um 00:45 gehoert zum VORHERIGEN Tag. Definition bewusst
 * ueber die WANDUHR (Berlin-Stunde < 4 -> Vortag), nicht als "jetzt minus 4 h": Letzteres
 * wuerde in den zwei DST-Umstellungsnaechten die Grenze auf 03:00 bzw. 05:00 verschieben.
 */

var CI_STATUS = ["gruen", "joker", "rot"];
var CI_NOTIZ_MAX = 2000;      // Diktat-Notizen bleiben kurz; Grenze gegen versehentliche Riesen-Pastes
var CI_BACKFILL_TAGE = 7;     // Nachtragen erlaubt bis 7 Tage zurueck, Zukunft nie
var CI_KERNBLOCK_H = 3;       // Kernblock = ab 3 h Business (Definition 25.08.; 3 h zaehlen mit)
var CI_STUNDEN_MAX = 24;

function ciEffDatum_(){
  var jetzt = new Date();
  var datum = Utilities.formatDate(jetzt, "Europe/Berlin", "yyyy-MM-dd");
  if (Number(Utilities.formatDate(jetzt, "Europe/Berlin", "H")) < 4)
    datum = new Date(ciTagUtc_(datum) - 86400000).toISOString().slice(0, 10);
  return datum;
}
function ciTagUtc_(iso){ return Date.parse(iso + "T00:00:00Z"); }

// checkins.json im os-data-Ordner: gleiche ID-Cache-Mechanik wie eskalationen-ack.json
// (dzFileInFolder_ prueft isTrashed und heilt veraltete Property-IDs).
function ciDatei_(){
  var fid = dzFolderId_("DZ_OSDATA_FOLDER_ID", "os-data", ["agentic-os"]);
  if (!fid) return { err: "os-data-Ordner nicht im Drive gefunden." };
  var folder = DriveApp.getFolderById(fid);
  return { folder: folder, file: dzFileInFolder_("CI_FILE_ID", folder, "checkins.json") };
}
function ciLesen_(file){
  if (!file) return {};
  try { return JSON.parse(file.getBlob().getDataAsString("UTF-8")) || {}; }
  catch(e){ return {}; }
}
// Kalender-Soll (optional). Nie hart scheitern: fehlt die Datei oder ist sie kaputt, gibt es null
// und das Frontend rechnet mit seinen Standardregeln (Business Mo–Fr+So, Musik/Sport taeglich).
function ciSoll_(folder){
  try {
    var f = dzFileInFolder_("CI_SOLL_FILE_ID", folder, "checkin-soll.json");
    if (!f) return null;
    var s = JSON.parse(f.getBlob().getDataAsString("UTF-8"));
    return (s && typeof s === "object") ? s : null;
  } catch(e){ return null; }
}

function ciGet(body){
  var p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  var d = ciDatei_();
  if (d.err) return { ok:false, error:d.err };
  return { ok:true, days: ciLesen_(d.file), heute: ciEffDatum_(), soll: ciSoll_(d.folder) };
}

function ciSave(body){
  var p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };

  var datum = String(body.datum||"").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum)) return { ok:false, error:"Datum fehlt oder ist kein YYYY-MM-DD." };
  var heute = ciEffDatum_();
  var diff = Math.round((ciTagUtc_(heute) - ciTagUtc_(datum)) / 86400000);
  if (isNaN(diff) || diff < 0 || diff > CI_BACKFILL_TAGE)
    return { ok:false, error:"Datum ausserhalb des Fensters (heute bis " + CI_BACKFILL_TAGE + " Tage zurueck)." };

  // Business-Stunden (optional fuer alte Clients). Viertelstunden, 0–24.
  var stunden = null;
  if (body.stunden !== undefined && body.stunden !== null && body.stunden !== ""){
    stunden = Number(body.stunden);
    if (isNaN(stunden) || stunden < 0 || stunden > CI_STUNDEN_MAX)
      return { ok:false, error:"Stunden muessen zwischen 0 und " + CI_STUNDEN_MAX + " liegen." };
    stunden = Math.round(stunden * 4) / 4;
  }
  // Kernblock ergibt sich aus den Stunden; ohne Stunden gilt das gesendete Feld (Alt-Client).
  var kernblock = (stunden === null) ? (body.kernblock === true) : (stunden >= CI_KERNBLOCK_H);
  if (stunden !== null && typeof body.kernblock === "boolean" && body.kernblock !== kernblock)
    return { ok:false, error:"Inkonsistent: Kernblock ergibt sich aus den Stunden (ab " + CI_KERNBLOCK_H + " h)." };

  var status = String(body.status||"");
  if (CI_STATUS.indexOf(status) < 0) return { ok:false, error:"Status muss gruen, joker oder rot sein." };
  // Konsistenz-Guard (Sandro-Feedback 25.08.: Status wird aus dem Kernblock ABGELEITET, nie
  // widerspruechlich): kernblock=ja gehoert zu gruen, kernblock=nein zu joker/rot.
  if (kernblock && status !== "gruen")
    return { ok:false, error:"Inkonsistent: Kernblock erledigt => Tag ist gruen." };
  if (!kernblock && status === "gruen")
    return { ok:false, error:"Inkonsistent: gruen setzt einen erledigten Kernblock voraus." };

  var eintrag = { status: status, kernblock: kernblock };
  if (stunden !== null) eintrag.stunden = stunden;
  eintrag.musik = body.musik === true;
  eintrag.sport = body.sport === true;     // wie Musik: reine Statistik, zaehlt nicht fuer die Streak
  eintrag.notiz = String(body.notiz||"").trim().slice(0, CI_NOTIZ_MAX);
  eintrag.gespeichert = new Date().toISOString();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var d = ciDatei_();
    if (d.err) return { ok:false, error:d.err };
    var days = ciLesen_(d.file);
    days[datum] = eintrag;                          // letzter Eintrag pro Tag gewinnt
    var inhalt = JSON.stringify(days, null, 1);
    if (d.file) d.file.setContent(inhalt);
    else dzCreateInFolder_("CI_FILE_ID", d.folder, "checkins.json", inhalt);
    return { ok:true, days: days, heute: heute, soll: ciSoll_(d.folder) };
  } finally { lock.releaseLock(); }
}
