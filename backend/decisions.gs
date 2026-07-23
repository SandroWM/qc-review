/**
 * Entscheidungszentrale — Backend-Erweiterung der QC-Review-App. ADMIN-ONLY (Sandro).
 * Actions: dz_list (offene Gates + Kontext) · dz_decide (Entscheidung schreiben) · dz_cockpit (OS-Snapshot).
 *
 * Grundlage: Gate-Recherche 2026-07-17 ueber alle 106 SOPs — dokumentiert in
 * agentic-os/ENTSCHEIDUNGSZENTRALE-GATES.md. Drei Gate-Klassen:
 *   K1  direkte Entscheidungs-Spalten (Check-Status / Entscheidung-Sandro / Status) -> hier entscheidbar
 *   K2  Eskalations-Flows ohne eigenes Feld (Mahnung, Support) -> Entscheid als strukturierter Notiz-Append
 *   K3  laeuft ueber sheet-60 / die bestehende Review-UI -> hier NUR als Zaehler gespiegelt (dzQcSpiegel_)
 *
 * Leitplanken (bewusst):
 *  - Feld-ALLOWLIST: geschrieben wird ausschliesslich die im Gate deklarierte Entscheidungs-Spalte
 *    (+ Notiz-Append). Nie andere Spalten, nie Schema-Aenderungen, sheet-50 wird NIE angefasst.
 *  - Ein Klick schreibt exakt den Wert, den Sandro auch manuell ins Sheet tippen wuerde — fuer den
 *    Orchestrator ununterscheidbar, darum kein Bodo-Koordinationsfall (Sandro-Entscheid 2026-07-17).
 *  - AUDIT: jede Schreibaktion landet als Zeile in einem privaten Audit-Spreadsheet (My Drive, auto-angelegt).
 *  - Fingerprint-Schutz: decide verifiziert, dass die Zeile seit dem Listen unveraendert ist (kein Blind-Write).
 *  - Live-Header koennen von der Spec driften (Lehre sheet-50): fehlende Sheets/Spalten werden als Warnung
 *    GEMELDET, nie still uebersprungen.
 *
 * Sheet-IDs kommen zur Laufzeit aus sheets-sync/sheet-registry.json im Shared Drive (SSOT, kein Hardcode);
 * der OS-Snapshot (summary.json) wird direkt aus dem Drive gelesen — beide via drive.readonly (Scope vorhanden).
 */

