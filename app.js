/* QC-Review-App — Front-end. Vanilla JS, kein Build-Schritt. V2 (W2-Haertung + Typ-Tabs, 2026-07-02).
   Demo-Modus laeuft ohne Backend; fuer live CONFIG.BACKEND_URL setzen + DEMO_MODE=false.
   Reviewer entscheidet NUR approve/reject (OK/nicht-OK) + Grund. Ob revision/neu erstellt wird,
   entscheidet das System (sop-09-05), nicht der Mensch.
   V2: Typ-Tabs (Board je Content-Typ inkl. Skript — Sandro-Vorgabe D22), XSS-sichere DOM-Erzeugung
   (kein innerHTML mit Sheet-Daten), try/catch um alle API-Aufrufe (Button haengt nicht mehr),
   Skript-Items als Text, Tastatur (A/R, 1-5, Enter), Verdienst als Basis-Stuecklohn gelabelt,
   Screening via Test-Ref (?test=...) mit Server-Scoring. */

const CONFIG = {
  BACKEND_URL: "",        // <- /exec-URL der Apps-Script-Web-App eintragen
  DEMO_MODE: true,        // <- fuer Live-Betrieb auf false
  QUOTA_PCT: 30,          // qc-begruendung-quote-prozent (Default; live aus sheet-48)
  RATE: { Bild: 0.025, Video: 0.06, "editiertes-Video": 0.06, Skript: 0.05, Plan: 0.10, Konzept: 0.10 }
};
const TYPES = ["Bild","Video","editiertes-Video","Skript","Plan","Konzept"];

const $ = (id) => document.getElementById(id);
const state = { token:null, testRef:null, role:null, name:null, vaId:null, mode:"review", typ:null,
                item:null, decision:null, rating:0, busy:false,
                done:0, described:0, agree:0, agreeBase:0, earn:0,
                scrTotal:0, scrCorrect:0, scrServer:null };

