/**
 * Tablet-Tracker (neue Tablet-Ansicht #tablet2, Sandro-Auftrag 2026-10-24) — Backend. ADMIN-ONLY.
 * Actions: t2_get (Tagesdaten + Tracker-Messwerte + Schichttage aus dem Kalender) · t2_save (genau eine Aenderung).
 *
 * Zwei Dateien in os-data (agentic-os), jede mit genau EINEM Schreiber — so kollidieren der Drive-Sync des PCs
 * und DriveApp nie auf derselben Datei:
 *   tablet2.json       schreibt nur dieses Backend: Timer-Sitzungen, Deckel-Zaehler, Zigaretten, Korrekturen,
 *                      Workout A/B, Woche (Social-Treffen, Wochenziel, Review), Belohnungsleiter.
 *   tracker-auto.json  schreibt nur der PC (C:\Users\Claude\tracker\aw_tracker.py, alle 15 min per Task Scheduler:
 *                      ActivityWatch + Claude-Code-Transkripte). Das Backend liest sie nur und reicht sie durch.
 * Gerechnet wird im Frontend (t2.js): Business-Zeit = Vereinigung Timer ∪ Tracker-Business-Intervalle (eine
 * manuelle Korrektur gewinnt), Wochensumme, Streaks, Deckel. Das Backend validiert und speichert nur.
 *
 * Tagesgrenze 04:00 Europe/Berlin per Wanduhr wie beim Check-in (ciEffDatum_ in checkin.gs). Woche = Mo–So
 * dieser effektiven Tage, Schluessel = Datum des Montags ("Sonntag 24:00 Reset" = Ende des Sonntags-Tags).
 * Schichttag = Kalendertag, an dem ein Termin "DHL …" ENDET (Nachtschicht 00:40/01:30/02:15 bis 06:15–08:10).
 * Scopes unveraendert (drive + calendar.readonly) — kein neuer Consent noetig.
 */

var T2_DATEI = "tablet2.json";
var T2_AUTO_DATEI = "tracker-auto.json";
var T2_EDIT_TAGE = 7;                         // Korrekturen bis 7 Tage zurueck, Zukunft nie (wie ci_save)
var T2_DECKEL_KEYS = ["games", "folgen", "videos", "zigaretten"];
var T2_SCHICHT_SUCHE = "DHL";
var T2_SCHICHT_RE = /\bDHL\b/i;
var T2_TIMER_MAX_MS = 16 * 3600000;           // vergessener Timer: eine Sitzung zaehlt hoechstens 16 h
var T2_TEXT_MAX = 240;
var T2_NAME_MAX = 80;
var T2_AUTO_TAGE = 70;                        // so viele Tracker-Tage gehen ans Frontend (Streaks bis 56 Tage)

function t2Shift_(iso, n){ return new Date(ciTagUtc_(iso) + n * 86400000).toISOString().slice(0, 10); }
function t2Wtag_(iso){ return new Date(ciTagUtc_(iso)).getUTCDay(); }
function t2Montag_(iso){ return t2Shift_(iso, -((t2Wtag_(iso) + 6) % 7)); }
// "YYYY-MM-DD" + "HH:mm" Berliner Wanduhr -> ms. Offset vom Mittag des Tages: an DST-Tagen gilt um 04:00 schon der neue.
function t2BerlinMs_(iso, hhmm){
  var off = Utilities.formatDate(new Date(iso + "T12:00:00Z"), "Europe/Berlin", "XXX");
  return new Date(iso + "T" + hhmm + ":00" + off).getTime();
}
function t2EffDatumVon_(ms){
  var d = new Date(ms);
  var datum = Utilities.formatDate(d, "Europe/Berlin", "yyyy-MM-dd");
  if (Number(Utilities.formatDate(d, "Europe/Berlin", "H")) < 4) datum = t2Shift_(datum, -1);
  return datum;
}