// ======================= Gate-Registry (deklarativ) =======================
// apply: "col" = Entscheidungs-Spalte setzen · "notiz" = nur strukturierter Notiz-Append (kein eigenes Feld)
//        "support" = sheet-66-Sonderfall (Notiz immer, Status nur wenn beantwortet/geschlossen gewaehlt)
// typ:   "entscheidung" = wartet auf Sandro (Rueckstau-Alarm) · "aktion" = jederzeit ausloesbar, kein Rueckstau
// kontext/titelCols: Spalten-KANDIDATEN — vorhandene werden gezeigt, fehlende stillschweigend weggelassen
//                    (Live-Header != Spec kommt vor; die Entscheidungs-Spalte selbst wird dagegen HART geprueft).
const DZ_GATES = [
  { id:"audience-baseline", titel:"Audience-Baseline freigeben", sop:"sop-01-08-zielgruppenanalyse-baseline",
    slug:"sheet-05-zielgruppenanalyse-baseline", typ:"entscheidung", apply:"col",
    frage:"Pain/Desire-Baseline korrekt? Approved entriegelt 8 nachgelagerte SOPs.",
    decision:{ col:"Check-Status", offenWert:"Pending", werte:["Approved","Revision"] },
    kommentarPflicht:["Revision"],
    offen:function(r){ return String(r["Check-Status"])==="Pending"; },
    titelCols:["Baseline-ID","Pain-Point"],
    kontext:["Pain-Point","Desire","Branchen-Tag","Demographic-Tag","Pain-Tiefe","Desire-Tiefe","Marketing-Winkel-Vorschlag","Audience-Segment","Notiz"] },

  { id:"ai-persona", titel:"AI-Persona freigeben", sop:"sop-01-02-persona-ai-erstellen",
    slug:"sheet-01-persona-stack", typ:"entscheidung", apply:"col",
    frage:"Persona-Konzept dieses AI-Creators freigeben?",
    decision:{ col:"Check-Status", offenWert:"Pending", werte:["Approved","Revision","Rejected"] },
    kommentarPflicht:["Revision","Rejected"],
    offen:function(r){ return String(r["Check-Status"])==="Pending" && String(r["Creator-Typ"])==="AI"; },
    titelCols:["Creator-ID","Creator-Name","Name"],
    kontext:["Creator-Name","Creator-Typ","Creator-Zweck","Look-Hebel","Dominante-Körper-Stärke","Brand-Voice","Nischen-Vorschläge","Agency-Name","Notiz"] },

  { id:"nischen-lexikon", titel:"Nischen-Lexikon freigeben", sop:"sop-01-16-nischen-lexikon-erstellen",
    slug:"sheet-13-nischen-lexikon", typ:"entscheidung", apply:"col",
    frage:"Nischen-Eintrag (Slang/Items/Tabus) korrekt?",
    decision:{ col:"Check-Status", offenWert:"Pending", werte:["Approved","Revision"] },
    kommentarPflicht:["Revision"],
    offen:function(r){ return String(r["Check-Status"])==="Pending"; },
    titelCols:["Nischen-ID","Nische","Nischen-Name"],
    kontext:["Nische","Nischen-Name","Slang","Items","Outfits","Settings","Tabuwörter","Tabu-Woerter","Notiz"] },

  { id:"split-test", titel:"Split-Test skalieren", sop:"sop-09-03-split-test-vergleich",
    slug:"sheet-53-split-test-tracking", typ:"entscheidung", apply:"col",
    frage:"28-Tage-Test ist ausgewertet — Empfehlung folgen?",
    decision:{ col:"Entscheidung-Sandro", offenWert:"offen", werte:["bestaetigt","abweichend","verschoben"] },
    kommentarPflicht:["abweichend"],
    offen:function(r){ return String(r["Status"])==="abgeschlossen" && String(r["Entscheidung-Sandro"])==="offen"; },
    titelCols:["Test-ID","Creator-ID"],
    kontext:["Creator-ID","Gewinner-Arm","Delta-Prozent","Empfehlung","Konfidenz-Hinweis","Primaer-KPI-build","Primaer-KPI-marketing","Link-Klicks-build","Link-Klicks-marketing","Notiz"] },

  { id:"contentsaeulen", titel:"Contentsäulen-Bewertung bestätigen", sop:"sop-01-37-contentsaeulen-bewertung",
    slug:"sheet-14-contentsaeulen-und-topic-pro-persona", typ:"entscheidung", apply:"col",
    frage:"Säulen-Verdikte + Posting-Anteile dieses Creators bestätigen?",
    decision:{ col:"Check-Status", offenWert:"Pending", werte:["Approved","Revision"] },
    kommentarPflicht:["Revision"],
    offen:function(r){ return String(r["Check-Status"])==="Pending"; },
    titelCols:["Creator-ID","Saeule","Säule"],
    kontext:["Creator-ID","Saeule","Säule","Topic","Posting-Anteil-Prozent","Verdikt","Notiz"] },

  { id:"hooks", titel:"Neue Hooks freigeben", sop:"sop-01-21-taktiken-database-hooks-updaten",
    slug:"sheet-20-hook-library", typ:"entscheidung", apply:"col",
    frage:"Neuer Hook — aktiv schalten, erst testen oder archivieren?",
    decision:{ col:"Status", offenWert:"Neu", werte:["Aktiv","Test","Archiviert"] },
    kommentarPflicht:[],
    offen:function(r){ return String(r["Status"])==="Neu"; },
    titelCols:["Hook-ID","Hook"],
    kontext:["Hook","Hook-Text","hook_text","taktik_typ","creator_typ_tags","creator_typ_tags_ausschluss","Quelle","Notiz"] },

  { id:"taktiken", titel:"Neue Taktiken freigeben", sop:"sop-01-22-taktiken-database-taktiken-erfassen",
    slug:"sheet-21-taktiken-library", typ:"entscheidung", apply:"col",
    frage:"Neue Taktik — testen, aktiv schalten oder archivieren?",
    decision:{ col:"Status", offenWert:"Neu", werte:["Test","Aktiv","Archiviert"] },
    kommentarPflicht:[],
    offen:function(r){ return String(r["Status"])==="Neu"; },
    titelCols:["Taktik-ID","Taktik"],
    kontext:["Taktik","Taktik-Text","taktik_typ","creator_typ_tags","Quelle","Notiz"] },

  { id:"dpa", titel:"Tool-DPA entscheiden", sop:"sop-09-01-compliance-eu-ai-act",
    slug:"sheet-42-ai-tool-list", typ:"entscheidung", apply:"col",
    frage:"Datenschutz-DPA dieses Tools: unterschrieben, nicht anwendbar oder blockieren? (Frist: 2026-08-02)",
    decision:{ col:"Datenschutz-DPA", offenWert:"pending", werte:["unterschrieben","nicht-anwendbar","blockiert"] },
    kommentarPflicht:["nicht-anwendbar","blockiert"],
    offen:function(r){ return String(r["Datenschutz-DPA"])==="pending"; },
    titelCols:["Tool-ID","Tool","Tool-Name"],
    kontext:["Tool","Tool-Name","Anbieter","Zweck","Kategorie","Check-Status","Quelle","Notiz"] },

  { id:"mahnstufe2", titel:"Mahnstufe 2 — Kündigung / Stundung / Inkasso", sop:"sop-09-09-rechnungsstellung-mahnwesen",
    slug:"sheet-67-rechnungs-log", typ:"entscheidung", apply:"notiz",
    frage:"Rechnung ist 21+ Tage ueberfaellig (Mahnstufe 2). Wie weiter? Der Agent vollzieht deinen Entscheid (D17).",
    decision:{ col:null, werte:["kuendigung","stundung","inkasso","abwarten"] },
    kommentarPflicht:["kuendigung","stundung","inkasso"],
    offen:function(r){ return String(r["Status"])==="ueberfaellig" && String(r["Mahnstufe"]).replace(".0","")==="2"
                              && !/SANDRO-ENTSCHEID/.test(String(r["Notiz"]||"")); },
    titelCols:["Rechnungs-ID","Agentur-ID"],
    kontext:["Agentur-ID","Rechnungs-ID","Typ","Zeitraum","Betrag-Brutto-EUR","Faellig-Am","Mahnstufe","Status","Notiz"] },

  { id:"support", titel:"Support eskaliert / Churn", sop:"sop-00-07-kunden-support-und-reporting",
    slug:"sheet-66-kunden-support-log", typ:"entscheidung", apply:"support",
    frage:"An dich eskaliertes Ticket — Entscheid notieren, als beantwortet markieren oder schliessen?",
    decision:{ col:"Status", werte:["entscheid-notiert","beantwortet","geschlossen"] },
    kommentarPflicht:["entscheid-notiert","beantwortet","geschlossen"],
    offen:function(r){ return (String(r["Status"])==="eskaliert" && /sandro/i.test(String(r["Eskalation-An"])))
                              || String(r["Churn-Flag"]).toLowerCase()==="ja"; },
    titelCols:["Ticket-ID","Agentur-ID"],
    kontext:["Ticket-ID","Agentur-ID","Typ","Betreff-Kurz","Status","Eskalation-An","Churn-Flag","Notiz"] },

  // --- Aktions-Gates: kein Rueckstau, sondern von Sandro jederzeit ausloesbare Weichen ---
  { id:"fanvue-aktivierung", titel:"Fanvue-Aktivierung planen (D18)", sop:"sop-05-01-fanvue-account-setup",
    slug:"sheet-01-persona-stack", typ:"aktion", apply:"col",
    frage:"Approvte Persona ohne Fanvue — Monetarisierungs-Kette starten? (setzt 'geplant', triggert sop-05-01)",
    decision:{ col:"Fanvue-Account-Status", offenWert:"keiner", werte:["geplant"] },
    kommentarPflicht:[],
    offen:function(r){ return String(r["Check-Status"])==="Approved"
                              && (String(r["Fanvue-Account-Status"])==="keiner" || String(r["Fanvue-Account-Status"])===""); },
    titelCols:["Creator-ID","Creator-Name"],
    kontext:["Creator-Name","Creator-Typ","Creator-Zweck","Fanvue-Account-Status","Notiz"] },

  { id:"lora", titel:"LoRA-Training anfragen (kostenpflichtig)", sop:"sop-02-00-creator-creation",
    slug:"sheet-01-persona-stack", typ:"aktion", apply:"col",
    frage:"LoRA-Training fuer diesen AI-Creator anfragen? (Register-G8: nur du setzt 'angefragt'; Kosten folgen)",
    decision:{ col:"LoRA-Status", werte:["angefragt","abgelehnt"] },
    kommentarPflicht:["abgelehnt"],
    offen:function(r){ return String(r["Creator-Typ"])==="AI" && String(r["Check-Status"])==="Approved"
                              && String(r["LoRA-Status"]||"")===""; },
    titelCols:["Creator-ID","Creator-Name"],
    kontext:["Creator-Name","LoRA-Status","Notiz"] }
];

