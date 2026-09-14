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

// ======================= Agenda fuers Tablet-Dashboard (Kalender lesen + Google Tasks lesen/abhaken) =======================
// Sandro 13.09.2026: der Google-Kalender-Embed zeigt weder Dauer noch Termin-Farben noch Tasks. Darum eine
// eigene Kachel. Termine ueber den Advanced Service "Calendar" (Rohdaten der Calendar API v3), Fallback
// CalendarApp. Tasks ueber den Advanced Service "Tasks". Scopes calendar.readonly + tasks — der Kalender
// wird nie geschrieben; bei Tasks aendert ci_task_done ausschliesslich den Status (abhaken/rueckgaengig,
// Sandro 14.09.2026). Zeitzone Europe/Berlin.
//
// FARBEN — Befund 13.09.2026 abends (Web-UI gegen API-Rohdaten verglichen):
//  1. Google-Kalender-LABELS: Termine tragen `eventLabelId`; Name + Farbe der Labels stehen NICHT am Termin,
//     sondern in Calendars.get(calId).labelProperties.eventLabels[{id, backgroundColor, name?}] (heutige
//     24er-Palette, z. B. Musik #ef6c00, M+P Urlaub #e4c441). Die UI faerbt nach dem Label — CalendarApp
//     kennt Labels nicht (getColor() = ""), deshalb zeigte die erste Version dort die Kalenderfarbe.
//  2. Klassische Termin-Farbe `colorId` 1–11 (bei gelabelten Terminen meist die naechstliegende alte Farbe).
//  3. Ohne beides: Kalenderfarbe. Die API liefert dafuer die ALTE Palette ("#9fe1e7" = Peacock) —
//     Umrechnung auf die heutige Darstellung per CI_KAL_ALT_NEU.
var CI_EVENT_FARBEN = { "1":"#7986cb","2":"#33b679","3":"#8e24aa","4":"#e67c73","5":"#f6bf26","6":"#f4511e",
  "7":"#039be5","8":"#616161","9":"#3f51b5","10":"#0b8043","11":"#d50000",
  PALE_BLUE:"#7986cb", PALE_GREEN:"#33b679", MAUVE:"#8e24aa", PALE_RED:"#e67c73", YELLOW:"#f6bf26",
  ORANGE:"#f4511e", CYAN:"#039be5", GRAY:"#616161", BLUE:"#3f51b5", GREEN:"#0b8043", RED:"#d50000" };
var CI_KAL_ALT_NEU = { "#ac725e":"#795548", "#d06b64":"#e67c73", "#f83a22":"#d50000", "#fa573c":"#f4511e",
  "#ff7537":"#ef6c00", "#ffad46":"#f09300", "#42d692":"#009688", "#16a765":"#0b8043", "#7bd148":"#7cb342",
  "#b3dc6c":"#c0ca33", "#fbe983":"#e4c441", "#fad165":"#f6bf26", "#92e1c0":"#33b679", "#9fe1e7":"#039be5",
  "#9fc6e7":"#4285f4", "#4986e7":"#3f51b5", "#9a9cff":"#7986cb", "#b99aff":"#b39ddb", "#c2c2c2":"#616161",
  "#cabdbf":"#a79b8e", "#cca6ac":"#ad1457", "#f691b2":"#d81b60", "#cd74e6":"#8e24aa", "#a47ae2":"#9e69af" };
var CI_AGENDA_TAGE = 2;   // heute + morgen