function t2Leer_(heute){
  return { version: 1, start: heute, timer: { laeuft: null }, tage: {}, wochen: {},
           leiter: { kirei_ml: false, erreicht: { coaching: null, latzug: null },
                     ziele: [1, 2, 3, 4].map(function(n){ return { name: "Business-Ziel " + n, ok: false }; }) } };
}
// Fehlende Felder ergaenzen (aeltere/handgepflegte Datei), nie vorhandene Werte ueberschreiben.
function t2Normalisieren_(d, heute){
  var leer = t2Leer_(heute);
  if (!d || typeof d !== "object") return leer;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.start || ""))) d.start = heute;
  if (!d.timer || typeof d.timer !== "object") d.timer = { laeuft: null };
  if (!d.tage || typeof d.tage !== "object") d.tage = {};
  if (!d.wochen || typeof d.wochen !== "object") d.wochen = {};
  if (!d.leiter || typeof d.leiter !== "object") d.leiter = leer.leiter;
  if (!d.leiter.erreicht || typeof d.leiter.erreicht !== "object") d.leiter.erreicht = { coaching: null, latzug: null };
  if (!Array.isArray(d.leiter.ziele) || d.leiter.ziele.length !== 4) d.leiter.ziele = leer.leiter.ziele;
  d.leiter.kirei_ml = d.leiter.kirei_ml === true;
  return d;
}

function t2Dateien_(){
  var fid = dzFolderId_("DZ_OSDATA_FOLDER_ID", "os-data", ["agentic-os"]);
  if (!fid) return { err: "os-data-Ordner nicht im Drive gefunden." };
  var folder = DriveApp.getFolderById(fid);
  return { folder: folder, file: dzFileInFolder_("T2_FILE_ID", folder, T2_DATEI) };
}
function t2Json_(file){
  if (!file) return null;
  try { return JSON.parse(file.getBlob().getDataAsString("UTF-8")); } catch(e){ return null; }
}
// Tracker-Datei vom PC: nur die juengsten T2_AUTO_TAGE Tage weiterreichen. Fehlt sie (Tracker noch nicht
// eingerichtet, PC lange aus), gibt es auto=null — das Frontend zeigt dann nur Timer + manuelle Werte.
function t2Auto_(folder){
  try {
    var a = t2Json_(dzFileInFolder_("T2_AUTO_FILE_ID", folder, T2_AUTO_DATEI));
    if (!a || typeof a !== "object") return null;
    var tage = a.tage || {}, keys = Object.keys(tage).sort(), raus = {};
    keys.slice(-T2_AUTO_TAGE).forEach(function(k){ raus[k] = tage[k]; });
    a.tage = raus;
    return a;
  } catch(e){ return null; }
}

// DHL-Schichten von heute-8 bis morgen aus dem Hauptkalender, 15 min gecacht. Schluessel = Kalendertag des
// Schichtendes (00:40–06:15 am 26. -> Schichttag 26.; das Spiel-Verbot gilt dann ab 07:00 bis Tagesende 04:00).
function t2Schichten_(heute){
  var c = cache_(), key = "t2_schichten_" + heute, hit = c.get(key);
  if (hit){ try { return JSON.parse(hit); } catch(e){} }
  var tz = "Europe/Berlin";
  var start = ciBerlinMitternacht_(t2Shift_(heute, -8), tz), ende = ciBerlinMitternacht_(t2Shift_(heute, 2), tz);
  var tage = {}, fehler = "";
  var eintragen = function(titel, sMs, eMs){
    if (!T2_SCHICHT_RE.test(titel) || !(eMs > sMs)) return;
    var tag = Utilities.formatDate(new Date(eMs - 1), tz, "yyyy-MM-dd");
    (tage[tag] = tage[tag] || []).push({ s: Utilities.formatDate(new Date(sMs), tz, "HH:mm"),
      e: Utilities.formatDate(new Date(eMs), tz, "HH:mm"), sMs: sMs, eMs: eMs });
  };
  try {
    var r = Calendar.Events.list("primary", { timeMin: start.toISOString(), timeMax: ende.toISOString(),
      singleEvents: true, orderBy: "startTime", q: T2_SCHICHT_SUCHE, maxResults: 100 });
    (r.items || []).forEach(function(ev){
      if (ev.status === "cancelled" || !ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) return;
      eintragen(String(ev.summary || ""), new Date(ev.start.dateTime).getTime(), new Date(ev.end.dateTime).getTime());
    });
  } catch(e){
    fehler = "Calendar-API: " + String(e).slice(0, 160);
    try {
      CalendarApp.getDefaultCalendar().getEvents(start, ende, { search: T2_SCHICHT_SUCHE }).forEach(function(ev){
        if (ev.isAllDayEvent()) return;
        eintragen(String(ev.getTitle() || ""), ev.getStartTime().getTime(), ev.getEndTime().getTime());
      });
      fehler = "";
    } catch(e2){ fehler += " · CalendarApp: " + String(e2).slice(0, 160); }
  }
  var erg = { tage: tage, fehler: fehler };
  if (!fehler){ try { c.put(key, JSON.stringify(erg), 900); } catch(e){} }
  return erg;
}