// ======================= Routing-Ziele =======================
function dzList(body){
  const p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  const reg = dzRegistry_();
  const gates = [], warnings = [];
  DZ_GATES.forEach(function(g){
    const ssid = reg[g.slug];
    const base = { id:g.id, titel:g.titel, sop:g.sop, typ:g.typ, frage:g.frage,
                   werte:g.decision.werte, kommentarPflicht:g.kommentarPflicht||[] };
    if (!ssid){
      warnings.push(g.slug + " nicht in der Live-Registry (aktivierungs-gated?) — Gate nicht pruefbar");
      gates.push(Object.assign(base, { verfuegbar:false, grund:"Sheet nicht angelegt", items:[], gesamt:0 }));
      return;
    }
    try {
      const t = table_(sheet_(ssid, "Daten"));
      // Entscheidungs-Spalte HART pruefen (Live-Header driften — Lehre sheet-50): lieber laut scheitern.
      if (g.decision.col && t.header.indexOf(g.decision.col) < 0){
        warnings.push(g.slug + ": Spalte '" + g.decision.col + "' fehlt im Live-Sheet — Gate deaktiviert");
        gates.push(Object.assign(base, { verfuegbar:false, grund:"Spalte '"+g.decision.col+"' fehlt", items:[], gesamt:0 }));
        return;
      }
      const items = [];
      t.rows.forEach(function(r){
        if (!g.offen(r)) return;
        items.push(dzItem_(g, t, r));
      });
      gates.push(Object.assign(base, { verfuegbar:true, items:items.slice(0,50), gesamt:items.length }));
    } catch(e){
      warnings.push(g.slug + " NICHT LESBAR: " + e);
      gates.push(Object.assign(base, { verfuegbar:false, grund:String(e), items:[], gesamt:0 }));
    }
  });
  return { ok:true, gates:gates, qcSpiegel:dzQcSpiegel_(), warnings:warnings };
}

