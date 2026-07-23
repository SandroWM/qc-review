/* Entscheidungszentrale + Cockpit — admin-only Erweiterung der QC-Review-App (2026-07-23).
   Backend: decisions.gs (dz_list / dz_decide / dz_history / dz_undo / dz_cockpit / dz_refresh).
   XSS-Politik der App gilt auch hier: Sheet-/Summary-Daten NUR via textContent, nie innerHTML.
   Entscheiden ist ZWEI-Schritt (Wert waehlen -> Entscheiden-Knopf) — gegen Fehlklicks am Handy. */

const dz = { data:null, busy:false };

/* ---------- kleine Helfer ---------- */
function dzEl(tag, cls, text){
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function dzClear(el){ while (el.firstChild) el.removeChild(el.firstChild); }
function dzNum(n){ return (n==null || isNaN(n)) ? "—" : Math.round(n).toLocaleString("de-DE"); }

/* Farbklasse je Entscheidungs-Wert (rein optisch — geschrieben wird immer der Roh-Wert) */
function dzWertKlasse(w){
  const gruen = ["Approved","bestaetigt","geplant","angefragt","unterschrieben","Aktiv","beantwortet"];
  const rot   = ["Rejected","blockiert","kuendigung","inkasso","Archiviert","abgelehnt","geschlossen"];
  if (gruen.indexOf(w) >= 0) return "dz-w-ok";
  if (rot.indexOf(w) >= 0) return "dz-w-bad";
  return "dz-w-mid";
}

/* ---------- Modus-Router (wird aus app.js gerufen) ---------- */
function dzSwitchMode(){
  const m = state.mode;
  const ws = document.querySelector(".workspace"), sb = document.querySelector(".statbar");
  const tabs = $("typ-tabs"), dzV = $("dz-view"), ckV = $("cockpit-view");
  const qc = (m === "review" || m === "spotcheck" || m === "screening");
  if (ws) ws.hidden = !qc;
  if (sb) sb.hidden = !qc;
  if (tabs && !qc) tabs.hidden = true;
  if (dzV) dzV.hidden = (m !== "dz");
  if (ckV) ckV.hidden = (m !== "cockpit");
  if (m === "dz") dzLoad();
  else if (m === "cockpit") ckLoad();
  else loadNext();
}

/* =================================================================== */
/*  ENTSCHEIDUNGEN                                                      */
/* =================================================================== */
async function dzLoad(){
  const v = $("dz-view");
  dzClear(v);
  v.appendChild(dzEl("div", "dz-loading", "Lade offene Entscheidungen aus den Live-Sheets … (kann ~10 s dauern)"));
  try {
    const r = await api("dz_list", { token: state.token });
    if (!r || !r.ok) throw new Error((r && r.error) || "dz_list fehlgeschlagen");
    dz.data = r;
    dzRender(r);
  } catch (err){
    dzClear(v);
    v.appendChild(dzEl("div", "dz-error", "Entscheidungen nicht ladbar: " + (err && err.message ? err.message : err)));
    const retry = dzEl("button", "dz-btn", "Nochmal versuchen");
    retry.onclick = dzLoad;
    v.appendChild(retry);
  }
}

function dzRender(r){
  const v = $("dz-view");
  dzClear(v);
  const gates = r.gates || [];
  const offenE = gates.filter(g => g.typ === "entscheidung" && g.verfuegbar && g.gesamt > 0);
  const aktionen = gates.filter(g => g.typ === "aktion" && g.verfuegbar && g.gesamt > 0);
  const leer = gates.filter(g => g.verfuegbar && g.gesamt === 0);
  const kaputt = gates.filter(g => !g.verfuegbar);
  const offenGesamt = offenE.reduce((s,g)=>s+g.gesamt,0);

  // Kopf
  const kopf = dzEl("div", "dz-head");
  const big = dzEl("span", "dz-count" + (offenGesamt ? " crit" : " ok"), String(offenGesamt));
  kopf.appendChild(big);
  kopf.appendChild(dzEl("span", "dz-count-lbl",
    offenGesamt === 1 ? "Entscheidung wartet auf dich" : "Entscheidungen warten auf dich"));
  const reload = dzEl("button", "dz-btn dz-right", "↻ Neu laden");
  reload.onclick = dzLoad;
  kopf.appendChild(reload);
  const verlaufAll = dzEl("button", "dz-btn", "Verlauf (alle)");
  kopf.appendChild(verlaufAll);
  v.appendChild(kopf);

  const verlaufBox = dzEl("div", "dz-verlauf-global");
  verlaufBox.hidden = true;
  v.appendChild(verlaufBox);
  verlaufAll.onclick = () => dzToggleVerlauf(null, verlaufBox, verlaufAll);

  // Offene Entscheidungs-Gates
  offenE.forEach(g => v.appendChild(dzGateBlock(g, true)));

  // Aktions-Gates (kein Rueckstau — bewusst eingeklappt)
  if (aktionen.length){
    v.appendChild(dzEl("div", "dz-sect", "Aktionen (jederzeit ausloesbar — kein Rueckstau)"));
    aktionen.forEach(g => v.appendChild(dzGateBlock(g, false)));
  }

  // QC-Spiegel (sheet-60-Freigaben laufen im Review-Tab)
  const qs = (r.qcSpiegel && r.qcSpiegel.offen) || {};
  const qcTeile = Object.keys(qs).filter(k => qs[k] > 0).map(k => k + " " + qs[k]);
  const spiegel = dzEl("div", "dz-spiegel");
  spiegel.appendChild(dzEl("strong", null, "Freigaben im Review-Tab: "));
  spiegel.appendChild(document.createTextNode(qcTeile.length ? qcTeile.join(" · ") : "nichts offen"));
  if (qcTeile.length){
    const go = dzEl("button", "dz-btn dz-right", "→ Review öffnen");
    go.onclick = () => { const sel = $("mode-select"); sel.value = "review"; state.mode = "review"; state.typ = null; dzSwitchMode(); };
    spiegel.appendChild(go);
  }
  const hinweis = (r.qcSpiegel && r.qcSpiegel.hinweis) || "";
  if (hinweis) spiegel.appendChild(dzEl("div", "dz-mini", hinweis));
  v.appendChild(spiegel);

  // Gates ohne offene Punkte (kompakt — zeigt, dass geprueft wurde)
  if (leer.length){
    const zeile = dzEl("div", "dz-leer");
    zeile.appendChild(dzEl("strong", null, "Nichts offen: "));
    zeile.appendChild(document.createTextNode(leer.map(g => g.titel).join(" · ")));
    v.appendChild(zeile);
  }

  // Nicht pruefbare Gates + Collector-artige Warnungen — LAUT, nie still
  if (kaputt.length || (r.warnings || []).length){
    const warn = dzEl("div", "dz-warn");
    warn.appendChild(dzEl("strong", null, "Hinweise:"));
    kaputt.forEach(g => warn.appendChild(dzEl("div", null, "• " + g.titel + ": " + (g.grund || "nicht verfuegbar"))));
    (r.warnings || []).forEach(w => warn.appendChild(dzEl("div", null, "• " + w)));
    v.appendChild(warn);
  }
}

function dzGateBlock(g, open){
  const box = dzEl("details", "dz-gate");
  box.open = !!open;
  const sum = dzEl("summary", "dz-gate-sum");
  sum.appendChild(dzEl("span", "dz-badge" + (g.typ === "entscheidung" ? " crit" : ""), String(g.gesamt)));
  sum.appendChild(dzEl("span", "dz-gate-titel", g.titel));
  sum.appendChild(dzEl("span", "dz-gate-sop", g.sop));
  const vbtn = dzEl("button", "dz-btn dz-btn-mini", "Verlauf");
  sum.appendChild(vbtn);
  box.appendChild(sum);
  if (g.frage) box.appendChild(dzEl("div", "dz-frage", g.frage));

  const vbox = dzEl("div", "dz-verlauf");
  vbox.hidden = true;
  box.appendChild(vbox);
  vbtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); dzToggleVerlauf(g.id, vbox, vbtn); };

  (g.items || []).forEach(item => box.appendChild(dzItemCard(g, item)));
  if (g.gesamt > (g.items || []).length)
    box.appendChild(dzEl("div", "dz-mini", "… und " + (g.gesamt - g.items.length) + " weitere (nach dem Entscheiden neu laden)"));
  return box;
}