function ciHex_(hex){ var h = String(hex || "").toLowerCase(); return /^#[0-9a-f]{6}$/.test(h) ? h : ""; }
function ciKalFarbe_(hex){ var h = ciHex_(hex); return h ? (CI_KAL_ALT_NEU[h] || h) : ""; }
function ciBerlinMitternacht_(isoDatum, tz){
  // "YYYY-MM-DD" als 00:00 Europe/Berlin; Offset des Tages (Mittag UTC) — DST-Randfall irrelevant fuer Ganztags-Termine
  var off = Utilities.formatDate(new Date(isoDatum + "T12:00:00Z"), tz, "XXX");
  return new Date(isoDatum + "T00:00:00" + off);
}
// Termin in jedes beruehrte Fenster-Tagesraster eintragen (mehrtaegige/uebernachtende Termine)
function ciEventVerteilen_(events, start, tz, basis){
  for (var i = 0; i < CI_AGENDA_TAGE; i++){
    var tagStart = start.getTime() + i * 86400000, tagEnde = tagStart + 86400000;
    if (basis.sMs >= tagEnde || basis.eMs <= tagStart) continue;
    events.push({
      t: basis.t, tag: Utilities.formatDate(new Date(tagStart), tz, "yyyy-MM-dd"),
      s: basis.allDay ? "" : Utilities.formatDate(new Date(basis.sMs), tz, "HH:mm"),
      e: basis.allDay ? "" : Utilities.formatDate(new Date(basis.eMs), tz, "HH:mm"),
      sMs: basis.sMs, eMs: basis.eMs, allDay: basis.allDay, farbe: basis.farbe, fq: basis.fq,
      label: basis.label || "", kal: basis.kal
    });
  }
}
// Label-Definitionen eines Kalenders: { labelId: {farbe, name} }. 5 min Cache — Farben aendern sich selten,
// eine Aenderung in Google ist spaetestens nach 5 Minuten auf dem Tablet.
function ciLabels_(calId){
  var c = cache_(), key = "ci_labels_" + Utilities.base64EncodeWebSafe(String(calId)).slice(0, 180);
  var hit = c.get(key);
  if (hit){ try { return JSON.parse(hit); } catch(e){} }
  var map = {};
  try {
    var cal = Calendar.Calendars.get(calId);
    var lp = (cal && cal.labelProperties && cal.labelProperties.eventLabels) || [];
    lp.forEach(function(l){ if (l && l.id) map[l.id] = { farbe: ciHex_(l.backgroundColor), name: String(l.name || "") }; });
  } catch(e){ /* Feiertags-/fremde Kalender haben keine Labels */ }
  try { c.put(key, JSON.stringify(map), 300); } catch(e){}
  return map;
}

// Weg 1: Calendar API v3 ueber den Advanced Service. Wirft, wenn der Dienst fehlt/abgeschaltet ist.
function ciTermineApi_(start, ende, tz){
  var events = [], warnungen = [];
  var liste = Calendar.CalendarList.list({ maxResults: 250, showHidden: false }).items || [];
  liste.forEach(function(k){
    if (k.selected !== true || k.deleted) return;             // nur in der Google-Oberflaeche eingeblendete Kalender
    var kalFarbe = ciKalFarbe_(k.backgroundColor);
    var items = [];
    try {
      var token = null;
      do {
        var r = Calendar.Events.list(k.id, { timeMin: start.toISOString(), timeMax: ende.toISOString(),
          singleEvents: true, orderBy: "startTime", maxResults: 250, pageToken: token || undefined });
        items = items.concat(r.items || []);
        token = r.nextPageToken;
      } while (token && items.length < 500);
    } catch(e){ warnungen.push(String(k.summary || k.id) + ": " + e); return; }
    var labels = null;                                       // erst laden, wenn ein Termin ein Label traegt
    items.forEach(function(ev){
      if (ev.status === "cancelled" || ev.eventType === "workingLocation") return;
      var allDay = !!(ev.start && ev.start.date);
      var sMs = allDay ? ciBerlinMitternacht_(ev.start.date, tz).getTime() : new Date(ev.start.dateTime).getTime();
      var eMs = allDay ? ciBerlinMitternacht_(ev.end.date, tz).getTime() : new Date(ev.end.dateTime).getTime();
      var farbe = "", fq = "", labelName = "";
      if (ev.eventLabelId){
        if (!labels) labels = ciLabels_(k.id);
        var lb = labels[ev.eventLabelId];
        if (lb && lb.farbe){ farbe = lb.farbe; fq = "label"; labelName = lb.name; }
      }
      if (!farbe && ev.colorId && CI_EVENT_FARBEN[String(ev.colorId)]){ farbe = CI_EVENT_FARBEN[String(ev.colorId)]; fq = "colorId"; }
      if (!farbe){ farbe = kalFarbe || "#039be5"; fq = "kalender"; }
      ciEventVerteilen_(events, start, tz, { t: String(ev.summary || "(ohne Titel)"), sMs: sMs, eMs: eMs,
        allDay: allDay, farbe: farbe, fq: fq, label: labelName, kal: String(k.summary || "") });
    });
  });
  return { events: events, warnungen: warnungen };
}

// Weg 2 (Fallback): CalendarApp. Kennt keine Labels — gelabelte Termine bekommen dort nur colorId/Kalenderfarbe.
function ciTermineCalendarApp_(start, ende, tz){
  var events = [], warnungen = [];
  CalendarApp.getAllCalendars().forEach(function(cal){
    var ausgewaehlt = true;
    try { ausgewaehlt = cal.isSelected(); } catch(e){}
    if (!ausgewaehlt) return;
    var kalFarbe = "", kalName = "";
    try { kalFarbe = ciKalFarbe_(cal.getColor()); } catch(e){}
    try { kalName = String(cal.getName() || ""); } catch(e){}
    var liste = [];
    try { liste = cal.getEvents(start, ende); } catch(e){ warnungen.push(kalName + ": " + e); return; }
    liste.forEach(function(ev){
      var f = "";
      try { f = String(ev.getColor() || ""); } catch(e){}
      var allDay = false;
      try { allDay = ev.isAllDayEvent(); } catch(e){}
      ciEventVerteilen_(events, start, tz, { t: String(ev.getTitle() || "(ohne Titel)"),
        sMs: ev.getStartTime().getTime(), eMs: ev.getEndTime().getTime(), allDay: allDay,
        farbe: CI_EVENT_FARBEN[f] || kalFarbe || "#039be5", fq: CI_EVENT_FARBEN[f] ? "colorId" : "kalender", kal: kalName });
    });
  });
  return { events: events, warnungen: warnungen };
}

function ciAgendaDaten_(){
  var tz = "Europe/Berlin";
  var jetzt = new Date();
  var heute = Utilities.formatDate(jetzt, tz, "yyyy-MM-dd");
  var start = ciBerlinMitternacht_(heute, tz);
  var ende = new Date(start.getTime() + CI_AGENDA_TAGE * 86400000);

  var t, quelle = "calendar-api";
  try { t = ciTermineApi_(start, ende, tz); }
  catch(e){
    quelle = "calendarapp (Calendar-API: " + String(e).slice(0, 120) + ")";
    try { t = ciTermineCalendarApp_(start, ende, tz); }
    catch(e2){ t = { events: [], warnungen: ["Kalender: " + e2] }; }
  }
  var events = t.events;
  events.sort(function(a, b){ return (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0) || ((b.allDay ? 1 : 0) - (a.allDay ? 1 : 0)) || (a.sMs - b.sMs); });

  var tasks = [], tasksFehler = "";
  try {
    var dueMax = new Date(ende.getTime()).toISOString();
    var listen = (Tasks.Tasklists.list({ maxResults: 20 }).items) || [];
    listen.forEach(function(l){
      var r = Tasks.Tasks.list(l.id, { showCompleted: false, showHidden: false, maxResults: 100, dueMax: dueMax });
      ((r && r.items) || []).forEach(function(tk){
        if (!tk.due) return;                                   // undatierte Aufgaben nicht aufs Dashboard
        tasks.push({ t: String(tk.title || "(ohne Titel)"), due: String(tk.due).slice(0, 10),
                     liste: String(l.title || ""), notiz: String(tk.notes || "").slice(0, 120),
                     id: String(tk.id || ""), lid: String(l.id || "") });   // IDs fuers Abhaken (ci_task_done)
      });
    });
    tasks.sort(function(a, b){ return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
  } catch(e){ tasksFehler = String(e); }

  return { heute: heute, stand: jetzt.toISOString(), quelle: quelle, events: events.slice(0, 60), tasks: tasks.slice(0, 30),
           warnungen: t.warnungen, tasksFehler: tasksFehler };
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

// Einmal im Script-Editor ausfuehren (Sandro): bewilligt die Scopes (Kalender + Tasks, nur lesen)
// und legt als Beleg os-data/ci-agenda-selftest.json ab. Erst danach wird eine Version mit neuen
// Scopes deployt — so steht die Web-App fuer VAs nie ohne Berechtigung da.
function ciAuthorizeAgenda(){
  var d = ciAgendaDaten_();
  var ergebnis = { lauf: new Date().toISOString(), ok: !d.tasksFehler && !(d.warnungen && d.warnungen.length),
                   quelle: d.quelle, termine: d.events.length, tasks: d.tasks.length, tasksFehler: d.tasksFehler, warnungen: d.warnungen,
                   beispiel: d.events.slice(0, 3).map(function(e){ return e.tag + " " + (e.allDay ? "ganztaegig" : e.s + "-" + e.e) + " " + e.t + " " + e.farbe + " (" + e.fq + ")"; }) };
  var inhalt = JSON.stringify(ergebnis, null, 1);
  try {
    var folder = DriveApp.getFolderById(DZ_IDS.DZ_OSDATA_FOLDER_ID);
    var alt = dzFileInFolder_("CI_AGENDA_SELFTEST_ID", folder, "ci-agenda-selftest.json");
    if (alt) alt.setContent(inhalt); else dzCreateInFolder_("CI_AGENDA_SELFTEST_ID", folder, "ci-agenda-selftest.json", inhalt);
  } catch(e){ Logger.log("Ergebnisdatei nicht schreibbar: " + e); }
  Logger.log(inhalt);
  return ergebnis;
}

// ======================= Aufgaben abhaken (Tablet) =======================
// Sandro 14.09.2026: Aufgabe auf dem Tablet antippen → „Erledigt" → in Google Tasks abgehakt, ohne Umweg
// ueber die Kalender-App. Aendert NUR den Status (completed ↔ needsAction), nie Titel/Datum/Notiz.
// Braucht den Scope tasks (schreiben) statt tasks.readonly = neuer Consent → erst ciAuthorizeTasksSchreiben()
// im Editor, DANN deployen (sonst steht die Web-App fuer alle ohne Berechtigung da).
var CI_TASK_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

function ciTaskSetzen_(lid, id, erledigt){
  var tk = Tasks.Tasks.get(lid, id);
  if (!tk || tk.deleted) throw new Error("Aufgabe nicht gefunden (geloescht?)");
  var ziel = erledigt ? "completed" : "needsAction";
  if (tk.status === ziel) return { status: ziel, schon: true, due: String(tk.due || "").slice(0, 10), um: new Date().toISOString() };
  var r = Tasks.Tasks.patch({ status: ziel }, lid, id);
  return { status: String(r.status || ""), schon: false, due: String(r.due || "").slice(0, 10),
           completed: String(r.completed || ""), um: new Date().toISOString() };
}

function ciTaskDone(body){
  var p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  var lid = String(body.lid || ""), id = String(body.id || "");
  if (!CI_TASK_ID_RE.test(lid) || !CI_TASK_ID_RE.test(id)) return { ok:false, error:"Ungültige Aufgaben-ID." };
  try {
    var r = ciTaskSetzen_(lid, id, body.rueckgaengig !== true);
    r.ok = true;
    return r;
  } catch(e){
    return { ok:false, error:"Aufgabe nicht änderbar: " + e };
  }
}

// Einmal im Script-Editor ausfuehren (Sandro): bewilligt den Schreib-Scope fuer Google Tasks und prueft den
// Abhak-Weg an zwei TESTAUFGABEN (taeglich wiederholend, von Claude vorher in Google Tasks angelegt) — die
// API kennt keine Wiederholungsregel, also wird gemessen, ob Google die Serie beim Abhaken per API fortsetzt:
//   "ZZ Test Abhaken A" → abhaken                  (entsteht die naechste Instanz?)
//   "ZZ Test Abhaken B" → abhaken + rueckgaengig   (bleibt die Serie heil?)
// Beleg: os-data/ci-tasks-selftest.json (Schnappschuesse vorher/zwischen/nachher). Echte Aufgaben fasst er nicht an.
var CI_TASK_TEST_TITEL = ["ZZ Test Abhaken A", "ZZ Test Abhaken B"];

function ciTaskSchnappschuss_(titel){
  var aus = [];
  ((Tasks.Tasklists.list({ maxResults: 20 }).items) || []).forEach(function(l){
    var token = null;
    do {
      var r = Tasks.Tasks.list(l.id, { showCompleted: true, showHidden: true, maxResults: 100, pageToken: token || undefined });
      ((r && r.items) || []).forEach(function(tk){
        if (String(tk.title || "") !== titel) return;
        aus.push({ lid: l.id, id: tk.id, status: tk.status, due: String(tk.due || "").slice(0, 10),
                   completed: String(tk.completed || ""), hidden: !!tk.hidden, updated: String(tk.updated || "") });
      });
      token = r && r.nextPageToken;
    } while (token);
  });
  return aus;
}

function ciAuthorizeTasksSchreiben(){
  var erg = { lauf: new Date().toISOString(), ok: false, schritte: [] };
  try {
    var d = ciAgendaDaten_();
    erg.lesen = { tasks: d.tasks.length, mitIds: d.tasks.filter(function(t){ return t.id && t.lid; }).length, tasksFehler: d.tasksFehler };
    CI_TASK_TEST_TITEL.forEach(function(titel, i){
      var s = { titel: titel, vorher: ciTaskSchnappschuss_(titel) };
      var offen = s.vorher.filter(function(t){ return t.status === "needsAction"; })[0];
      erg.schritte.push(s);
      if (!offen){ s.hinweis = "keine offene Testaufgabe gefunden"; return; }
      s.abhaken = ciTaskSetzen_(offen.lid, offen.id, true);
      Utilities.sleep(4000);
      if (i === 1){
        s.zwischen = ciTaskSchnappschuss_(titel);
        s.rueckgaengig = ciTaskSetzen_(offen.lid, offen.id, false);
        Utilities.sleep(4000);
      }
      s.nachher = ciTaskSchnappschuss_(titel);
    });
    erg.ok = !d.tasksFehler && erg.schritte.every(function(s){ return s.abhaken && s.abhaken.status === "completed"; });
  } catch(e){ erg.fehler = String(e); }
  var inhalt = JSON.stringify(erg, null, 1);
  try {
    var folder = DriveApp.getFolderById(DZ_IDS.DZ_OSDATA_FOLDER_ID);
    var alt = dzFileInFolder_("CI_TASKS_SELFTEST_ID", folder, "ci-tasks-selftest.json");
    if (alt) alt.setContent(inhalt); else dzCreateInFolder_("CI_TASKS_SELFTEST_ID", folder, "ci-tasks-selftest.json", inhalt);
  } catch(e){ Logger.log("Ergebnisdatei nicht schreibbar: " + e); }
  Logger.log(inhalt);
  return erg;
}