function dzDecide(body){
  const p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  const g = DZ_GATES.filter(function(x){ return x.id === String(body.gate); })[0];
  if (!g) return { ok:false, error:"Unbekanntes Gate." };
  const wert = String(body.wert||"");
  if (g.decision.werte.indexOf(wert) < 0) return { ok:false, error:"Wert nicht erlaubt: " + wert };  // Allowlist
  const kommentar = String(body.kommentar||"").trim();
  if ((g.kommentarPflicht||[]).indexOf(wert) >= 0 && !kommentar)
    return { ok:false, error:"Begruendung ist Pflicht bei '" + wert + "'." };
  const ssid = dzRegistry_()[g.slug];
  if (!ssid) return { ok:false, error:g.slug + " nicht in der Live-Registry." };

  const sh = sheet_(ssid, "Daten");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const t = table_(sh);
    const row = t.rows.filter(function(r){ return r._row === Number(body.row); })[0];
    if (!row) return { ok:false, error:"Zeile nicht gefunden — Liste neu laden." };
    if (dzFp_(g, row) !== String(body.fp||""))
      return { ok:false, error:"Zeile hat sich seit dem Laden geaendert — Liste neu laden." };
    if (!g.offen(row)) return { ok:false, error:"Nicht (mehr) offen — Liste neu laden." };

    const pb = dzPatch_(g, row, wert, kommentar);
    if (!Object.keys(pb.patch).length) return { ok:false, error:"Nichts zu schreiben (Patch leer)." };
    setCells_(sh, t, row._row, pb.patch);
    // Audit inkl. VORHER-Werten + exaktem Notiz-Append -> macht dz_undo moeglich.
    dzAudit_([new Date().toISOString(), p.u, g.id, g.slug, row._row, dzTitel_(g, row), wert, kommentar,
              JSON.stringify(pb.vorher), pb.notizAppend, ""]);
    return { ok:true, geschrieben:Object.keys(pb.patch) };
  } finally { lock.releaseLock(); }
}