/* ---------- Platzhalter-Bilder (nur Demo) ---------- */
function ph(label, hue){
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='380'>
    <rect width='300' height='380' fill='hsl(${hue} 32% 86%)'/>
    <circle cx='150' cy='140' r='58' fill='hsl(${hue} 30% 70%)'/>
    <rect x='70' y='214' width='160' height='150' rx='70' fill='hsl(${hue} 30% 70%)'/>
    <text x='150' y='360' font-family='sans-serif' font-size='15' fill='hsl(${hue} 25% 38%)' text-anchor='middle'>${label}</text>
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/* ---------- Demo-Backend (in-JS) ---------- */
const DEMO = {
  users: {
    sandro:  { pass:"demo", role:"admin", name:"Sandro", vaId:"" },
    "va-007":{ pass:"demo", role:"va",    name:"Maria",  vaId:"va-007" }
  },
  creators: {
    luna:{ name:"Luna", hue:265 }, mia:{ name:"Mia", hue:165 },
    aria:{ name:"Aria", hue:18 }, nora:{ name:"Nora", hue:330 }
  },
  queue:[
    { creator:"luna", typ:"Bild",   src:"sop-05-05 · PPV",  vaDecision:"approve" },
    { creator:"mia",  typ:"Bild",   src:"sop-02-01 · Feed", vaDecision:"approve" },
    { creator:"aria", typ:"Video",  src:"sop-03-01 · Reel", vaDecision:"reject"  },
    { creator:"luna", typ:"Skript", src:"sop-01-32 · Reel-Skript", vaDecision:"approve",
      text:"Reel reel-00412 · reel\n\nHOOK (0-1s): \"POV: dein Gym-Crush merkt, dass du seine Playlist hoerst\" — Close-up, direkter Blick.\n\nBODY: 3 Cuts auf Beat. Cut 1: Kopfhoerer rein, Blick zur Seite. Cut 2: Lip-sync Zeile 1, Haare zurueck. Cut 3: Lachen, Kamera-Schwenk.\n\nENDPART: Text-Overlay \"folg mir fuer Teil 2\" + Zwinkern.\n\n— Caption —\ner hat es gemerkt... 🙈 #gymtok #playlist" },
    { creator:"nora", typ:"Bild",   src:"sop-02-01 · Feed", vaDecision:"approve" },
    { creator:"mia",  typ:"Skript", src:"sop-01-32 · Carousel", vaDecision:"reject",
      text:"Reel reel-00415 · carousel\n\n[Slide 1/4 · Hook] \"3 Dinge, die ich vor 10k Followern gern gewusst haette\" — Bild: Spiegel-Selfie, Text-Overlay gross.\n\n[Slide 2/4 · Value] Konsistenz schlaegt Perfektion — Bild: Schreibtisch-Szene.\n\n[Slide 3/4 · Value] Hooks entscheiden alles — Bild: Nahaufnahme.\n\n[Slide 4/4 · CTA] \"Speichern + folgen fuer mehr\" — Bild: Winken." },
    { creator:"aria", typ:"Video",  src:"sop-05-05 · PPV",  vaDecision:"approve" }
  ],
  golden:[
    { creator:"luna", typ:"Bild", gt:"approve" }, { creator:"mia",  typ:"Bild", gt:"reject"  },
    { creator:"aria", typ:"Bild", gt:"approve" }, { creator:"nora", typ:"Bild", gt:"reject"  },
    { creator:"luna", typ:"Video",gt:"reject"  }, { creator:"mia",  typ:"Bild", gt:"approve" }
  ],
  gIdx:0, done:new Set()
};
function demoRef(cKey){
  const c = DEMO.creators[cKey];
  return Array.from({length:4}, (_,i) => ({ url: ph(c.name.toLowerCase()+" #"+(i+1), c.hue), label:c.name }));
}
function demoItem(raw, idx, prefix){
  const c = DEMO.creators[raw.creator];
  const asset = raw.typ === "Skript"
    ? { kind:"text", text: raw.text || "Skript-Text (Demo)" }
    : { kind:"image", url: ph(c.name.toLowerCase()+" · "+(raw.typ==="Video"?"clip":"img")+"-"+(idx%9+1), c.hue) };
  return {
    itemId: prefix + String(4821+idx),
    contentTyp: raw.typ, sourceSop: raw.src || "golden-set",
    creatorId: raw.creator, creatorName: c.name,
    asset, vaDecision: raw.vaDecision || null,
    reference: demoRef(raw.creator),
    _gt: raw.gt || null, _idx: idx
  };
}
function demoSummary(){
  const out = {}; TYPES.forEach(t=>out[t]=0);
  DEMO.queue.forEach((q,i)=>{ if(!DEMO.done.has(i)) out[q.typ]++; });
  return out;
}

/* ---------- API (Demo oder echt) ---------- */
async function api(action, body){
  if (CONFIG.DEMO_MODE) return demoApi(action, body);
  if (!CONFIG.BACKEND_URL) return { ok:false, error:"Backend nicht konfiguriert (CONFIG.BACKEND_URL)." };
  const res = await fetch(CONFIG.BACKEND_URL, {
    method:"POST", headers:{ "Content-Type":"text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ action }, body))
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
function demoApi(action, body){
  if (action === "login"){
    const u = DEMO.users[(body.username||"").toLowerCase()];
    if (!u || u.pass !== body.password) return { ok:false, error:"Falsche Zugangsdaten." };
    return { ok:true, token:"demo", role:u.role, name:u.name, vaId:u.vaId };
  }
  if (action === "next"){
    if (body.mode === "screening"){
      if (DEMO.gIdx >= DEMO.golden.length)
        return { ok:true, item:null, stats:{ done:DEMO.gIdx, total:DEMO.golden.length, finished:true,
          scorePct: state.scrTotal ? Math.round(state.scrCorrect/state.scrTotal*100) : 0 } };
      const it = demoItem(DEMO.golden[DEMO.gIdx], DEMO.gIdx, "gold-");
      return { ok:true, item:it, reference:[], stats:{ done:DEMO.gIdx, total:DEMO.golden.length } };
    }
    const idx = DEMO.queue.findIndex((q,i)=> !DEMO.done.has(i) && (!body.typ || q.typ===body.typ));
    if (idx < 0) return { ok:true, item:null, stats:demoStats(body.mode), queueSummary:demoSummary() };
    const it = demoItem(DEMO.queue[idx], idx, "qc-00");
    return { ok:true, item:it, reference:it.reference, stats:demoStats(body.mode), queueSummary:demoSummary() };
  }
  if (action === "submit"){
    if (body.mode === "screening"){
      const gt = (state.item && state.item._gt);
      state.scrTotal++; if (gt && gt === body.decision) state.scrCorrect++;
      DEMO.gIdx++;
      return { ok:true, stats:{ done:DEMO.gIdx, total:DEMO.golden.length } };
    }
    state.done++;
    if ((body.begruendung||"").trim()) state.described++;
    state.earn += CONFIG.RATE[body.contentTyp] || 0.025;
    if (body.mode === "spotcheck"){ state.agreeBase++; if (body.decision === body.vaDecision) state.agree++; }
    if (state.item && state.item._idx != null) DEMO.done.add(state.item._idx);
    return { ok:true, stats:demoStats(body.mode) };
  }
  return { ok:false, error:"unknown action" };
}
function demoStats(mode){
  const need = Math.ceil(state.done * CONFIG.QUOTA_PCT/100);
  const agreePct = mode==="spotcheck" && state.agreeBase ? Math.round(state.agree/state.agreeBase*100) : 92;
  return { done:state.done, agreementPct:agreePct, describedToday:state.described,
           neededToday:need, earningsToday:state.earn };
}

/* ---------- Render (XSS-sicher: nur createElement/textContent fuer dynamische Daten) ---------- */
function initials(s){ return (s||"?").replace(/[^a-zA-ZäöüÄÖÜ ]/g,"").split(/\s|-/).map(w=>w[0]).join("").slice(0,2).toUpperCase(); }
function clear(el){ while (el.firstChild) el.removeChild(el.firstChild); }

function renderTabs(summary){
  const bar = $("typ-tabs");
  if (!bar) return;
  clear(bar);
  if (!summary || state.mode === "screening"){ bar.hidden = true; return; }
  const entries = TYPES.map(t => [t, summary[t]||0]);
  const total = entries.reduce((s,[,n])=>s+n,0);
  bar.hidden = false;
  const mk = (label, count, typVal) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tbtn" + ((state.typ||null)===typVal ? " active" : "");
    const lab = document.createElement("span"); lab.textContent = label;
    const cnt = document.createElement("span"); cnt.className = "tcount"; cnt.textContent = String(count);
    b.appendChild(lab); b.appendChild(cnt);
    b.onclick = () => { state.typ = typVal; loadNext(); };
    bar.appendChild(b);
  };
  mk("Alle", total, null);
  entries.forEach(([t,n]) => { if (n > 0 || state.typ === t) mk(t, n, t); });
}

function renderAsset(asset, contentTyp){
  const box = $("asset");
  clear(box);
  if (!asset){ const d=document.createElement("div"); d.className="asset-empty"; d.textContent="Kein Asset."; box.appendChild(d); return; }
  if (asset.kind === "text"){
    box.classList.add("asset-text");
    const pre = document.createElement("pre");
    pre.className = "skript-text";
    pre.textContent = asset.text || "";
    box.appendChild(pre);
  } else {
    box.classList.remove("asset-text");
    const img = document.createElement("img");
    img.alt = "Zu pruefendes " + (contentTyp||"Item");
    img.onerror = () => { clear(box); const d=document.createElement("div"); d.className="asset-empty";
      d.textContent = "Asset konnte nicht geladen werden — Link pruefen."; box.appendChild(d); };
    img.src = asset.url || "";
    box.appendChild(img);
  }
}

function renderItem(item, reference, stats, summary){
  state.item = item; state.decision = null; state.rating = 0;
  $("review-hint").textContent = "";
  $("just").value = ""; $("just").classList.remove("req");
  document.querySelectorAll(".dbtn").forEach(b=>b.className="dbtn");
  updateJustLabel(); renderStars(); renderTabs(summary);

  if (!item){
    if (state.mode === "screening") return showScreeningResult(stats);
    clear($("asset"));
    const d = document.createElement("div"); d.className = "asset-empty";
    d.textContent = state.typ ? ("Keine Items im Tab „"+state.typ+"“.") : "Keine Items in der Queue. ✓";
    $("asset").appendChild(d);
    $("item-id").textContent="–"; $("item-typ").textContent="–"; $("item-source").textContent="–";
    $("va-original").hidden = true; $("next-btn").disabled = true; clear($("ref-grid"));
    applyStats(stats);
    return;
  }
  $("next-btn").disabled = false;
  $("item-id").textContent = item.itemId;
  $("item-typ").textContent = item.contentTyp;
  $("item-source").textContent = item.sourceSop;
  renderAsset(item.asset, item.contentTyp);

  // Spot-Check: die VA-Entscheidung zeigen (textContent — kein innerHTML mit Sheet-Daten)
  const vo = $("va-original");
  if (state.mode === "spotcheck" && item.vaDecision){
    vo.hidden = false; clear(vo);
    vo.appendChild(document.createTextNode("VA-Entscheidung: "));
    const strong = document.createElement("strong"); strong.textContent = String(item.vaDecision);
    vo.appendChild(strong);
    vo.appendChild(document.createTextNode(" — stimmst du zu? (bei Abweichung Begründung Pflicht)"));
  } else vo.hidden = true;

  // Referenz-Galerie (nicht im Screening)
  const grid = $("ref-grid");
  clear(grid);
  $("ref-name").textContent = item.creatorName ? "Creator: "+item.creatorName : "–";
  $("ref-avatar").textContent = initials(item.creatorName);
  if (state.mode !== "screening" && reference && reference.length){
    reference.forEach(r => {
      const th = document.createElement("div"); th.className = "thumb";
      const img = document.createElement("img");
      img.alt = "Approved " + String(r.label||""); img.src = String(r.url||"");
      img.onerror = () => { th.remove(); };
      const ok = document.createElement("span"); ok.className = "ok"; ok.textContent = "✓";
      th.appendChild(img); th.appendChild(ok); grid.appendChild(th);
    });
  }
  applyStats(stats);
}

function renderStars(){
  const wrap = $("rating-stars"); clear(wrap);
  for (let i=1;i<=5;i++){
    const s=document.createElement("span");
    s.className="star"+(i<=state.rating?" on":""); s.textContent="★";
    s.setAttribute("role","radio"); s.setAttribute("aria-checked", i===state.rating);
    s.tabIndex = 0;
    s.onclick=()=>{ state.rating=i; renderStars(); };
    s.onkeydown=(e)=>{ if(e.key===" "||e.key==="Enter"){ e.preventDefault(); state.rating=i; renderStars(); } };
    wrap.appendChild(s);
  }
}
function applyStats(st){
  if (!st) return;
  if (state.mode === "screening"){
    $("st-done").textContent = (st.done!=null? st.done : state.scrTotal) + (st.total? "/"+st.total : "");
    $("st-agree").textContent = "Test läuft";
    $("st-quota").textContent = "—"; $("st-earn").textContent = "—";
    return;
  }
  $("st-done").textContent = st.done;
  $("st-agree").textContent = (st.agreementPct!=null?st.agreementPct+"%":"–");
  $("st-quota").textContent = st.describedToday + "/" + st.neededToday;
  $("st-earn").textContent = (st.earningsToday||0).toFixed(2).replace(".",",") + " €";
  const pct = st.neededToday ? Math.min(100, Math.round(st.describedToday/st.neededToday*100)) : 100;
  const bar = $("quota-bar");
  bar.style.width = pct+"%";
  bar.classList.toggle("under", st.describedToday < st.neededToday);
  $("quota-text").textContent = st.describedToday + " / " + st.neededToday + " nötig (" + CONFIG.QUOTA_PCT + "%)";
}

/* ---------- Interaktion ---------- */
function selectDecision(d, btn){
  state.decision = d;
  document.querySelectorAll(".dbtn").forEach(b=>b.className="dbtn");
  if (btn) btn.classList.add("sel-"+d);
  else { const b=document.querySelector('.dbtn[data-d="'+d+'"]'); if (b) b.classList.add("sel-"+d); }
  updateJustLabel(); $("review-hint").textContent=""; $("just").classList.remove("req");
}
function updateJustLabel(){
  const lbl = $("just-label");
  const mustReject = (state.decision==="reject");
  const mustDisagree = (state.mode==="spotcheck" && state.item && state.decision && state.decision!==state.item.vaDecision);
  if (mustReject || mustDisagree)
    lbl.innerHTML = 'Begründung <span class="req">* Pflicht</span>';
  else
    lbl.innerHTML = 'Begründung <span class="opt">(optional — zählt zur '+CONFIG.QUOTA_PCT+'%-Quote)</span>';
}

async function onNext(){
  if (state.busy) return;
  if (!state.item){ return; }
  if (!state.decision){ $("review-hint").textContent = "Bitte zuerst Approve oder Reject wählen."; return; }
  const just = $("just").value.trim();
  const needReject = (state.decision==="reject");
  const needDisagree = (state.mode==="spotcheck" && state.item && state.decision!==state.item.vaDecision);
  let needQuota = false;
  if (state.mode==="review"){
    const describedAfter = state.described + (just?1:0);
    needQuota = state.done >= 1 && (describedAfter/(state.done+1)) < (CONFIG.QUOTA_PCT/100);
  }
  if ((needReject || needDisagree || needQuota) && !just){
    $("review-hint").textContent = (needReject || needDisagree)
      ? "Begründung ist Pflicht (Reject bzw. Abweichung)."
      : "Begründungs-Quote: mind. "+CONFIG.QUOTA_PCT+"% — bitte dieses Item kurz begründen.";
    $("just").classList.add("req"); $("just").focus(); return;
  }
  state.busy = true; $("next-btn").disabled = true;
  try {
    const r = await api("submit", { token:state.token, test:state.testRef, mode:state.mode,
      itemId:state.item.itemId, typ:state.typ||"",
      decision:state.decision, rating:state.rating, begruendung:just,
      contentTyp:state.item.contentTyp, vaDecision:state.item.vaDecision });
    if (!r || !r.ok){
      $("review-hint").textContent = (r && r.error) || "Fehler beim Speichern.";
      if (r && r.quota){ $("just").classList.add("req"); $("just").focus(); }
      state.busy=false; $("next-btn").disabled=false; return;
    }
    if (state.mode==="review" && !CONFIG.DEMO_MODE && r.stats){ state.done=r.stats.done; state.described=r.stats.describedToday; }
    if (r.stats && r.stats.finished) state.scrServer = r.stats;
    state.busy = false;
    await loadNext();
  } catch(err){
    $("review-hint").textContent = "Netzwerk-/Serverfehler: " + (err && err.message ? err.message : err);
    state.busy=false; $("next-btn").disabled=false;
  }
}

async function loadNext(){
  try {
    const r = await api("next", { token:state.token, test:state.testRef, mode:state.mode, typ:state.typ||"" });
    if (!r || !r.ok){ $("review-hint").textContent = (r && r.error)||"Fehler beim Laden."; return; }
    if (state.mode==="review" && !CONFIG.DEMO_MODE && r.stats){ state.done=r.stats.done||0; state.described=r.stats.describedToday||0; }
    renderItem(r.item, r.reference, r.stats, r.queueSummary);
  } catch(err){
    $("review-hint").textContent = "Netzwerk-/Serverfehler: " + (err && err.message ? err.message : err);
    $("next-btn").disabled = false;
  }
}

function showScreeningResult(stats){
  document.querySelector(".workspace").hidden = true;
  document.querySelector(".statbar").hidden = true;
  const tb = $("typ-tabs"); if (tb) tb.hidden = true;
  const server = state.scrServer || stats || {};
  const pct = (server.scorePct!=null) ? server.scorePct
            : (state.scrTotal ? Math.round(state.scrCorrect/state.scrTotal*100) : 0);
  const pass = pct >= 85;
  const box = $("screening-done"); box.hidden=false;
  clear(box);
  const h = document.createElement("h2"); h.textContent = "Test abgeschlossen"; box.appendChild(h);
  const p1 = document.createElement("p");
  p1.appendChild(document.createTextNode("Übereinstimmung mit der Ground-Truth: "));
  const strong = document.createElement("strong"); strong.textContent = pct + "%"; p1.appendChild(strong);
  box.appendChild(p1);
  const p2 = document.createElement("p"); p2.style.color = "var(--text-2)";
  p2.textContent = pass ? "Über der Schwelle (85%) — im Live-Betrieb folgt das Angebot per Mail."
                        : "Unter der Schwelle (85%).";
  box.appendChild(p2);
}

/* ---------- Modus + Login ---------- */
function modesForRole(role){
  if (role==="admin") return [["review","Review"],["spotcheck","Spot-Check"]];
  return [["review","Review"]];
}
function startApp(){
  $("login-view").hidden = true; $("app-view").hidden = false;
  $("user-name").textContent = state.name + (state.vaId?(" · "+state.vaId):"");
  $("user-avatar").textContent = initials(state.name);
  const sel = $("mode-select"); clear(sel);
  modesForRole(state.role).forEach(([v,l])=>{ const o=document.createElement("option"); o.value=v; o.textContent=l; sel.appendChild(o); });
  sel.onchange = ()=>{ state.mode=sel.value; state.typ=null; loadNext(); };
  state.mode = sel.value || "review";
  loadNext();
}

async function doLogin(e){
  e.preventDefault();
  $("login-hint").textContent="";
  try {
    const r = await api("login", { username:$("login-user").value, password:$("login-pass").value });
    if (!r || !r.ok){ $("login-hint").textContent = (r && r.error) || "Login fehlgeschlagen."; return; }
    Object.assign(state, { token:r.token, role:r.role, name:r.name, vaId:r.vaId });
    startApp();
  } catch(err){
    $("login-hint").textContent = "Fehler beim Login: " + (err && err.message ? err.message : err);
  }
}

/* ---------- Tastatur (A/R, 1-5 Sterne, Enter = weiter) ---------- */
function onKey(e){
  if ($("app-view").hidden) return;
  const tag = (e.target && e.target.tagName || "").toLowerCase();
  if (tag === "textarea" || tag === "input" || tag === "select") return;
  const k = e.key.toLowerCase();
  if (k === "a"){ selectDecision("approve", null); }
  else if (k === "r"){ selectDecision("reject", null); }
  else if (k >= "1" && k <= "5"){ state.rating = Number(k); renderStars(); }
  else if (k === "enter"){ e.preventDefault(); onNext(); }
}

/* ---------- Bootstrap ---------- */
function boot(){
  if (CONFIG.DEMO_MODE) $("demo-note").hidden = false;
  $("login-form").addEventListener("submit", doLogin);
  $("logout-btn").addEventListener("click", ()=>location.reload());
  $("next-btn").addEventListener("click", onNext);
  document.querySelectorAll(".dbtn").forEach(b=> b.addEventListener("click", ()=>selectDecision(b.dataset.d, b)));
  document.addEventListener("keydown", onKey);

  // Screening-Direkteinstieg (Bewerber, kein Login): ?mode=screening&test=<Test-Ref aus sheet-63>
  const params = new URLSearchParams(location.search);
  if (params.get("mode")==="screening"){
    Object.assign(state, { token:"", testRef: params.get("test")||"demo",
      role:"applicant", name:"Bewerber", vaId:"", mode:"screening" });
    $("login-view").hidden=true; $("app-view").hidden=false;
    $("mode-select").hidden=true; $("user-name").textContent="Eignungstest";
    $("user-avatar").textContent="?"; loadNext();
  }
}
boot();
