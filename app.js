/* QC-Review-App — Front-end. Vanilla JS, kein Build-Schritt.
   Demo-Modus laeuft ohne Backend; fuer live CONFIG.BACKEND_URL setzen + DEMO_MODE=false.
   Reviewer entscheidet NUR approve/reject (OK/nicht-OK) + Grund. Ob revision/neu erstellt wird,
   entscheidet das System (sop-09-05), nicht der Mensch. */

const CONFIG = {
  BACKEND_URL: "",        // <- /exec-URL der Apps-Script-Web-App eintragen
  DEMO_MODE: true,        // <- fuer Live-Betrieb auf false
  QUOTA_PCT: 30,          // qc-begruendung-quote-prozent (Default; live aus sheet-48)
  RATE: { Bild: 0.025, Video: 0.06, "editiertes-Video": 0.06, Plan: 0.10, Konzept: 0.10 }
};

const $ = (id) => document.getElementById(id);
const state = { token:null, role:null, name:null, vaId:null, mode:"review",
                item:null, decision:null, rating:0,
                done:0, described:0, agree:0, agreeBase:0, earn:0,
                scrTotal:0, scrCorrect:0 };

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
  qIdx:0,
  queue:[
    { creator:"luna", typ:"Bild",  src:"sop-05-05 · PPV",  vaDecision:"approve" },
    { creator:"mia",  typ:"Bild",  src:"sop-02-01 · Feed", vaDecision:"approve" },
    { creator:"aria", typ:"Video", src:"sop-03-01 · Reel", vaDecision:"reject"  },
    { creator:"luna", typ:"Bild",  src:"sop-05-05 · PPV",  vaDecision:"reject"  },
    { creator:"nora", typ:"Bild",  src:"sop-02-01 · Feed", vaDecision:"approve" },
    { creator:"mia",  typ:"Video", src:"sop-05-05 · PPV",  vaDecision:"approve" }
  ],
  gIdx:0,
  golden:[
    { creator:"luna", typ:"Bild", gt:"approve" }, { creator:"mia",  typ:"Bild", gt:"reject"  },
    { creator:"aria", typ:"Bild", gt:"approve" }, { creator:"nora", typ:"Bild", gt:"reject"  },
    { creator:"luna", typ:"Video",gt:"reject"  }, { creator:"mia",  typ:"Bild", gt:"approve" }
  ]
};
function demoRef(cKey){
  const c = DEMO.creators[cKey];
  return Array.from({length:4}, (_,i) => ({ url: ph(c.name.toLowerCase()+" #"+(i+1), c.hue), label:c.name }));
}
function demoItem(raw, idx, prefix){
  const c = DEMO.creators[raw.creator];
  return {
    itemId: prefix + String(4821+idx),
    contentTyp: raw.typ, sourceSop: raw.src || "golden-set",
    creatorId: raw.creator, creatorName: c.name,
    assetUrl: ph(c.name.toLowerCase()+" · "+(raw.typ==="Video"?"clip":"img")+"-"+(idx%9+1), c.hue),
    vaDecision: raw.vaDecision || null,
    reference: demoRef(raw.creator),
    _gt: raw.gt || null
  };
}