function dzCockpit(body){
  const p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  const id = dzFileId_("DZ_SUMMARY_FILE_ID", "summary.json", ["os-data"]);
  if (!id) return { ok:false, error:"summary.json nicht im Drive gefunden — laeuft der Collector?" };
  try {
    const f = DriveApp.getFileById(id);
    return { ok:true, summary: JSON.parse(f.getBlob().getDataAsString("UTF-8")),
             stand: f.getLastUpdated().toISOString() };
  } catch(e){
    props_().deleteProperty("DZ_SUMMARY_FILE_ID");   // Cache verwerfen — Datei-ID evtl. veraltet
    return { ok:false, error:"summary.json nicht lesbar: " + e };
  }
}

// ======================= Patch-Bau (Allowlist) =======================
// Rueckgabe: { patch, vorher, notizAppend }. WICHTIG: Notiz wird IMMER angehaengt (" | "-getrennt),
// NIE ueberschrieben — bestehende Notizen (Agent-Entwuerfe, Dead-Letter-Vermerke) bleiben erhalten.
// `vorher` (alte Werte der Ziel-Spalten) + `notizAppend` (exakter angehaengter Text) landen im Audit
// und machen dz_undo moeglich.
function dzPatch_(g, row, wert, kommentar){
  const stamp = "ENTSCHEIDUNGSZENTRALE " + new Date().toISOString().slice(0,16).replace("T"," ");
  const notizAlt = String(row["Notiz"]||"").trim();
  const notizZeile = "SANDRO-ENTSCHEID " + stamp + ": " + wert + (kommentar ? " — " + kommentar : "");
  const angehaengt = (notizAlt ? notizAlt + " | " : "") + notizZeile;
  const patch = {}, vorher = {};
  let append = "";
  if (g.apply === "notiz"){                       // kein eigenes Entscheidungs-Feld (Mahnstufe 2)
    patch["Notiz"] = angehaengt; append = notizZeile;
  } else if (g.apply === "support"){              // sheet-66: Entscheid immer in die Notiz, Status nur auf Wunsch
    patch["Notiz"] = angehaengt; append = notizZeile;
    if (wert === "beantwortet" || wert === "geschlossen"){
      vorher["Status"] = String(row["Status"]||"");
      patch["Status"] = wert;
    }
  } else {                                        // Standard: exakt die deklarierte Entscheidungs-Spalte
    vorher[g.decision.col] = String(row[g.decision.col]||"");
    patch[g.decision.col] = wert;
    if (kommentar && ("Notiz" in row)){ patch["Notiz"] = angehaengt; append = notizZeile; }
  }
  return { patch:patch, vorher:vorher, notizAppend:append };
}

