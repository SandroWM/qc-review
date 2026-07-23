/* AI Marketing OS — Cockpit-Tab der QC-App. 1:1-Port des Leitstands (agentic-os/app/app.js);
   Daten kommen statt aus der lokalen summary.json jetzt via dz_cockpit (Apps-Script liest die
   Datei aus dem Drive), Aktionen (Queue/Eskalation/Refresh) via dz_enqueue/dz_esk_ack/dz_refresh.
   IIFE: kapselt $, el, DATA & Co. gegen die QC-App (dort ist $ = getElementById!). Nutzt deren
   globale api() + state.token. Export: window.osMount(). */
"use strict";
(function () {

/* ---------- State + Helfer ---------- */
let DATA = null, ARM = "gesamt", RANGE = "7", TFILTER = "alle", CASHVIEW = "gesamt";
const $ = (s, r = document) => r.querySelector(s);
const el = (id) => document.getElementById(id);
const fmt = (n) => (n == null ? "—" : Math.round(n).toLocaleString("de-DE"));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const apiUrl = (p) => { const t = new URLSearchParams(location.search).get("t"); return t ? p + "?t=" + encodeURIComponent(t) : p; };

function armShare(metric) {
  if (ARM === "gesamt") return 1;
  const bd = DATA.creator_breakdown || [];
  const total = bd.reduce((s, c) => s + (+c[metric] || 0), 0);
  if (!total) return 1; // keine Breakdown-Daten -> kein Filter, gesamt zeigen
  const arm = bd.filter((c) => c.arm === ARM).reduce((s, c) => s + (+c[metric] || 0), 0);
  return arm / total;
}

function sparkSVG(arr) {
  if (!arr || !arr.length) arr = [20, 20, 20, 20, 20, 20, 20, 20];
  const max = 36, n = arr.length;
  const pts = arr.map((v, i) => `${(i / (n - 1) * 100).toFixed(1)},${v.toFixed(1)}`);
  const area = `M0,${max} L${pts.join(" L")} L100,${max} Z`;
  const last = arr[n - 1];
  return `<svg class="spark" viewBox="0 0 100 ${max}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}"></path><polyline points="${pts.join(" ")}"></polyline>
    <circle cx="100" cy="${last.toFixed(1)}" r="2.2"></circle></svg>`;
}

/* ---------- Render ---------- */
function renderHeader() {
  const hb = DATA.header && DATA.header.heartbeat_min_ago;
  const beat = el("beat"), txt = el("beat-txt");
  if (hb == null) { beat.querySelector(".dot").className = "dot idle"; txt.textContent = "kein Heartbeat"; }
  else if (hb <= 45) { beat.querySelector(".dot").className = "dot g"; txt.textContent = `Heartbeat vor ${hb} min`; }
  else { beat.querySelector(".dot").className = "dot r"; txt.textContent = `Heartbeat vor ${hb} min (!)`; }
  const gen = DATA.generated_at ? DATA.generated_at.replace("T", " ").slice(5, 16) : "—";
  let age = "";
  if (DATA.generated_at && DATA._live) {
    const min = Math.round((Date.now() - new Date(DATA.generated_at).getTime()) / 60000);
    age = min < 1 ? " · gerade eben" : min < 60 ? ` · vor ${min} min` : ` · vor ${Math.round(min / 60)} h`;
  }
  el("stamp").textContent = "Datenstand " + gen + age;
}

function renderBriefing() {
  const r = (DATA.header && DATA.header.runs_24h) || {};
  const inboxSum = (DATA.inbox || []).reduce((s, i) => s + (i.count || 0), 0);
  const geld = (DATA.kpis.umsatz.gesamt ? `${fmt(DATA.kpis.umsatz.gesamt)} € Umsatz MTD` : "noch kein Umsatz (vor Launch)");
  const next = (DATA.timeline || []).find((t) => !t.done);
  el("m-briefing").innerHTML = `<section class="card" style="grid-column:1/-1;margin-top:16px">
    <div class="eyebrow">Morgen-Briefing · ${esc((DATA.generated_at||"").slice(0,10))} <span class="src">Nightly-Konsolidierung + Live-Stand</span></div>
    <div style="display:flex;gap:26px;flex-wrap:wrap;font-size:13px;line-height:1.5">
      <div><b style="color:var(--accent)">Über Nacht</b><br>${r.total||0} Läufe · <span style="color:var(--ok)">${r.ok||0} ok</span>${r.failed?` · <span style="color:var(--crit)">${r.failed} failed</span>`:""} · ${geld}</div>
      <div><b style="color:var(--accent)">Heute fällig</b><br>${DATA.qc?.pending||0} QC-Reviews · ${next?`nächster Lauf ${esc(next.zeit)} ${esc(next.label)}`:"alle Läufe durch"}</div>
      <div><b style="color:var(--accent)">Entscheidungen</b><br>${(DATA.prioritaeten||[]).length} Prioritäten · ${inboxSum} offene Gates in der Inbox</div>
    </div></section>`;
}

function kpiCard(key, label, src, value, opts) {
  const k = DATA.kpis[key];
  const trend = k.trend === "up" ? "up" : k.trend === "down" ? "down" : "flat";
  const arrow = trend === "up" ? "▲ " : trend === "down" ? "▼ " : "";
  let goal = "";
  if (opts.ziel) {
    const pct = Math.min(100, Math.round(value / opts.ziel * 100));
    goal = `<div class="goal"><div class="glab"><span>Ziel Monat <b>${fmt(opts.ziel)} €</b></span><span>${pct} %</span></div>
      <div class="gtrack"><i style="width:${pct}%"></i></div></div>`;
  }
  return `<div class="eyebrow"><span>${esc(label)}</span> <span class="src">${esc(src)}</span></div>
    <div class="num">${opts.eur ? fmt(value) + '<small> €</small>' : fmt(value)}</div>
    <div class="delta ${trend}">${arrow}${esc(k.delta_txt || "")}</div>
    ${goal}${sparkSVG(k.spark)}`;
}

function renderKpis() {
  const u = DATA.kpis.umsatz, g = DATA.kpis.gewinn, v = DATA.kpis.views, k = DATA.kpis.klicks;
  const uv = ARM === "gesamt" ? u.gesamt : (u[ARM] || 0);
  const gv = ARM === "gesamt" ? g.gesamt : (g[ARM] || 0);
  const vv = Math.round((v[RANGE] || 0) * armShare("views"));
  const kv = Math.round((k[RANGE] || 0) * armShare("klicks"));
  const rlab = RANGE === "1" ? "1 Tag" : RANGE === "30" ? "30 Tage" : "7 Tage";
  $('.kpi[data-kpi="umsatz"]').innerHTML = kpiCard("umsatz", "Umsatz · Monat", "sheet-45 + sheet-59", uv, { eur: true, ziel: u.ziel });
  $('.kpi[data-kpi="gewinn"]').innerHTML = kpiCard("gewinn", "Gewinn · Monat", "sheet-45/59 − Kosten", gv, { eur: true, ziel: g.ziel });
  $('.kpi[data-kpi="views"]').innerHTML  = kpiCard("views",  "Views · " + rlab, "sheet-32 Performance", vv, {});
  $('.kpi[data-kpi="klicks"]').innerHTML = kpiCard("klicks", "Link-Klicks · " + rlab, "sheet-37 · Primär-KPI", kv, {});
}

function renderWorkboard() {
  const wb = DATA.workboard || [];
  const host = el("m-workboard");
  if (!wb.length) { host.innerHTML = `<div class="empty">Kein WORKBOARD gefunden (G:\\…\\Claude Code\\WORKBOARD.md).</div>`; return; }
  const cut = (s, n) => (s && s.length > n ? s.slice(0, n) + "…" : (s || "—"));
  const head = ["Prio", "Thema", "Status", "Nächster Schritt", "Chat"]
    .map((h) => `<div class="h">${h}</div>`).join("");
  const rows = wb.map((w) => `
    <div class="wbprio" title="${esc(w.sektion)}">${esc(w.emoji)}</div>
    <div class="wbtitel">${esc(w.titel)}</div>
    <div class="wbstatus" title="${esc(w.status)}">${esc(cut(w.status, 74))}</div>
    <div class="wbnext" title="${esc(w.next)}">${esc(cut(w.next, 175))}</div>
    <div class="wbchat">${esc(w.chat || "—")}</div>`).join("");
  host.innerHTML = `<div class="wbwrap"><div class="wbtable">${head}${rows}</div></div>`;
}

function renderPrio() {
  el("m-prio").innerHTML = (DATA.prioritaeten || []).map((p, i) => `
    <div class="pitem" data-i="${i}" tabindex="0">
      <div class="prow"><span class="ptag ${esc(p.prio)}">${esc(p.prio)}</span><span class="ptitle">${esc(p.titel)}</span></div>
      <div class="psrc">${esc(p.quelle)}${p.frist ? " · Frist " + esc(p.frist) : ""}</div>
      <div class="pactions">
        <button class="btn primary" data-act="claude" data-i="${i}">An Claude übergeben</button>
        <button class="btn" data-act="copy" data-i="${i}">Prompt kopieren</button>
      </div>
    </div>`).join("") || `<div class="empty">Keine offenen Prioritäten.</div>`;
}

function renderInbox() {
  el("m-inbox").innerHTML = (DATA.inbox || []).map((it) => {
    const cls = it.count === 0 ? "zero" : it.sev === "warn" ? "hot" : "";
    return `<div class="iitem"><span class="count ${cls}">${it.count}</span>${esc(it.label)}
      <a class="ilink" href="#" data-link="${esc(it.link)}">${esc(it.link)} ↗</a></div>`;
  }).join("");
}

function renderPuls() {
  const p = DATA.puls || {}, r = (DATA.header && DATA.header.runs_24h) || {};
  const wl = (DATA.wellen || []);
  el("m-puls").innerHTML = `
    <div class="pulsrow"><span>Läufe 24 h</span><span class="v">${r.total||0} · <span style="color:var(--ok)">${r.ok||0} ok</span>${r.failed?` · <span style="color:var(--crit)">${r.failed} failed</span>`:""}</span></div>
    <div class="pulsrow"><span>Missed Crons</span><span class="v" style="color:${p.missed_crons?'var(--crit)':'var(--ok)'}">${p.missed_crons||0}</span></div>
    <div class="pulsrow"><span>Stuck / Recovery</span><span class="v" style="color:${p.stuck?'var(--warn)':'var(--ok)'}">${p.stuck||0}</span></div>
    <div class="pulsrow"><span>Letzter Fehler</span><span class="v" style="color:var(--muted)">${esc(p.letzter_fehler||"—")}</span></div>
    <div class="wellenlist">${wl.map((w) => {
      const st = w.state === "live" ? "live" : w.state === "prep" ? "prep" : "idle";
      const lbl = st === "live" ? "läuft" : st === "prep" ? "in Vorb." : "aus";
      return `<div class="wrow" title="${esc(w.detail || "")}">
        <span class="wbar ${st}"></span>
        <span class="wname ${st}">${esc(w.name)}</span>
        <span class="wstate ${st}">${lbl}</span>
      </div>`;
    }).join("")}</div>`;
}

function renderFlotte() {
  const head = ["Plattform","Aktiv","Warmup","Gesperrt","Health","Hinweis"].map((h)=>`<div class="h">${h}</div>`).join("");
  const rows = (DATA.flotte || []).map((f) => `
    <div>${esc(f.platform)}</div>
    <div class="n">${f.aktiv}</div>
    <div class="n">${f.warmup||0}</div>
    <div class="n" style="${f.gesperrt?'color:var(--crit)':''}">${f.gesperrt||0}</div>
    <div><span class="lamp ${esc(f.health)}"></span></div>
    <div style="color:var(--faint);font-size:11px">${esc(f.hinweis||"")}</div>`).join("");
  el("m-flotte").innerHTML = head + rows;
}

function renderKunden() {
  const kn = DATA.kunden || { funnel: [], cards: [] };
  const funnel = `<div class="funnel">${(kn.funnel||[]).map((s)=>`<div class="fstep ${s.hot?'hot':''}"><div class="fn">${s.n}</div><div class="fl">${esc(s.label)}</div></div>`).join("")}</div>`;
  const cards = (kn.cards||[]).map((c)=>`<div class="kcard"><span class="pill ${esc(c.pill)}">${esc(c.status)}</span> ${esc(c.name)}<span class="kmeta">${esc(c.meta||"")}</span></div>`).join("")
    || `<div class="empty">Noch keine aktiven Kunden (vor Launch).</div>`;
  el("m-kunden").innerHTML = funnel + cards;
}

function renderCash() {
  const c = DATA.cash || {};
  const eur = (v) => (v == null ? "—" : fmt(v) + " €");
  const big = (n, l, cls) => `<div class="cashbig"><span class="cn ${cls || ""}">${n}</span><span class="cl">${l}</span></div>`;
  if (c.privat_eur == null && !c.burn_30d_eur) {
    el("m-cash").innerHTML = `<div class="empty">Keine Finanzdaten gefunden (${esc(c.quelle || "Quelle unbekannt")}).</div>`;
    return;
  }
  const stale = c.stichtag_veraltet;
  const stand = c.stichtag
    ? `<span class="stale ${stale ? "warn" : ""}">Stand ${esc(c.stichtag.slice(8) + "." + c.stichtag.slice(5, 7) + ".")}${c.stichtag_alter_tage != null ? ` · ${c.stichtag_alter_tage} Tage alt` : ""}${stale ? " · bitte nachtragen" : ""}</span>`
    : "";
  const k = (c.konten || {})[CASHVIEW] || {};
  const tabs = [["gesamt", "Gesamt"], ["privat", "Privat"], ["business", "Business"]]
    .map(([v, l]) => `<button class="ctab ${CASHVIEW === v ? "on" : ""}" data-cv="${v}">${l}</button>`).join("");

  // Runway: nur zeigen, wenn das Konto wirklich schrumpft — sonst waere es erfunden.
  const fw = c.fenster_tage || 90;
  let rw, rwl, rwc = "";
  if (k.traegt_sich) { rw = "trägt sich"; rwl = `Kein Schwund (${fw}-T-Schnitt)`; rwc = "up"; }
  else if (k.runway_mt == null || (k.verfuegbar_eur || 0) <= 0) { rw = "leer"; rwl = "Kein Puffer mehr"; rwc = "down"; }
  else {
    const tage = Math.round(k.runway_mt * 30);
    if (k.runway_mt > 24) { rw = "> 2 Jahre"; rwl = "Fast ausgeglichen"; rwc = "up"; }
    else if (tage <= 7) { rw = "jetzt"; rwl = "Aufladen fällig"; rwc = "down"; }
    else if (k.runway_mt < 1) { rw = `${tage} T`; rwl = "Reicht noch"; rwc = "down"; }
    else { rw = `${String(k.runway_mt).replace(".", ",")} Mt`; rwl = "Reicht noch"; rwc = k.runway_mt < 3 ? "warn" : ""; }
  }
  const le = k.letzter_eingang;
  const leTxt = le
    ? `Letzter echter Eingang: ${esc(le.datum.slice(8) + "." + le.datum.slice(5, 7) + ".")} · ${fmt(le.eur)} €${le.vor_tagen > 45 ? ` · vor ${le.vor_tagen} Tagen` : ""}`
    : "Keine echten Eingänge erfasst";
  const leWarn = !le || le.vor_tagen > 45;
  const nettoTxt = (k.netto_mt > 0 ? "+" : "") + fmt(k.netto_mt) + " €";
  const top = (c.top_ausgaben || []).map((t) =>
    `<div class="ins"><span class="idot info"></span>${esc(t.empfaenger)}<span class="isave info">${fmt(t.eur)} €</span></div>`).join("");

  el("m-cash").innerHTML = `
    <div class="ctabs">${tabs}<span class="cbasis">${esc(k.basis || "")}</span></div>
    <div class="cashrow">
      ${big(eur(k.verfuegbar_eur), "Verfügbar", (k.verfuegbar_eur || 0) <= 0 ? "down" : "")}
      ${big(rw, rwl, rwc)}
      ${big(nettoTxt, "Netto / Monat", k.netto_mt < 0 ? "down" : "up")}
      ${big(eur(k.ausgaben_mt), "Ausgaben / Monat")}
    </div>
    <div class="cash-stand">${stand}
      <span class="split">Saldo: Privat ${eur(c.privat_eur)} · Business ${eur(c.business_eur)}</span>
      <span class="split ${leWarn ? "warnx" : ""}" title="Letzte Gutschrift ab 100 € ohne Umbuchungen zwischen den eigenen Konten — unabhängig vom ${fw}-Tage-Fenster.">${leTxt}</span>
      ${k.transfer_mt ? `<span class="split">${CASHVIEW === "business" ? "Aufladung von Privat" : "Abfluss ans Business"}: ${(k.transfer_mt > 0 ? "+" : "")}${fmt(k.transfer_mt)} €/Mt · in keiner Netto-Zahl (nur verschoben)</span>` : ""}
    </div>
    ${top ? `<div class="insights"><div class="ins-head">Größte Abgänge (${c.fenster_tage || 90} Tage, ohne Umbuchungen)</div>${top}</div>` : ""}
    <div class="csv-note">Kontostand manuell gepflegt (build_forecast.py) · Buchungen bis ${esc(c.buchungen_bis || "—")}<br>
      ${esc(c.hinweis || "")}</div>`;

  el("m-cash").querySelectorAll(".ctab").forEach((b) =>
    b.addEventListener("click", () => { CASHVIEW = b.dataset.cv; renderCash(); }));
}

/* ---------- Eskalationen (sheet-50) ----------
   Zeigt pro SOP EINEN Eintrag, nicht pro Log-Zeile: eine kaputte SOP schreibt bei jedem Lauf
   eine neue Zeile (Trends: 12 Zeilen fuer ein Problem). Drei Zustaende:
     offen     -> wartet wirklich auf dich (zaehlt im Badge)
     auto      -> dieselbe SOP lief spaeter wieder erfolgreich; Beweis steht dabei, nicht geloescht
     quittiert -> von dir abgehakt; kommt zurueck, sobald die SOP erneut eskaliert            */
const ESK_LABEL = { offen: "offen", auto: "vermutlich erledigt", quittiert: "quittiert" };
let ESK_OFFEN_ONLY = true;

function eskAlter(i) {
  if (i.vor_tagen == null) return "";
  return i.vor_tagen === 0 ? "heute" : i.vor_tagen === 1 ? "vor 1 Tag" : `vor ${i.vor_tagen} Tagen`;
}

function renderEskalationen() {
  const e = DATA.eskalationen || {};
  const alle = e.items || [];
  const card = el("card-esk"), badge = el("esk-badge");
  const offen = e.offen_sandro || 0;

  if (badge) {
    badge.hidden = offen === 0;
    badge.textContent = offen === 1 ? "1 ESKALATION OFFEN" : `${offen} ESKALATIONEN OFFEN`;
    // onclick (nicht addEventListener): renderEskalationen laeuft mehrfach, sonst stapeln sich Listener.
    badge.onclick = () => card && card.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (!card) return;
  card.hidden = alle.length === 0;
  if (!alle.length) return;

  const items = ESK_OFFEN_ONLY ? alle.filter((i) => i.status === "offen") : alle;
  const erledigt = (e.auto_erledigt || 0) + (e.quittiert || 0);

  const kopf = `<div class="eskhead">
      <span class="eskbig ${offen ? "crit" : "ok"}">${offen}</span>
      <span class="eskbiglbl">${offen === 1 ? "Eskalation wartet auf dich" : "Eskalationen warten auf dich"}${
        e.offen_andere ? ` · <span class="muted2">${e.offen_andere} an andere</span>` : ""}</span>
      <button class="eskfilter ${ESK_OFFEN_ONLY ? "on" : ""}" id="esk-toggle">${
        ESK_OFFEN_ONLY ? `${erledigt} erledigte einblenden` : "nur offene zeigen"}</button>
    </div>`;

  const liste = items.length
    ? items.map((i, n) => {
        const an = (i.an || []).map((a) => (a === "sandro" ? "an dich" : "an " + a)).join(" · ");
        const wiederholt = i.anzahl > 1 ? `<span class="eskrep">${i.anzahl}× eskaliert</span>` : "";
        const beweis = i.beweis ? `<div class="eskbeweis">✓ ${esc(i.beweis)}</div>` : "";
        const knopf = i.status === "quittiert"
          ? `<button class="btn" data-esk="unack" data-i="${n}">Wieder öffnen</button>`
          : `<button class="btn" data-esk="ack" data-i="${n}">Erledigt</button>`;
        return `<div class="eskitem ${i.status}">
          <div class="eskrow1">
            <span class="eskdot ${i.status}"></span>
            <span class="esksop">${esc(i.sop)}</span>
            <span class="eskmeta">${esc(an)}${wiederholt ? " · " : ""}${wiederholt}</span>
            <span class="eskzeit">${esc(i.zuletzt)} · ${esc(eskAlter(i))}</span>
          </div>
          ${beweis}
          <div class="eskgrund">${esc(i.grund || i.fehler || "(kein Grund im Log)")}</div>
          <div class="eskbtns">
            ${knopf}
            <button class="btn" data-esk="claude" data-i="${n}">An Claude übergeben</button>
            <span class="eskstatus">${ESK_LABEL[i.status]}</span>
          </div>
        </div>`;
      }).join("")
    : `<div class="empty">Nichts offen — alle Eskalationen sind erledigt oder quittiert.</div>`;

  el("m-esk").innerHTML = kopf + `<div class="esklist">${liste}</div>`;

  const tgl = el("esk-toggle");
  if (tgl) tgl.addEventListener("click", () => { ESK_OFFEN_ONLY = !ESK_OFFEN_ONLY; renderEskalationen(); });

  el("m-esk").querySelectorAll("button[data-esk]").forEach((b) =>
    b.addEventListener("click", () => eskAktion(b, items[+b.dataset.i])));
}

function eskAktion(btn, i) {
  if (!i) return;
  if (btn.dataset.esk === "claude") {
    const auftrag = `Eskalation aus sheet-50-sop-execution-log abarbeiten.\n\n`
      + `SOP: ${i.sop}\nEskaliert an: ${(i.an || []).join(", ")}\n`
      + `Zuletzt: ${i.zuletzt} (${i.anzahl}× eskaliert)\n\nGrund laut Log:\n${i.grund}\n\n`
      + `Fehler-Detail:\n${i.fehler || "(keins)"}\n\n`
      + `Bitte pruefen, Ursache benennen und einen Loesungsvorschlag als Entwurf ablegen. `
      + `Nichts an Live-Sheets schreiben, nichts nach aussen senden.`;
    btn.disabled = true; btn.textContent = "…";
    api("dz_enqueue", { token: state.token, titel: "Eskalation " + i.sop, auftrag, quelle: "eskalation" })
      .then((j) => { toast(j.ok ? "An Claude übergeben → Queue: " + j.file : "Fehler: " + (j.error || "?"));
        btn.textContent = j.ok ? "✓ in Queue" : "An Claude übergeben"; btn.disabled = !j.ok; })
      .catch((e) => { toast("Übergabe fehlgeschlagen: " + (e && e.message ? e.message : e));
        btn.disabled = false; btn.textContent = "An Claude übergeben"; });
    return;
  }
  const action = btn.dataset.esk;                    // ack | unack
  btn.disabled = true;
  api("dz_esk_ack", { token: state.token, sop: i.sop, bis: i.zuletzt_raw, action })
    .then((j) => {
      if (!j.ok) { toast("Fehler: " + (j.error || "?")); btn.disabled = false; return; }
      // Optimistisch neu zeichnen: summary.json wird erst beim naechsten Collector-Lauf neu geschrieben.
      i.status = action === "ack" ? "quittiert" : "offen";
      const e = DATA.eskalationen;
      e.offen_sandro = (e.items || []).filter((x) => x.status === "offen" && (x.an || []).includes("sandro")).length;
      e.quittiert = (e.items || []).filter((x) => x.status === "quittiert").length;
      toast(action === "ack" ? "Quittiert — kommt zurück, wenn die SOP erneut eskaliert." : "Wieder geöffnet.");
      renderEskalationen();
    })
    .catch((e) => { toast("Abhaken fehlgeschlagen: " + (e && e.message ? e.message : e));
      btn.disabled = false; });
}

function renderFill() {
  const fq = DATA.fill_queue || {};
  const rows = (DATA.fill||[]).map((f)=>{
    const pct = Math.min(100, Math.round(f.have/f.target*100));
    return `<div class="fillrow"><span class="fname">${esc(f.model)}</span><span class="fbar"><i class="${pct>=100?'full':''}" style="width:${pct}%"></i></span><span class="fnum">${f.have}/${f.target}</span></div>`;
  }).join("") || `<div class="empty">Noch keine aktiven Model-Accounts erfasst.</div>`;
  el("m-fill").innerHTML = rows + `<div class="fillq">Heute Nacht: <b>${fq.create||0} Accounts erstellen</b> · <b>${fq.warmup||0} im Warmup</b>${fq.hinweis?" · "+esc(fq.hinweis):""}</div>`;
}

function renderTimeline() {
  const tl = DATA.timeline || [];
  const nextIdx = tl.findIndex((t)=>!t.done);
  el("m-timeline").innerHTML = tl.map((t,i)=>`
    <div class="tlrow ${t.done?'done':''} ${i===nextIdx?'next':''}">
      <span class="tcheck">${t.done?'✓':''}</span><span class="tz">${esc(t.zeit)}</span><span class="tlabel">${esc(t.label)}</span>
    </div>`).join("");
}

function renderQc() {
  const q = DATA.qc || {};
  const big = (n,l)=>`<div class="qcbig"><span class="qn">${n}</span><span class="ql">${l}</span></div>`;
  el("m-qc").innerHTML = `<div class="qcgrid">
    ${big(q.pending||0,"Pending")}${big(q.in_review||0,"In Review")}${big(q.heute||0,"Heute rein")}${big((q.auslastung_std||0)+" h","Auslastung/Tag")}
    </div><div style="margin-top:12px;font-size:12px;color:var(--muted)">NSFW ${q.nsfw||0} · SFW ${q.sfw||0} — Prüfung im <a href="#" id="os-qc-link">Review-Tab ↗</a> (Tier-0 Sandro bis VAs onboardet)</div>`;
  const link = el("os-qc-link");
  if (link) link.onclick = (e) => { e.preventDefault(); const sel = document.getElementById("mode-select");
    if (sel){ sel.value = "review"; state.mode = "review"; state.typ = null; dzSwitchMode(); } };
}

function renderTasks() {
  const filters = [["alle","Alle"],["sandro","Sandro"],["claude","Claude"],["bodo","Bodo"],["va","VA"]];
  el("m-taskbar").innerHTML = filters.map(([k,l])=>`<button class="tfilter ${TFILTER===k?'on':''}" data-tf="${k}">${l}</button>`).join("");
  const cols = [["offen","Offen"],["in-arbeit","In Arbeit"],["review","Review"],["blockiert","Blockiert"],["erledigt","Erledigt"]];
  let tasks = DATA.tasks || [];
  if (TFILTER !== "alle") tasks = tasks.filter((t)=>(t.owner||"").toLowerCase().startsWith(TFILTER));
  el("m-tasks").innerHTML = cols.map(([st,lbl])=>{
    const items = tasks.filter((t)=>(t.status||"offen")===st);
    return `<div class="tcol"><div class="tcolh"><span>${lbl}</span><span>${items.length}</span></div>
      ${items.map((t)=>`<div class="tcard">${esc(t.titel)}<div class="towner">@${esc(t.owner||"—")}<span class="osrc">${esc(t.quelle||"")}</span></div></div>`).join("") || '<div style="color:var(--faint);font-size:11px">—</div>'}</div>`;
  }).join("");
}

function renderFoot() {
  el("foot").innerHTML = `<b>Quellen:</b> 64 Live-Sheets (read-only) · Slugs je Karte oben rechts · Cash aus finanzen-pipeline · Prioritäten/Tasks kuratiert. ·
    <b>Klick:</b> KPIs → Aufschlüsselung pro Creator · Prioritäten → Auftrag an Claude · Inbox → qc-review-app / Sheet-Zeile.`;
  const w = DATA.warnings || [];
  const wb = el("warnbox");
  if (w.length) { wb.classList.add("show"); wb.innerHTML = `Collector-Hinweise (${w.length}):<ul>${w.map((x)=>`<li>${esc(x)}</li>`).join("")}</ul>`; }
  else wb.classList.remove("show");
}

function renderAll() {
  renderHeader(); renderBriefing(); renderEskalationen(); renderKpis(); renderWorkboard(); renderPrio();
  renderInbox(); renderPuls(); renderFlotte(); renderKunden(); renderCash(); renderFill(); renderTimeline();
  renderQc(); renderTasks(); renderFoot();
}

/* ---------- Drilldown ---------- */
function openDrill(key) {
  const bd = DATA.creator_breakdown || [];
  const titles = { umsatz: "Umsatz", gewinn: "Gewinn", views: "Views", klicks: "Link-Klicks" };
  const d = el("drill");
  if (!bd.length) {
    d.innerHTML = `<h3>${titles[key]} nach Creator<button class="close">schließen ✕</button></h3><div class="dempty">Noch keine Creator-Daten im Snapshot (System vor Launch). Sobald sheet-45/32/37 Zeilen führen, erscheint hier die Aufschlüsselung.</div>`;
  } else {
    const rows = bd.slice().sort((a,b)=>(b[key]||0)-(a[key]||0));
    const cell = (c, mkey) => `<div class="n" style="${mkey===key?'color:var(--accent)':''}">${mkey==='umsatz'||mkey==='gewinn'?fmt(c[mkey])+' €':fmt(c[mkey])}</div>`;
    d.innerHTML = `<h3>${titles[key]} nach Creator<button class="close">schließen ✕</button></h3>
      <div class="dtable">
        <div class="h">Creator</div><div class="h n">Umsatz</div><div class="h n">Gewinn</div><div class="h n">Views</div><div class="h n">Klicks</div>
        ${rows.map((c)=>`<div>${esc(c.name)}<span class="arm">${esc((c.arm||"").toUpperCase())}</span></div>${cell(c,"umsatz")}${cell(c,"gewinn")}${cell(c,"views")}${cell(c,"klicks")}`).join("")}
      </div>`;
  }
  d.classList.add("open");
  d.querySelector(".close").addEventListener("click", () => d.classList.remove("open"));
  d.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------- Toast ---------- */
function toast(msg) {
  let t = el("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast";
    t.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:var(--panel);border:1px solid var(--accent-dim);color:var(--ink);font-family:var(--mono);font-size:12px;padding:10px 16px;border-radius:6px;z-index:50;max-width:80vw";
    // im Cockpit-Container, nicht body: nur dort sind die --panel/--ink-Variablen definiert (Scope)
    (el("cockpit-view") || document.body).appendChild(t); }
  t.textContent = msg; t.style.opacity = "1";
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.opacity = "0"; }, 3200);
}

/* ---------- Aktualisieren (Marker-Datei -> PC-Poll -> Collector) ---------- */
async function doRefresh() {
  const b = el("btn-refresh");
  b.disabled = true; b.textContent = "↻ Angefordert…";
  try {
    const r = await api("dz_refresh", { token: state.token });
    toast(r && r.ok ? (r.hinweis || "Angefordert — der PC holt die Zahlen beim nächsten 10-min-Check.")
                    : "Fehler: " + ((r && r.error) || "?"));
  } catch (e) {
    toast("Anforderung fehlgeschlagen: " + (e && e.message ? e.message : e));
  }
  b.disabled = false; b.textContent = "↻ Aktualisieren";
}

/* ---------- Events ---------- */
function wireEvents() {
  el("btn-refresh").addEventListener("click", doRefresh);
  $("#arms").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$(".arms button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
    ARM = b.dataset.arm; renderKpis();
  });
  $("#range").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$(".range button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
    RANGE = b.dataset.range; renderKpis();
  });
  $$(".kpi").forEach((c) => {
    const open = () => openDrill(c.dataset.kpi);
    c.addEventListener("click", open);
    c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
  el("m-prio").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (btn) {
      e.stopPropagation();
      const p = DATA.prioritaeten[+btn.dataset.i];
      if (btn.dataset.act === "copy") { navigator.clipboard && navigator.clipboard.writeText(p.auftrag); toast("Prompt kopiert — in Claude Code einfügen."); }
      else {
        btn.disabled = true; btn.textContent = "…";
        api("dz_enqueue", { token: state.token, titel: p.titel, auftrag: p.auftrag, quelle: "prio" })
          .then((j) => { toast(j.ok ? "An Claude übergeben → Queue: " + j.file : "Fehler: " + (j.error || "?")); btn.textContent = j.ok ? "✓ in Queue" : "An Claude übergeben"; btn.disabled = !j.ok; })
          .catch((e) => { toast("Übergabe fehlgeschlagen: " + (e && e.message ? e.message : e)); btn.disabled = false; btn.textContent = "An Claude übergeben"; });
      }
      return;
    }
    const item = e.target.closest(".pitem"); if (!item) return;
    const wasOpen = item.classList.contains("open");
    $$(".pitem").forEach((x) => x.classList.remove("open"));
    if (!wasOpen) item.classList.add("open");
  });
  el("m-taskbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tf]"); if (!b) return;
    TFILTER = b.dataset.tf; renderTasks();
  });
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-link]"); if (a) { e.preventDefault(); toast("Deep-Link (Live): " + a.dataset.link + " — öffnet Sheet-Zeile / qc-review-app."); }
  });
}
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ---------- Boot ---------- */
async function loadData() {
  const r = await api("dz_cockpit", { token: state.token });   // api/state = QC-App-Globals
  if (!r || !r.ok) throw new Error((r && r.error) || "dz_cockpit fehlgeschlagen");
  const j = r.summary || {};
  j._live = true;
  j._stand = r.stand || "";
  return j;
}