function t2Get(body){
  var p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  var d = t2Dateien_();
  if (d.err) return { ok:false, error:d.err };
  var heute = ciEffDatum_();
  return { ok:true, heute: heute, jetzt: Date.now(), daten: t2Normalisieren_(t2Json_(d.file), heute),
           auto: t2Auto_(d.folder), schichten: t2Schichten_(heute) };
}

// ---------- Aenderungen (eine pro Aufruf; Validierung streng, sonst klare Fehlermeldung) ----------
function t2DatumOk_(datum, heute){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(datum || ""))) return "Datum fehlt oder ist kein YYYY-MM-DD.";
  var diff = Math.round((ciTagUtc_(heute) - ciTagUtc_(datum)) / 86400000);
  if (isNaN(diff) || diff < 0 || diff > T2_EDIT_TAGE) return "Datum ausserhalb des Fensters (heute bis " + T2_EDIT_TAGE + " Tage zurueck).";
  return "";
}
function t2Tag_(daten, datum){ return daten.tage[datum] = daten.tage[datum] || {}; }
function t2Aufraeumen_(daten, datum){
  var t = daten.tage[datum];
  if (t && Object.keys(t).length === 0) delete daten.tage[datum];
}
// Laufende Sitzung [s,e] an den 04:00-Grenzen auf die effektiven Tage verteilen
function t2SitzungEintragen_(daten, s, e){
  while (s < e){
    var tag = t2EffDatumVon_(s);
    var grenze = t2BerlinMs_(t2Shift_(tag, 1), "04:00");
    var bis = Math.min(e, grenze);
    var t = t2Tag_(daten, tag);
    (t.timer = t.timer || []).push([s, bis]);
    s = bis;
  }
}
function t2NaechsterTyp_(daten, datum){
  var vorher = Object.keys(daten.tage).filter(function(k){ return k < datum && daten.tage[k].workout; }).sort();
  if (!vorher.length) return "A";
  return daten.tage[vorher[vorher.length - 1]].workout.typ === "A" ? "B" : "A";
}