// ======================= Historie + Rueckgaengig =======================
function dzHistory(body){
  const p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  const id = props_().getProperty("DZ_AUDIT_SSID");
  if (!id) return { ok:true, eintraege:[] };                   // noch nie entschieden
  try {
    const vals = SpreadsheetApp.openById(id).getSheets()[0].getDataRange().getValues();
    const out = [];
    for (let i = vals.length-1; i >= 1 && out.length < 100; i--){
      const v = vals[i];
      if (body.gate && String(v[2]) !== String(body.gate)) continue;
      out.push({ auditRow:i+1, zeit:dzZeit_(v[0]), gate:String(v[2]), titel:String(v[5]),
                 wert:String(v[6]), kommentar:String(v[7]||""), undo:String(v[10]||"") });
    }
    return { ok:true, eintraege:out };
  } catch(e){ return { ok:false, error:"Audit nicht lesbar: " + e }; }
}

function dzUndo(body){
  const p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  const id = props_().getProperty("DZ_AUDIT_SSID");
  if (!id) return { ok:false, error:"Kein Audit vorhanden." };
  const ash = SpreadsheetApp.openById(id).getSheets()[0];
  const auditRow = Number(body.auditRow||0);
  if (auditRow < 2 || auditRow > ash.getLastRow()) return { ok:false, error:"Audit-Eintrag nicht gefunden." };
  const v = ash.getRange(auditRow, 1, 1, 11).getValues()[0];
  const gateId = String(v[2]), zeileNum = Number(v[4]), wert = String(v[6]);
  const vorher = (function(){ try { return JSON.parse(String(v[8])||"{}"); } catch(e){ return {}; } })();
  const notizAppend = String(v[9]||"");
  if (String(v[10]||"").trim()) return { ok:false, error:"Bereits rueckgaengig gemacht (" + v[10] + ")." };
  const g = DZ_GATES.filter(function(x){ return x.id === gateId; })[0];
  if (!g) return { ok:false, error:"Gate unbekannt: " + gateId };
  const ssid = dzRegistry_()[g.slug];
  if (!ssid) return { ok:false, error:g.slug + " nicht in der Live-Registry." };

  const sh = sheet_(ssid, "Daten");
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const t = table_(sh);
    const row = t.rows.filter(function(r){ return r._row === zeileNum; })[0];
    if (!row) return { ok:false, error:"Datenzeile existiert nicht mehr — nicht rueckgaengig machbar." };

    const patch = {}, konflikte = [];
    // Ziel-Spalten nur zuruecksetzen, wenn dort noch UNSER Wert steht (sonst hat System/Mensch weitergearbeitet).
    Object.keys(vorher).forEach(function(col){
      if (String(row[col]||"") === wert) patch[col] = vorher[col];
      else konflikte.push(col + " ist inzwischen '" + row[col] + "' — nicht angefasst");
    });
    // Notiz-Append nur entfernen, wenn er noch unveraendert am ENDE steht — sonst Notiz nicht anfassen.
    if (notizAppend){
      const n = String(row["Notiz"]||"");
      if (n === notizAppend) patch["Notiz"] = "";
      else if (n.slice(-(" | " + notizAppend).length) === " | " + notizAppend)
        patch["Notiz"] = n.slice(0, n.length - (" | " + notizAppend).length);
      else konflikte.push("Notiz wurde inzwischen erweitert — Eintrag bleibt stehen");
    }
    if (!Object.keys(patch).length)
      return { ok:false, error:"Nicht rueckgaengig machbar: " + (konflikte.join("; ") || "nichts zurueckzusetzen") };
    setCells_(sh, t, zeileNum, patch);
    ash.getRange(auditRow, 11).setValue("rueckgaengig " + new Date().toISOString().slice(0,16).replace("T"," "));
    return { ok:true, geschrieben:Object.keys(patch),
             hinweis: konflikte.length ? "Teilweise zurueckgesetzt: " + konflikte.join("; ")
               : "Zurueckgesetzt. Hinweis: Hat die Automatik zwischenzeitlich schon reagiert, rollt das nur den Sheet-Wert zurueck." };
  } finally { lock.releaseLock(); }
}

