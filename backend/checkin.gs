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

// ======================= Agenda fuers Tablet-Dashboard (Kalender + Google Tasks, NUR lesen) =======================
// Sandro 13.09.2026: der Google-Kalender-Embed zeigt weder Dauer noch Termin-Farben noch Tasks. Darum eine
// eigene Kachel, gefuettert aus CalendarApp + Advanced Service "Tasks" (Scopes calendar.readonly +
// tasks.readonly im Manifest). Nichts wird geschrieben. Zeitzone Europe/Berlin.
var CI_EVENT_FARBEN = { "1":"#7986cb","2":"#33b679","3":"#8e24aa","4":"#e67c73","5":"#f6c026","6":"#f5511d",
  "7":"#039be5","8":"#616161","9":"#3f51b5","10":"#0b8043","11":"#d60000",
  PALE_BLUE:"#7986cb", PALE_GREEN:"#33b679", MAUVE:"#8e24aa", PALE_RED:"#e67c73", YELLOW:"#f6c026",
  ORANGE:"#f5511d", CYAN:"#039be5", GRAY:"#616161", BLUE:"#3f51b5", GREEN:"#0b8043", RED:"#d60000" };
var CI_AGENDA_TAGE = 2;   // heute + morgen

function ciAgendaDaten_(){
  var tz = "Europe/Berlin";
  var jetzt = new Date();
  var heute = Utilities.formatDate(jetzt, tz, "yyyy-MM-dd");
  // Berlin-Mitternacht als Date: Datum + lokaler Offset (XXX = +02:00) -> ISO mit Offset
  var start = new Date(Utilities.formatDate(jetzt, tz, "yyyy-MM-dd'T'00:00:00XXX"));
  var ende = new Date(start.getTime() + CI_AGENDA_TAGE * 86400000);
  var events = [], warnungen = [];
  try {
    CalendarApp.getAllCalendars().forEach(function(cal){
      var ausgewaehlt = true;
      try { ausgewaehlt = cal.isSelected(); } catch(e){}
      if (!ausgewaehlt) return;
      var kalFarbe = "";
      try { kalFarbe = String(cal.getColor() || ""); } catch(e){}
      var kalName = "";
      try { kalName = String(cal.getName() || ""); } catch(e){}
      var liste = [];
      try { liste = cal.getEvents(start, ende); } catch(e){ warnungen.push(kalName + ": " + e); return; }
      liste.forEach(function(ev){
        var f = "";
        try { f = String(ev.getColor() || ""); } catch(e){}
        var farbe = CI_EVENT_FARBEN[f] || (f && f.charAt(0) === "#" ? f : "") || kalFarbe || "#7986cb";
        var allDay = false;
        try { allDay = ev.isAllDayEvent(); } catch(e){}
        var s = ev.getStartTime(), e2 = ev.getEndTime();
        // Mehrtaegige oder uebernachtende Termine an JEDEM Fenstertag zeigen, den sie beruehren
        // (Selftest 13.09.: "M+P Urlaub" begann am 11.09. und haette sonst heute gefehlt).
        for (var i = 0; i < CI_AGENDA_TAGE; i++){
          var tagStart = start.getTime() + i * 86400000, tagEnde = tagStart + 86400000;
          if (s.getTime() >= tagEnde || e2.getTime() <= tagStart) continue;
          events.push({
            t: String(ev.getTitle() || "(ohne Titel)"),
            tag: Utilities.formatDate(new Date(tagStart), tz, "yyyy-MM-dd"),
            s: allDay ? "" : Utilities.formatDate(s, tz, "HH:mm"),
            e: allDay ? "" : Utilities.formatDate(e2, tz, "HH:mm"),
            sMs: s.getTime(), eMs: e2.getTime(), allDay: allDay,
            farbe: farbe, kal: kalName
          });
        }
      });
    });
  } catch(e){ warnungen.push("Kalender: " + e); }
  // Ganztaegige Termine dauern bis zum Folgetag 00:00 -> auf den Starttag beschraenkt anzeigen
  events.sort(function(a, b){ return (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0) || ((b.allDay ? 1 : 0) - (a.allDay ? 1 : 0)) || (a.sMs - b.sMs); });

  var tasks = [], tasksFehler = "";
  try {
    var dueMax = new Date(ende.getTime()).toISOString();
    var listen = (Tasks.Tasklists.list({ maxResults: 20 }).items) || [];
    listen.forEach(function(l){
      var r = Tasks.Tasks.list(l.id, { showCompleted: false, showHidden: false, maxResults: 100, dueMax: dueMax });
      ((r && r.items) || []).forEach(function(t){
        if (!t.due) return;                                   // undatierte Aufgaben nicht aufs Dashboard
        tasks.push({ t: String(t.title || "(ohne Titel)"), due: String(t.due).slice(0, 10),
                     liste: String(l.title || ""), notiz: String(t.notes || "").slice(0, 120) });
      });
    });
    tasks.sort(function(a, b){ return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
  } catch(e){ tasksFehler = String(e); }

  return { heute: heute, stand: jetzt.toISOString(), events: events.slice(0, 60), tasks: tasks.slice(0, 30),
           warnungen: warnungen, tasksFehler: tasksFehler };
}

function ciAgenda(body){
  var p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  try {
    var d = ciAgendaDaten_();
    d.ok = true;
    return d;
  } catch(e){
    return { ok:false, error:"Agenda nicht lesbar: " + e };
  }
}

// Einmal im Script-Editor ausfuehren (Sandro): bewilligt die neuen Scopes (Kalender + Tasks, nur lesen)
// und legt als Beleg os-data/ci-agenda-selftest.json ab. Erst danach wird die neue Version deployt —
// so steht die Web-App fuer VAs nie ohne Berechtigung da.
function ciAuthorizeAgenda(){
  var d = ciAgendaDaten_();
  var ergebnis = { lauf: new Date().toISOString(), ok: !d.tasksFehler && !(d.warnungen && d.warnungen.length),
                   termine: d.events.length, tasks: d.tasks.length, tasksFehler: d.tasksFehler, warnungen: d.warnungen,
                   beispiel: d.events.slice(0, 3).map(function(e){ return e.tag + " " + (e.allDay ? "ganztaegig" : e.s + "-" + e.e) + " " + e.t; }) };
  var inhalt = JSON.stringify(ergebnis, null, 1);
  try {
    var folder = DriveApp.getFolderById(DZ_IDS.DZ_OSDATA_FOLDER_ID);
    var alt = dzFileInFolder_("CI_AGENDA_SELFTEST_ID", folder, "ci-agenda-selftest.json");
    if (alt) alt.setContent(inhalt); else dzCreateInFolder_("CI_AGENDA_SELFTEST_ID", folder, "ci-agenda-selftest.json", inhalt);
  } catch(e){ Logger.log("Ergebnisdatei nicht schreibbar: " + e); }
  Logger.log(inhalt);
  return ergebnis;
}