function setBadge() {
  const b = el("mode-badge");
  const empty = !(DATA.kpis && DATA.kpis.umsatz && DATA.kpis.umsatz.gesamt);
  b.className = "badge live";
  b.textContent = empty ? "LIVE · noch kein Umsatz" : "LIVE";
}

function showNoData(msg) {
  const b = el("mode-badge");
  b.className = "badge demo"; b.textContent = "KEINE DATEN";
  el("m-briefing").innerHTML = "";
  el("grid").innerHTML = `<section class="card" style="grid-column:1/-1">
    <div class="eyebrow">Keine Daten geladen</div>
    <div style="font-size:13px;line-height:1.6;color:var(--muted)">
      Der Cockpit-Snapshot ist nicht ladbar (${esc(msg)}).<br><br>
      Die Zahlen kommen vom Collector auf dem PC (2× täglich + auf Anforderung) über das Drive.
      Läuft der PC bzw. wurde <code>dzAuthorize</code> im Script-Editor schon einmal ausgeführt
      (Drive-Berechtigung)? Danach hier neu laden.
    </div></section>`;
}

/* Export: Die QC-App (dz.js) ruft osMount() beim Wechsel in den Cockpit-Modus.
   Events werden nur EINMAL verkabelt — Mount kann beliebig oft laufen (Tab-Wechsel). */
let WIRED = false;
window.osMount = async function () {
  try {
    DATA = await loadData();
  } catch (e) {
    showNoData(e.message || String(e));
    return;
  }
  setBadge(); renderAll();
  if (!WIRED) { wireEvents(); WIRED = true; }
};

})();