function dzZeit_(v){
  if (v && v.getTime) return Utilities.formatDate(v, "Europe/Berlin", "yyyy-MM-dd HH:mm");
  return String(v||"").slice(0,16).replace("T"," ");
}

// ======================= Refresh-Anforderung (Handy -> PC-Collector) =======================
// Apps Script kann den PC nicht anrufen — aber es kann eine Marker-Datei ins Drive legen, die
// per Drive-Sync auf dem PC erscheint. Dort prueft ein Scheduled Task alle 10 min (check-refresh.ps1):
// Marker da -> Collector laeuft -> summary.json frisch. Laeuft der PC nicht, passiert schlicht nichts.
function dzRefresh(body){
  const p = auth_(body.token);
  if (p.r !== "admin") return { ok:false, error:"Nur Admin." };
  const fid = dzFolderId_("DZ_OSDATA_FOLDER_ID", "os-data", ["agentic-os"]);
  if (!fid) return { ok:false, error:"os-data-Ordner nicht im Drive gefunden." };
  try {
    const folder = DriveApp.getFolderById(fid);
    const inhalt = new Date().toISOString() + " " + p.u;
    const it = folder.getFilesByName("refresh-request.txt");
    if (it.hasNext()) it.next().setContent(inhalt);
    else folder.createFile("refresh-request.txt", inhalt);
    return { ok:true, hinweis:"Angefordert — der PC prueft alle 10 Minuten (nur wenn er an ist)." };
  } catch(e){
    props_().deleteProperty("DZ_OSDATA_FOLDER_ID");
    return { ok:false, error:"Anforderung nicht ablegbar: " + e };
  }
}

function dzFolderId_(propKey, name, parentNames){
  const cached = props_().getProperty(propKey);
  if (cached) return cached;
  const it = DriveApp.getFoldersByName(name);
  let fallback = null;
  while (it.hasNext()){
    const f = it.next();
    fallback = fallback || f.getId();
    try {
      const parents = f.getParents();
      while (parents.hasNext()){
        if ((parentNames||[]).indexOf(parents.next().getName()) >= 0){
          props_().setProperty(propKey, f.getId());
          return f.getId();
        }
      }
    } catch(e){}
  }
  if (fallback) props_().setProperty(propKey, fallback);
  return fallback;
}

// ======================= sheet-60-Spiegel (K3 — entschieden wird im Review-Tab) =======================
function dzQcSpiegel_(){
  try {
    const t = table_(sheet_(CONFIG.QUEUE_SSID, CONFIG.QUEUE_TAB));
    const offen = { "Skript":0, "Plan":0, "Konzept":0, "Bild":0, "Video":0, "editiertes-Video":0 };
    t.rows.forEach(function(r){
      const st = String(r["QC-Status"]);
      if (st !== "pending" && st !== "in-review") return;
      const typ = String(r["Content-Typ"]);
      if (typ in offen) offen[typ]++;
    });
    return { offen:offen, hinweis:"Persona-Real, Aussehens-Spec, Nischen-Zuweisung, Gesamtkonzept, Skripte laufen als sheet-60-Items — entscheiden im Review-Tab." };
  } catch(e){ return { offen:{}, hinweis:"sheet-60 nicht lesbar: " + e }; }
}