function dzItemCard(g, item){
  const card = dzEl("div", "dz-item");
  const kopf = dzEl("div", "dz-item-kopf");
  kopf.appendChild(dzEl("strong", null, item.titel));
  if (item.aktuell) kopf.appendChild(dzEl("span", "dz-aktuell", "aktuell: " + item.aktuell));
  card.appendChild(kopf);

  // Kontext: alles, was man zum Entscheiden braucht — direkt auf der Karte
  const dl = dzEl("dl", "dz-ctx");
  (item.kontext || []).forEach(c => {
    dl.appendChild(dzEl("dt", null, c.label));
    dl.appendChild(dzEl("dd", null, c.wert));
  });
  card.appendChild(dl);

  // Zwei-Schritt: Wert waehlen -> Entscheiden
  let gewaehlt = null;
  const wrow = dzEl("div", "dz-werte");
  const buttons = [];
  (g.werte || []).forEach(w => {
    const b = dzEl("button", "dz-wert " + dzWertKlasse(w), w);
    b.onclick = () => {
      gewaehlt = w;
      buttons.forEach(x => x.classList.remove("sel"));
      b.classList.add("sel");
      const pflicht = (g.kommentarPflicht || []).indexOf(w) >= 0;
      ta.placeholder = pflicht ? "Begruendung (Pflicht bei '" + w + "')" : "Kommentar (optional, landet in der Notiz)";
      ta.classList.toggle("req", pflicht && !ta.value.trim());
      senden.disabled = false;
      hint.textContent = "";
    };
    buttons.push(b);
    wrow.appendChild(b);
  });
  card.appendChild(wrow);

  const ta = dzEl("textarea", "dz-kommentar");
  ta.rows = 2;
  ta.placeholder = "Kommentar (optional, landet in der Notiz)";
  card.appendChild(ta);

  const foot = dzEl("div", "dz-item-foot");
  const senden = dzEl("button", "dz-btn dz-primary", "Entscheiden");
  senden.disabled = true;
  const hint = dzEl("span", "dz-hint");
  foot.appendChild(senden);
  foot.appendChild(hint);
  card.appendChild(foot);

  senden.onclick = async () => {
    if (!gewaehlt || dz.busy) return;
    const kommentar = ta.value.trim();
    if ((g.kommentarPflicht || []).indexOf(gewaehlt) >= 0 && !kommentar){
      hint.textContent = "Begruendung ist Pflicht bei '" + gewaehlt + "'.";
      ta.classList.add("req"); ta.focus(); return;
    }
    dz.busy = true; senden.disabled = true; senden.textContent = "…";
    try {
      const r = await api("dz_decide", { token: state.token, gate: g.id, row: item.row, fp: item.fp,
                                          wert: gewaehlt, kommentar: kommentar });
      if (!r || !r.ok) throw new Error((r && r.error) || "Fehler");
      card.classList.add("done");
      dzClear(card);
      card.appendChild(dzEl("div", "dz-done", "✓ " + item.titel + " → " + gewaehlt +
        " · gespeichert. Rueckgaengig: Verlauf-Knopf am Gate."));
    } catch (err){
      hint.textContent = String(err && err.message ? err.message : err);
      senden.disabled = false; senden.textContent = "Entscheiden";
    } finally { dz.busy = false; }
  };
  return card;
}