function t2Anwenden_(daten, body, heute){
  var op = String(body.op || ""), jetzt = Date.now(), fehler, t;
  var datum = String(body.datum || "");

  if (op === "timer_start"){
    if (!daten.timer.laeuft) daten.timer.laeuft = new Date(jetzt).toISOString();
    return "";
  }
  if (op === "timer_stop" || op === "timer_verwerfen"){
    var lief = daten.timer.laeuft ? Date.parse(daten.timer.laeuft) : NaN;
    daten.timer.laeuft = null;
    if (op === "timer_verwerfen" || isNaN(lief)) return "";
    var s = Math.round(lief / 1000) * 1000, e = Math.round(Math.min(jetzt, lief + T2_TIMER_MAX_MS) / 1000) * 1000;
    if (e > s) t2SitzungEintragen_(daten, s, e);
    return "";
  }
  if (op === "sitzung_loeschen"){
    if ((fehler = t2DatumOk_(datum, heute))) return fehler;
    t = daten.tage[datum];
    var idx = Number(body.idx);
    if (!t || !Array.isArray(t.timer) || !(idx >= 0 && idx < t.timer.length) || Math.floor(idx) !== idx) return "Sitzung nicht gefunden.";
    t.timer.splice(idx, 1);
    if (!t.timer.length) delete t.timer;
    t2Aufraeumen_(daten, datum);
    return "";
  }
  if (op === "zaehler"){
    if ((fehler = t2DatumOk_(datum, heute))) return fehler;
    var key = String(body.key || ""), delta = Number(body.delta);
    if (T2_DECKEL_KEYS.indexOf(key) < 0) return "Unbekannter Zaehler.";
    if (delta !== 1 && delta !== -1) return "Delta muss +1 oder -1 sein.";
    t = t2Tag_(daten, datum);
    t.z = t.z || {};
    t.z[key] = Math.max(0, Math.min(99, (Number(t.z[key]) || 0) + delta));
    if (!t.z[key]) delete t.z[key];
    if (!Object.keys(t.z).length) delete t.z;
    t2Aufraeumen_(daten, datum);
    return "";
  }
  if (op === "setzen"){
    if ((fehler = t2DatumOk_(datum, heute))) return fehler;
    var feld = String(body.feld || ""), w = body.wert, leer = (w === null || w === undefined || w === "");
    t = t2Tag_(daten, datum);
    if (feld === "typ"){
      if (!leer && w !== "schicht" && w !== "frei") return "Tagestyp muss schicht oder frei sein.";
    } else if (feld === "aufstehzeit"){
      if (!leer){
        var m = /^(\d{2}):(\d{2})$/.exec(String(w));
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "Aufstehzeit als HH:MM.";
      }
    } else if (feld === "business_min"){
      if (!leer){ w = Math.round(Number(w)); if (isNaN(w) || w < 0 || w > 1440) return "Business-Minuten zwischen 0 und 1440."; }
    } else if (feld === "games_korr"){
      if (!leer){ w = Number(w); if (isNaN(w) || w < 0 || w > 30 || Math.floor(w) !== w) return "Games als ganze Zahl 0–30."; }
    } else return "Unbekanntes Feld.";
    if (leer) delete t[feld]; else t[feld] = w;
    t2Aufraeumen_(daten, datum);
    return "";
  }
  if (op === "workout"){
    if ((fehler = t2DatumOk_(datum, heute))) return fehler;
    t = t2Tag_(daten, datum);
    if (body.erledigt === true){
      var typ = (body.typ === "A" || body.typ === "B") ? body.typ : t2NaechsterTyp_(daten, datum);
      t.workout = { typ: typ, um: new Date(jetzt).toISOString() };
    } else delete t.workout;
    t2Aufraeumen_(daten, datum);
    return "";
  }
  if (op === "woche"){
    var montag = String(body.montag || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(montag) || t2Wtag_(montag) !== 1) return "Woche: Montag als YYYY-MM-DD.";
    var abstand = Math.round((ciTagUtc_(montag) - ciTagUtc_(t2Montag_(heute))) / 86400000);
    if (abstand < -7 || abstand > 7) return "Nur Vorwoche, diese oder naechste Woche.";
    var wf = String(body.feld || ""), wert = body.wert;
    var wo = daten.wochen[montag] = daten.wochen[montag] || {};
    if (wf === "social"){
      if (wert === null || wert === "") delete wo.social;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(wert))) wo.social = String(wert);
      else return "Social-Treffen als Datum.";
    } else if (wf === "ziel"){
      var txt = String(wert || "").replace(/\s+/g, " ").trim().slice(0, T2_TEXT_MAX);
      if (txt) wo.ziel = txt; else delete wo.ziel;
    } else if (wf === "review"){
      if (wert === true) wo.review_um = new Date(jetzt).toISOString(); else delete wo.review_um;
    } else return "Unbekanntes Wochenfeld.";
    if (!Object.keys(wo).length) delete daten.wochen[montag];
    return "";
  }
  if (op === "leiter"){
    var lf = String(body.feld || "");
    if (lf === "kirei_ml"){ daten.leiter.kirei_ml = body.wert === true; return ""; }
    var zm = /^ziel([1-4])$/.exec(lf);
    if (!zm) return "Unbekanntes Leiter-Feld.";
    daten.leiter.ziele[Number(zm[1]) - 1].ok = body.wert === true;
    return "";
  }
  if (op === "ziel_name"){
    var nr = Number(body.nr), name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, T2_NAME_MAX);
    if (!(nr >= 1 && nr <= 4) || Math.floor(nr) !== nr) return "Ziel-Nummer 1–4.";
    daten.leiter.ziele[nr - 1].name = name || ("Business-Ziel " + nr);
    return "";
  }
  if (op === "erreicht"){
    var ef = String(body.feld || "");
    if (ef !== "coaching" && ef !== "latzug") return "Unbekannte Stufe.";
    if ((fehler = t2DatumOk_(datum, heute))) return fehler;
    if (!daten.leiter.erreicht[ef]) daten.leiter.erreicht[ef] = datum;   // einmal erreicht bleibt erreicht
    return "";
  }
  return "Unbekannte Aenderung.";
}

function t2Save(body){
  var p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var d = t2Dateien_();
    if (d.err) return { ok:false, error:d.err };
    var heute = ciEffDatum_();
    var daten = t2Normalisieren_(t2Json_(d.file), heute);
    var fehler = t2Anwenden_(daten, body, heute);
    if (fehler) return { ok:false, error:fehler };
    daten.geaendert = new Date().toISOString();
    var inhalt = JSON.stringify(daten, null, 1);
    if (d.file) d.file.setContent(inhalt);
    else dzCreateInFolder_("T2_FILE_ID", d.folder, T2_DATEI, inhalt);
    return { ok:true, heute: heute, jetzt: Date.now(), daten: daten };
  } finally { lock.releaseLock(); }
}