// ======================= Helfer =======================
function dzTitel_(g, row){
  const teile = [];
  (g.titelCols||[]).forEach(function(c){
    const v = String(row[c]==null?"":row[c]).trim();
    if (v && teile.indexOf(v) < 0) teile.push(v);
  });
  return teile.join(" · ") || ("Zeile " + row._row);
}
function dzItem_(g, t, row){
  const ctx = [];
  (g.kontext||[]).forEach(function(c){
    if (t.header.indexOf(c) < 0) return;                      // Kandidaten-Spalte fehlt -> weglassen
    const v = String(row[c]==null?"":row[c]).trim();
    if (!v) return;
    ctx.push({ label:c, wert: v.length > 400 ? v.slice(0,400) + "…" : v });
  });
  return { row: row._row, fp: dzFp_(g, row), titel: dzTitel_(g, row),
           aktuell: g.decision.col ? String(row[g.decision.col]||"") : "", kontext: ctx };
}
function dzFp_(g, row){
  // Zeilen-Fingerprint: Entscheidungs-Spalte + Titel + Kontextwerte. decide() schreibt nur, wenn er
  // noch stimmt — schuetzt gegen "Zeile wurde zwischen Laden und Klick veraendert/verschoben".
  const teile = [g.id, String(g.decision.col ? row[g.decision.col] : ""), dzTitel_(g, row)];
  (g.kontext||[]).forEach(function(c){ if (c in row) teile.push(String(row[c]==null?"":row[c])); });
  return sha256Hex_(teile.join("")).slice(0, 16);
}

// Slug -> Spreadsheet-ID aus sheets-sync/sheet-registry.json im Shared Drive (SSOT). 10-min-Cache.
function dzRegistry_(){
  const c = cache_();
  const hit = c.get("dz_registry");
  if (hit){ try { return JSON.parse(hit); } catch(e){} }
  const id = dzFileId_("DZ_REGISTRY_FILE_ID", "sheet-registry.json", ["sheets-sync"]);
  if (!id) throw "sheet-registry.json nicht im Drive gefunden";
  const reg = JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString("UTF-8"));
  try { c.put("dz_registry", JSON.stringify(reg), 600); } catch(e){}
  return reg;
}

// Datei im (Shared) Drive per Name finden, per Parent-Ordnernamen disambiguieren, ID in Properties cachen.
function dzFileId_(propKey, name, parentNames){
  const cached = props_().getProperty(propKey);
  if (cached) return cached;
  const it = DriveApp.getFilesByName(name);
  let fallback = null;
  while (it.hasNext()){
    const f = it.next();
    fallback = fallback || f.getId();
    try {
      const parents = f.getParents();
      while (parents.hasNext()){
        const pName = parents.next().getName();
        if ((parentNames||[]).indexOf(pName) >= 0){
          props_().setProperty(propKey, f.getId());
          return f.getId();
        }
      }
    } catch(e){}
  }
  if (fallback) props_().setProperty(propKey, fallback);      // eindeutiger Einzeltreffer o. bester Kandidat
  return fallback;
}

// Einmal im Editor ausfuehren, um alle Manifest-Scopes (Sheets + Drive) in EINEM Consent zu bewilligen.
function dzAuthorize(){
  Logger.log("Sheets ok: " + SpreadsheetApp.openById(CONFIG.QUEUE_SSID).getName());
  Logger.log("Drive ok: "  + DriveApp.getRootFolder().getName());
  Logger.log("Autorisierung vollstaendig.");
}

// Audit-Log: privates Spreadsheet in My Drive, beim ersten Entscheid automatisch angelegt.
function dzAudit_(zeile){
  try {
    let id = props_().getProperty("DZ_AUDIT_SSID");
    let ss = null;
    if (id){ try { ss = SpreadsheetApp.openById(id); } catch(e){ id = null; } }
    if (!id){
      ss = SpreadsheetApp.create("entscheidungszentrale-audit");
      ss.getSheets()[0].appendRow(["Zeitpunkt","User","Gate","Sheet","Zeile","Titel","Entscheidung","Kommentar","Vorher","Notiz-Append","Undo"]);
      props_().setProperty("DZ_AUDIT_SSID", ss.getId());
    }
    ss.getSheets()[0].appendRow(zeile);
  } catch(e){ /* Audit darf den Entscheid nicht blockieren; Fehler landet im Stackdriver-Log */ }
}
