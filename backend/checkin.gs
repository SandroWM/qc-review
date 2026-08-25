/**
 * Daily Check-in — Backend-Erweiterung der QC-Review-App. ADMIN-ONLY (Sandro).
 * Actions: ci_get (Eintraege + effektives Datum) · ci_save (Tages-Eintrag schreiben).
 *
 * Zweck: Minimaltag-System (definiert 2026-08-25, Memory project_musik_dj_producing):
 *   gruen = Kernblock erledigt · joker = vorher deklarierter Aus-Tag · rot = ungeplant nichts.
 *   Regel: nie zwei rote Tage in Folge. Streak/Kacheln rechnet das Frontend (ci.js).
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

function ciGet(body){
  var p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  var d = ciDatei_();
  if (d.err) return { ok:false, error:d.err };
  return { ok:true, days: ciLesen_(d.file), heute: ciEffDatum_() };
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

  var status = String(body.status||"");
  if (CI_STATUS.indexOf(status) < 0) return { ok:false, error:"Status muss gruen, joker oder rot sein." };
  // Konsistenz-Guard (Sandro-Feedback 25.08.: Status wird aus dem Kernblock ABGELEITET, nie
  // widerspruechlich): kernblock=ja gehoert zu gruen, kernblock=nein zu joker/rot.
  if (body.kernblock === true && status !== "gruen")
    return { ok:false, error:"Inkonsistent: Kernblock erledigt => Tag ist gruen." };
  if (body.kernblock !== true && status === "gruen")
    return { ok:false, error:"Inkonsistent: gruen setzt einen erledigten Kernblock voraus." };

  var eintrag = {
    status: status,
    kernblock: body.kernblock === true,
    musik: body.musik === true,
    sport: body.sport === true,     // wie Musik: reine Statistik, zaehlt nicht fuer die Streak
    notiz: String(body.notiz||"").trim().slice(0, CI_NOTIZ_MAX),
    gespeichert: new Date().toISOString()
  };

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
    return { ok:true, days: days, heute: heute };
  } finally { lock.releaseLock(); }
}