/* ---------- API (Demo oder echt) ---------- */
async function api(action, body){
  if (CONFIG.DEMO_MODE) return demoApi(action, body);
  const res = await fetch(CONFIG.BACKEND_URL, {
    method:"POST", headers:{ "Content-Type":"text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ action }, body))
  });
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
      if (DEMO.gIdx >= DEMO.golden.length) return { ok:true, item:null };
      const it = demoItem(DEMO.golden[DEMO.gIdx], DEMO.gIdx, "gold-");
      return { ok:true, item:it, reference:[], stats:demoStats(body.mode) };
    }
    const raw = DEMO.queue[DEMO.qIdx % DEMO.queue.length];
    const it = demoItem(raw, DEMO.qIdx, "qc-00");
    return { ok:true, item:it, reference:it.reference, stats:demoStats(body.mode) };
  }
  if (action === "submit"){
    if (body.mode === "screening"){
      const gt = (state.item && state.item._gt);
      state.scrTotal++; if (gt && gt === body.decision) state.scrCorrect++;
      DEMO.gIdx++;
      return { ok:true, stats:demoStats(body.mode) };
    }
    state.done++;
    if ((body.begruendung||"").trim()) state.described++;
    state.earn += CONFIG.RATE[body.contentTyp] || 0.025;
    if (body.mode === "spotcheck"){ state.agreeBase++; if (body.decision === body.vaDecision) state.agree++; }
    DEMO.qIdx++;
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

/* ---------- Render ---------- */
function initials(s){ return (s||"?").replace(/[^a-zA-ZäöüÄÖÜ ]/g,"").split(/\s|-/).map(w=>w[0]).join("").slice(0,2).toUpperCase(); }

function renderItem(item, reference, stats){
  state.item = item; state.decision = null; state.rating = 0;
  $("review-hint").textContent = "";
  $("just").value = ""; $("just").classList.remove("req");
  document.querySelectorAll(".dbtn").forEach(b=>b.className="dbtn");
  updateJustLabel(); renderStars();

  if (!item){
    if (state.mode === "screening") return showScreeningResult();
    $("asset").innerHTML = '<div class="asset-empty">Keine Items in der Queue. &#10003;</div>';
    $("item-id").textContent="–"; $("item-typ").textContent="–"; $("item-source").textContent="–";
    $("va-original").hidden = true; $("next-btn").disabled = true; $("ref-grid").innerHTML="";
    return;
  }
  $("next-btn").disabled = false;
  $("item-id").textContent = item.itemId;
  $("item-typ").textContent = item.contentTyp;
  $("item-source").textContent = item.sourceSop;
  $("asset").innerHTML = `<img src="${item.assetUrl}" alt="Zu pruefendes ${item.contentTyp}" />`;

  // Spot-Check: die VA-Entscheidung zeigen
  if (state.mode === "spotcheck" && item.vaDecision){
    $("va-original").hidden = false;
    $("va-original").innerHTML = `VA-Entscheidung: <strong>${item.vaDecision}</strong> — stimmst du zu? (bei Abweichung Begründung Pflicht)`;
  } else $("va-original").hidden = true;

  // Referenz-Galerie (nicht im Screening)
  const grid = $("ref-grid");
  if (state.mode === "screening" || !reference || !reference.length){
    grid.innerHTML=""; $("ref-name").textContent = item.creatorName ? "Creator: "+item.creatorName : "–";
    $("ref-avatar").textContent = initials(item.creatorName);
  } else {
    $("ref-name").textContent = "Creator: " + item.creatorName;
    $("ref-avatar").textContent = initials(item.creatorName);
    grid.innerHTML = reference.map(r =>
      `<div class="thumb"><img src="${r.url}" alt="Approved ${r.label}"/><span class="ok">&#10003;</span></div>`).join("");
  }
  applyStats(stats);
}

function renderStars(){
  const wrap = $("rating-stars"); wrap.innerHTML="";
  for (let i=1;i<=5;i++){
    const s=document.createElement("span");
    s.className="star"+(i<=state.rating?" on":""); s.textContent="★";
    s.setAttribute("role","radio"); s.setAttribute("aria-checked", i===state.rating);
    s.onclick=()=>{ state.rating=i; renderStars(); };
    wrap.appendChild(s);
  }
}
function applyStats(st){
  if (!st) return;
  if (state.mode === "screening"){
    $("st-done").textContent = state.scrTotal;
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
  btn.classList.add("sel-"+d);
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
  if (!state.decision){ $("review-hint").textContent = "Bitte zuerst Approve oder Reject wählen."; return; }
  const just = $("just").value.trim();
  const needReject = (state.decision==="reject");
  const needDisagree = (state.mode==="spotcheck" && state.item && state.decision!==state.item.vaDecision);
  let needQuota = false;
  if (state.mode!=="screening"){
    const describedAfter = state.described + (just?1:0);
    needQuota = state.done >= 1 && (describedAfter/(state.done+1)) < (CONFIG.QUOTA_PCT/100);
  }
  if ((needReject || needDisagree || needQuota) && !just){
    $("review-hint").textContent = (needReject || needDisagree)
      ? "Begründung ist Pflicht (Reject bzw. Abweichung)."
      : "Begründungs-Quote: mind. "+CONFIG.QUOTA_PCT+"% — bitte dieses Item kurz begründen.";
    $("just").classList.add("req"); $("just").focus(); return;
  }
  $("next-btn").disabled = true;
  const r = await api("submit", { token:state.token, mode:state.mode, itemId:state.item.itemId,
    decision:state.decision, rating:state.rating, begruendung:just,
    contentTyp:state.item.contentTyp, vaDecision:state.item.vaDecision });
  if (!r.ok){ $("review-hint").textContent = r.error||"Fehler beim Speichern."; $("next-btn").disabled=false; return; }
  await loadNext();
}

async function loadNext(){
  const r = await api("next", { token:state.token, mode:state.mode });
  if (!r.ok){ $("review-hint").textContent = r.error||"Fehler beim Laden."; return; }
  renderItem(r.item, r.reference, r.stats);
}

function showScreeningResult(){
  document.querySelector(".workspace").hidden = true;
  document.querySelector(".statbar").hidden = true;
  const pct = state.scrTotal ? Math.round(state.scrCorrect/state.scrTotal*100) : 0;
  const pass = pct >= 85;
  const box = $("screening-done"); box.hidden=false;
  box.innerHTML = `<h2>Test abgeschlossen</h2>
    <p>Übereinstimmung mit der Ground-Truth: <strong>${pct}%</strong> (${state.scrCorrect}/${state.scrTotal}).</p>
    <p style="color:var(--text-2)">${pass ? "Über der Schwelle (85%) — im Live-Betrieb folgt das Angebot per Mail." : "Unter der Schwelle (85%)."}</p>`;
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
  const sel = $("mode-select"); sel.innerHTML="";
  modesForRole(state.role).forEach(([v,l])=>{ const o=document.createElement("option"); o.value=v; o.textContent=l; sel.appendChild(o); });
  sel.onchange = ()=>{ state.mode=sel.value; loadNext(); };
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

/* ---------- Bootstrap ---------- */
function boot(){
  if (CONFIG.DEMO_MODE) $("demo-note").hidden = false;
  $("login-form").addEventListener("submit", doLogin);
  $("logout-btn").addEventListener("click", ()=>location.reload());
  $("next-btn").addEventListener("click", onNext);
  document.querySelectorAll(".dbtn").forEach(b=> b.addEventListener("click", ()=>selectDecision(b.dataset.d, b)));

  // Screening-Direkteinstieg (Bewerber, kein Login): ?mode=screening
  const params = new URLSearchParams(location.search);
  if (params.get("mode")==="screening"){
    Object.assign(state, { token:params.get("test")||"demo", role:"applicant", name:"Bewerber", vaId:"", mode:"screening" });
    $("login-view").hidden=true; $("app-view").hidden=false;
    $("mode-select").hidden=true; $("user-name").textContent="Eignungstest";
    $("user-avatar").textContent="?"; loadNext();
  }
}
boot();