/* ---------- Verlauf + Rueckgaengig ---------- */
async function dzToggleVerlauf(gateId, box, btn){
  if (!box.hidden){ box.hidden = true; return; }
  box.hidden = false;
  dzClear(box);
  box.appendChild(dzEl("div", "dz-loading", "Lade Verlauf …"));
  try {
    const r = await api("dz_history", { token: state.token, gate: gateId || "" });
    if (!r || !r.ok) throw new Error((r && r.error) || "Fehler");
    dzClear(box);
    if (!(r.eintraege || []).length){
      box.appendChild(dzEl("div", "dz-mini", "Noch keine Entscheidungen ueber die Zentrale."));
      return;
    }
    r.eintraege.forEach(e => {
      const row = dzEl("div", "dz-vrow" + (e.undo ? " undone" : ""));
      row.appendChild(dzEl("span", "dz-vzeit", e.zeit));
      if (!gateId) row.appendChild(dzEl("span", "dz-vgate", e.gate));
      row.appendChild(dzEl("span", "dz-vtitel", e.titel));
      row.appendChild(dzEl("span", "dz-vwert " + dzWertKlasse(e.wert), e.wert));
      if (e.kommentar) row.appendChild(dzEl("span", "dz-vkomm", e.kommentar));
      if (e.undo){
        row.appendChild(dzEl("span", "dz-vundo", e.undo));
      } else {
        const ub = dzEl("button", "dz-btn dz-btn-mini", "Rueckgaengig");
        ub.onclick = async () => {
          ub.disabled = true; ub.textContent = "…";
          try {
            const u = await api("dz_undo", { token: state.token, auditRow: e.auditRow });
            if (!u || !u.ok) throw new Error((u && u.error) || "Fehler");
            row.classList.add("undone");
            ub.replaceWith(dzEl("span", "dz-vundo", "rueckgaengig ✓"));
            if (u.hinweis) row.appendChild(dzEl("div", "dz-mini", u.hinweis));
            dzLoad();     // Eintrag erscheint wieder als offen
          } catch (err){
            ub.disabled = false; ub.textContent = "Rueckgaengig";
            row.appendChild(dzEl("div", "dz-error", String(err && err.message ? err.message : err)));
          }
        };
        row.appendChild(ub);
      }
      box.appendChild(row);
    });
  } catch (err){
    dzClear(box);
    box.appendChild(dzEl("div", "dz-error", "Verlauf nicht ladbar: " + (err && err.message ? err.message : err)));
  }
}

/* =================================================================== */
/*  COCKPIT (OS-Snapshot aus summary.json via Backend)                  */
/* =================================================================== */
async function ckLoad(){
  const v = $("cockpit-view");
  dzClear(v);
  v.appendChild(dzEl("div", "dz-loading", "Lade Cockpit-Snapshot …"));
  try {
    const r = await api("dz_cockpit", { token: state.token });
    if (!r || !r.ok) throw new Error((r && r.error) || "dz_cockpit fehlgeschlagen");
    ckRender(r.summary || {}, r.stand || "");
  } catch (err){
    dzClear(v);
    v.appendChild(dzEl("div", "dz-error", "Cockpit nicht ladbar: " + (err && err.message ? err.message : err)));
    const retry = dzEl("button", "dz-btn", "Nochmal versuchen");
    retry.onclick = ckLoad;
    v.appendChild(retry);
  }
}

function ckRender(s, stand){
  const v = $("cockpit-view");
  dzClear(v);

  // Kopf: Datenstand + Aktualisieren (Marker-Datei -> PC-Poll alle 10 min) + Neu laden
  const kopf = dzEl("div", "dz-head");
  kopf.appendChild(dzEl("strong", null, "Cockpit"));
  kopf.appendChild(dzEl("span", "dz-stand", "Datenstand: " + (stand ? stand.slice(0,16).replace("T"," ") : "—")));
  const refresh = dzEl("button", "dz-btn dz-right", "Zahlen aktualisieren");
  const reload = dzEl("button", "dz-btn", "↻ Neu laden");
  reload.onclick = ckLoad;
  kopf.appendChild(refresh);
  kopf.appendChild(reload);
  v.appendChild(kopf);
  const rhint = dzEl("div", "dz-mini");
  v.appendChild(rhint);
  refresh.onclick = async () => {
    refresh.disabled = true;
    try {
      const r = await api("dz_refresh", { token: state.token });
      rhint.textContent = (r && (r.hinweis || r.error)) || "?";
    } catch (err){ rhint.textContent = String(err); }
    refresh.disabled = false;
  };

  const grid = dzEl("div", "ck-grid");
  v.appendChild(grid);

  // Cash — drei Konten
  const konten = (s.cash && s.cash.konten) || {};
  [["gesamt","Gesamt"],["privat","Privat"],["business","Business"]].forEach(([key,label]) => {
    const k = konten[key];
    if (!k) return;
    const box = dzEl("div", "ck-card");
    box.appendChild(dzEl("div", "ck-lbl", "Cash · " + label));
    box.appendChild(dzEl("div", "ck-big", dzNum(k.verfuegbar_eur) + " €"));
    box.appendChild(dzEl("div", "ck-sub", "verfuegbar (" + (k.basis || "") + ")"));
    const netto = dzEl("div", "ck-val " + ((k.netto_mt||0) < 0 ? "bad" : "ok"),
      ((k.netto_mt||0) > 0 ? "+" : "") + dzNum(k.netto_mt) + " €/Mt");
    box.appendChild(netto);
    const rw = k.traegt_sich ? "traegt sich" : (k.runway_mt != null ? "Runway " + String(k.runway_mt).replace(".",",") + " Mt" : "kein Puffer");
    box.appendChild(dzEl("div", "ck-sub", rw));
    if (k.letzter_eingang)
      box.appendChild(dzEl("div", "ck-sub", "Letzter Eingang: " + k.letzter_eingang.datum + " · " + dzNum(k.letzter_eingang.eur) + " €"));
    grid.appendChild(box);
  });

  // Eskalationen
  const esk = s.eskalationen || {};
  const eb = dzEl("div", "ck-card" + ((esk.offen_sandro||0) > 0 ? " warn" : ""));
  eb.appendChild(dzEl("div", "ck-lbl", "Eskalationen (sheet-50)"));
  eb.appendChild(dzEl("div", "ck-big" + ((esk.offen_sandro||0) > 0 ? " bad" : ""), String(esk.offen_sandro||0)));
  eb.appendChild(dzEl("div", "ck-sub", "offen an dich · " + (esk.auto_erledigt||0) + " selbst erledigt"));
  (esk.items || []).filter(i => i.status === "offen").slice(0,4).forEach(i =>
    eb.appendChild(dzEl("div", "ck-line", "• " + i.sop + " (" + (i.vor_tagen!=null ? "vor " + i.vor_tagen + " T" : "") + ")")));
  grid.appendChild(eb);

  // System-Puls
  const h = s.header || {};
  const r24 = h.runs_24h || {};
  const pb = dzEl("div", "ck-card");
  pb.appendChild(dzEl("div", "ck-lbl", "System-Puls"));
  pb.appendChild(dzEl("div", "ck-big", String(r24.total||0)));
  pb.appendChild(dzEl("div", "ck-sub", "Laeufe 24 h · " + (r24.ok||0) + " ok · " + (r24.failed||0) + " failed"));
  pb.appendChild(dzEl("div", "ck-line", h.heartbeat_min_ago != null ? ("Heartbeat vor " + h.heartbeat_min_ago + " min") : "kein Heartbeat"));
  grid.appendChild(pb);

  // KPIs
  const kp = s.kpis || {};
  const kb = dzEl("div", "ck-card");
  kb.appendChild(dzEl("div", "ck-lbl", "Ertrag & Reichweite"));
  kb.appendChild(dzEl("div", "ck-big", dzNum(kp.umsatz && kp.umsatz.gesamt) + " €"));
  kb.appendChild(dzEl("div", "ck-sub", "Umsatz/Monat · Gewinn " + dzNum(kp.gewinn && kp.gewinn.gesamt) + " €"));
  kb.appendChild(dzEl("div", "ck-line", "Views 7 T: " + dzNum(kp.views && kp.views["7"]) + " · Klicks 7 T: " + dzNum(kp.klicks && kp.klicks["7"])));
  grid.appendChild(kb);

  // WORKBOARD
  const wb = s.workboard || [];
  if (wb.length){
    const wbox = dzEl("div", "ck-card ck-wide");
    wbox.appendChild(dzEl("div", "ck-lbl", "Woran wir arbeiten (WORKBOARD)"));
    const tbl = dzEl("div", "ck-wb");
    wb.slice(0,10).forEach(w => {
      tbl.appendChild(dzEl("span", "ck-wb-p", w.emoji || ""));
      tbl.appendChild(dzEl("span", "ck-wb-t", w.titel || ""));
      tbl.appendChild(dzEl("span", "ck-wb-s", w.status || ""));
      tbl.appendChild(dzEl("span", "ck-wb-n", w.next || ""));
    });
    wbox.appendChild(tbl);
    grid.appendChild(wbox);
  }

  // Collector-Warnungen
  const warns = s.warnings || [];
  if (warns.length){
    const wn = dzEl("div", "ck-card ck-wide dz-warn");
    wn.appendChild(dzEl("div", "ck-lbl", "Collector-Hinweise"));
    warns.forEach(w => wn.appendChild(dzEl("div", "ck-line", "• " + w)));
    grid.appendChild(wn);
  }

  v.appendChild(dzEl("div", "dz-mini",
    "Snapshot vom lokalen Collector (2x taeglich + auf Anforderung). Entscheidungen im Tab nebenan sind davon unabhaengig immer live."));
}
