/* Daily Check-in — admin-only View der QC-Review-App (Minimaltag-System, definiert 2026-08-25).
   Backend: checkin.gs (ci_get / ci_save) -> os-data/checkins.json im Drive (synct auf den PC).
   XSS-Politik der App gilt auch hier: dynamische Daten NUR via textContent (dzEl), nie innerHTML.

   Datumsgrenze 04:00 Europe/Berlin: Sandros Tag endet erst gegen 01:00 (Nachtschicht) — ein
   Check-in um 00:45 gehoert zum VORHERIGEN Tag. Das effektive Datum liefert der Server (ci_get);
   bis dahin rechnet ciEffHeuteLokal_() dieselbe Formel clientseitig.

   Streak-Regel "nie zwei rote Tage in Folge": gruen/joker brechen nichts, ein EINZELNES Rot
   auch nicht — erst das zweite Rot in Folge setzt die Zaehlung zurueck. Es zaehlen nur
   dokumentierte Tage; eine Luecke beendet die Zaehlung (das Tracken selbst ist Teil der
   Gewohnheit, 1 min/Tag). Der laufende, noch nicht eingetragene Tag unterbricht nichts.

   Seit 2026-09-10 (Sandro-Feedback): Business wird in STUNDEN erfasst (Kernblock = ab 3 h, daraus
   der Tages-Status: >= 3 h gruen, sonst Rueckfrage geplant? -> joker/rot). Statt der 14-Tage-
   Ampelkacheln zeigt die Karte eine 7-Tage-Matrix (Business in Stunden · Musik · Sport, Tage
   nebeneinander) plus je Zeile eine 30-Tage-Quote "erledigt / eingetragene Soll-Tage" gegen das
   Kalender-Soll (Standardregeln unten, Ausnahmen aus os-data/checkin-soll.json via ci_get). */

const ci = { days:{}, heute:null, datum:null, busy:false, feedback:"", soll:null,
             wahl:{ stunden:null, geplant:null, musik:null, sport:null } };

const CI_KERNBLOCK_H = 3;                 // Kernblock = ab 3 h Business (3 h zaehlen mit)
const CI_STUNDEN_PILLS = [0, 1, 2, 3, 4, 5, 6];
const CI_TAGE_MATRIX = 7;
const CI_TAGE_QUOTE = 30;
const CI_ITEMS = [
  { key:"business", label:"Business (h)" },
  { key:"musik",    label:"Musik" },
  { key:"sport",    label:"Sport" }
];
/* Kalender-Soll, Stand 10.09.2026 (Kalender sandro@wuensche-management.com): Business-Bloecke
   Mo–Fr + So (Samstag = Off-Day), Musik 16–17 und HH+Sport taeglich. Wochentage nach getUTCDay
   (0 = So … 6 = Sa). checkin-soll.json kann die Regeln ueberschreiben und Tages-Ausnahmen setzen
   (z. B. Musik an Spaetschicht-Tagen geloescht); ein Joker-Tag reduziert das Soll immer. */
const CI_SOLL_DEFAULT = { business:[0,1,2,3,4,5], musik:[0,1,2,3,4,5,6], sport:[0,1,2,3,4,5,6] };

/* Tages-Status wird aus den Business-Stunden ABGELEITET, nie separat abgefragt (Sandro 25.08.).
   >= 3 h -> gruen · < 3 h + geplant -> joker · < 3 h + ungeplant -> rot. */
function ciKernblock(w){ return w.stunden != null && w.stunden >= CI_KERNBLOCK_H; }
function ciAbleiten(w){
  if (w.stunden == null) return null;
  if (ciKernblock(w)) return "gruen";
  if (w.geplant === true) return "joker";
  if (w.geplant === false) return "rot";
  return null;
}
const CI_STATUS_TEXT = { gruen: "Grün — Kernblock lief", joker: "Joker — geplanter freier Tag", rot: "Rot — ungeplant unter 3 h" };
function ciUhr(iso){
  try { return new Intl.DateTimeFormat("de-DE", { timeZone:"Europe/Berlin", hour:"2-digit", minute:"2-digit" }).format(new Date(iso)); }
  catch(e){ return ""; }
}
function ciH(h){ return (Math.round(h * 100) / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 }); }

/* ---------- Datums-Helfer (reine Kalenderrechnung in UTC — DST-fest) ---------- */
function ciTagUtc(iso){ return Date.parse(iso + "T00:00:00Z"); }
function ciShift(iso, n){ return new Date(ciTagUtc(iso) + n*86400000).toISOString().slice(0,10); }
function ciDiffTage(a, b){ return Math.round((ciTagUtc(a) - ciTagUtc(b)) / 86400000); }
const CI_WTAGE = ["So","Mo","Di","Mi","Do","Fr","Sa"];
function ciWtagNr(iso){ return new Date(ciTagUtc(iso)).getUTCDay(); }
function ciWtag(iso){ return CI_WTAGE[ciWtagNr(iso)]; }
function ciSchoen(iso){ return ciWtag(iso) + ", " + iso.slice(8,10) + "." + iso.slice(5,7) + "."; }
function ciEffHeuteLokal_(ts){
  // Wanduhr-Definition (Berlin-Stunde < 4 -> Vortag) — identisch zum Server (checkin.gs),
  // damit die Grenze auch in den DST-Umstellungsnaechten bei 04:00 Wanduhr bleibt.
  const teile = new Intl.DateTimeFormat("en-CA", { timeZone:"Europe/Berlin", year:"numeric",
    month:"2-digit", day:"2-digit", hour:"2-digit", hourCycle:"h23" })
    .formatToParts(new Date(ts == null ? Date.now() : ts));
  const teil = (t) => teile.find(x => x.type === t).value;
  const datum = teil("year") + "-" + teil("month") + "-" + teil("day");
  return Number(teil("hour")) < 4 ? ciShift(datum, -1) : datum;
}

/* ---------- Streak ---------- */
function ciStreak(days, heute){
  let d = days[heute] ? heute : ciShift(heute, -1);
  let n = 0;
  while (days[d]){
    if (days[d].status === "rot"){
      const vor = days[ciShift(d, -1)];
      if (vor && vor.status === "rot") break;      // zweites Rot in Folge -> Zaehlung endet hier
    }
    n++;
    d = ciShift(d, -1);
  }
  return n;
}

/* ---------- Soll + Quote ---------- */
// Gilt das Item an diesem Tag als geplant? Regel (Wochentag) -> Tages-Ausnahme -> Joker.
function ciSollTag(item, iso, e){
  const cfg = ci.soll || {};
  const regeln = (cfg.regeln && Array.isArray(cfg.regeln[item])) ? cfg.regeln[item] : CI_SOLL_DEFAULT[item];
  let soll = regeln.indexOf(ciWtagNr(iso)) >= 0;
  const aus = cfg.ausnahmen && cfg.ausnahmen[iso];
  if (aus && typeof aus[item] === "boolean") soll = aus[item];
  if (e && e.status === "joker") soll = false;    // deklarierter Aus-Tag reduziert das Soll (Sandro-Regel 25.08.)
  return soll;
}
// true/false = erledigt/nicht; null = keine Angabe (alte Eintraege ohne das Feld)
function ciErledigt(item, e){
  if (item === "business") return (typeof e.stunden === "number") ? e.stunden >= CI_KERNBLOCK_H : e.kernblock === true;
  if (typeof e[item] !== "boolean") return null;
  return e[item] === true;
}
// 30-Tage-Quote: erledigt / eingetragene Soll-Tage. Tage ohne Eintrag werden nur gezaehlt (ohne),
// nicht als Fehltag gewertet — der laufende Tag zaehlt dabei nicht mit (er ist noch nicht vorbei),
// und Tage vor dem allerersten Eintrag auch nicht (vor dem 25.08. gab es das System nicht).
function ciStat(item, tage){
  const s = { x:0, y:0, ohne:0, hSum:0, hN:0, avgH:null };
  const erster = Object.keys(ci.days).sort()[0] || ci.heute;
  for (let i = tage - 1; i >= 0; i--){
    const d = ciShift(ci.heute, -i), e = ci.days[d] || null;
    if (!ciSollTag(item, d, e)) continue;
    if (!e){ if (d !== ci.heute && d >= erster) s.ohne++; continue; }
    const erl = ciErledigt(item, e);
    if (erl === null) continue;
    s.y++;
    if (erl) s.x++;
    if (item === "business" && typeof e.stunden === "number"){ s.hSum += e.stunden; s.hN++; }
  }
  if (s.hN) s.avgH = s.hSum / s.hN;
  return s;
}
function ciStatText(item, s){
  let t = CI_TAGE_QUOTE + " T: " + (s.y ? s.x + "/" + s.y + " · " + Math.round(100 * s.x / s.y) + " %" : "–");
  if (item === "business" && s.avgH != null) t += " · Ø " + ciH(s.avgH) + " h";
  return t;
}

/* ---------- Laden + Rendern ---------- */
// Gemeinsamer Loader fuer Check-in-Karte und Tablet-Dashboard: fuellt ci.days/soll/heute/datum.
async function ciLaden_(){
  const r = await api("ci_get", { token: state.token });
  if (!r || !r.ok) throw new Error((r && r.error) || "ci_get fehlgeschlagen");
  ci.days = r.days || {};
  ci.soll = (r.soll && typeof r.soll === "object") ? r.soll : null;
  ci.heute = r.heute || ciEffHeuteLokal_();
  ci.datum = ci.heute;
  ci.feedback = "";
}
async function ciMount(){
  const v = $("ci-view");
  dzClear(v);
  v.appendChild(dzEl("div", "dz-loading", "Lade Check-in …"));
  try {
    await ciLaden_();
    ciRender();
  } catch (err){
    dzClear(v);
    v.appendChild(dzEl("div", "dz-error", "Check-in nicht ladbar: " + (err && err.message ? err.message : err)));
    const retry = dzEl("button", "dz-btn", "Nochmal versuchen");
    retry.onclick = ciMount;
    v.appendChild(retry);
  }
}
window.ciMount = ciMount;

function ciRender(){
  const v = $("ci-view");
  dzClear(v);
  const est = ci.days[ci.datum] || null;
  // Alte Eintraege (vor 10.09.) haben keine Stunden: dann bleibt die Stundenfrage offen und wird
  // beim Nachtragen neu beantwortet — nichts raten, was spaeter als Zahl in der Matrix steht.
  ci.wahl = est ? { stunden: (typeof est.stunden === "number") ? est.stunden : null,
                    geplant: est.status === "joker" ? true : (est.status === "rot" ? false : null),
                    musik: est.musik === true, sport: est.sport === true }
                : { stunden: null, geplant: null, musik: null, sport: null };

  const card = dzEl("div", "ci-card");

  // Kopf: Titel + Datum-Navigation (Nachtragen bis 7 Tage zurueck — Server erzwingt dasselbe Fenster)
  const kopf = dzEl("div", "ci-kopf");
  kopf.appendChild(dzEl("div", "ci-titel", "Daily Check-in"));
  const nav = dzEl("div", "ci-datum-row");
  const prev = dzEl("button", "dz-btn dz-btn-mini", "◀");
  prev.type = "button"; prev.title = "Vortag (nachtragen)";
  prev.disabled = ciDiffTage(ci.heute, ci.datum) >= 7;
  prev.onclick = () => { ci.datum = ciShift(ci.datum, -1); ci.feedback = ""; ciRender(); };
  const dlabel = dzEl("span", "ci-datum", (ci.datum === ci.heute ? "Heute · " : "") + ciSchoen(ci.datum));
  const next = dzEl("button", "dz-btn dz-btn-mini", "▶");
  next.type = "button"; next.title = "Einen Tag vor";
  next.disabled = ci.datum >= ci.heute;
  next.onclick = () => { ci.datum = ciShift(ci.datum, +1); ci.feedback = ""; ciRender(); };
  nav.appendChild(prev); nav.appendChild(dlabel); nav.appendChild(next);
  kopf.appendChild(nav);
  card.appendChild(kopf);
  card.appendChild(dzEl("div", "ci-mini", "Tagesgrenze 04:00 Uhr — ein Check-in um 00:45 zählt zum Vortag."));

  if (ci.feedback) card.appendChild(dzEl("div", "ci-ok", ci.feedback));
  // Sichtbar machen, was aktuell gilt (Sandro-Frage 25.08. nach Doppel-Speichern):
  // pro Tag existiert genau EIN Eintrag, jedes Speichern ersetzt ihn komplett.
  if (est){
    const gz = dzEl("div", "ci-gespeichert st-" + est.status);
    const kurz = (CI_STATUS_TEXT[est.status] || est.status).split(" — ")[0];
    gz.appendChild(dzEl("strong", null, "Gespeichert: " + kurz +
      (typeof est.stunden === "number" ? " · " + ciH(est.stunden) + " h" : "")));
    gz.appendChild(document.createTextNode(
      (est.gespeichert ? " · " + ciUhr(est.gespeichert) + " Uhr" : "") + " — erneutes Speichern ersetzt den Eintrag."));
    card.appendChild(gz);
  }

  // Einziger Schnellweg: Joker (z. B. Urlaub) = 1 Tap. Der fruehere Gruen-Schnellknopf ist raus —
  // er behauptete Musik ✓, was Sandros erster echter Eintrag widerlegte.
  const quick = dzEl("div", "ci-quick");
  const q2 = dzEl("button", "ci-pill p-joker ci-quick-btn", "Joker — geplanter freier Tag (1 Tap)");
  q2.type = "button";
  quick.appendChild(q2);
  card.appendChild(quick);

  let syncSave = function(){};

  // Business in Stunden: 7 Schnell-Pills (0–6) + Feld fuer krumme Werte (2,5 / 7,5). Viertelstunden.
  const hrow = dzEl("div", "ci-frage");
  hrow.appendChild(dzEl("div", "ci-frage-lbl", "Business heute — wie viele Stunden?"));
  const hp = dzEl("div", "ci-pills ci-pills-h");
  const hbtns = [];
  const exakt = dzEl("input", "ci-exakt");
  exakt.type = "text"; exakt.inputMode = "decimal"; exakt.placeholder = "z. B. 2,5";
  exakt.setAttribute("aria-label", "Business-Stunden genau");
  const setStunden = (h, quelle) => {
    ci.wahl.stunden = h;
    hbtns.forEach(b => b.classList.toggle("sel", h != null && Number(b.dataset.h) === h));
    if (quelle !== "input") exakt.value = (h == null || CI_STUNDEN_PILLS.indexOf(h) >= 0) ? "" : ciH(h);
    syncSave();
  };
  CI_STUNDEN_PILLS.forEach(h => {
    const b = dzEl("button", "ci-pill" + (h >= CI_KERNBLOCK_H ? " p-gruen" : ""), String(h));
    b.type = "button"; b.dataset.h = String(h);
    b.onclick = () => setStunden(h, "pill");
    hbtns.push(b); hp.appendChild(b);
  });
  hrow.appendChild(hp);
  const exrow = dzEl("div", "ci-exakt-row");
  exrow.appendChild(dzEl("span", "ci-mini", "oder genau:"));
  exrow.appendChild(exakt);
  exrow.appendChild(dzEl("span", "ci-mini", "h"));
  hrow.appendChild(exrow);
  hrow.appendChild(dzEl("div", "ci-mini", "Ab " + CI_KERNBLOCK_H + " h = Kernblock = Tag ist Grün."));
  exakt.oninput = () => {
    const raw = exakt.value.trim().replace(",", ".");
    if (raw === ""){ exakt.classList.remove("bad"); setStunden(null, "input"); return; }
    const n = Number(raw);
    if (isNaN(n) || n < 0 || n > 24){ exakt.classList.add("bad"); setStunden(null, "input"); return; }
    exakt.classList.remove("bad");
    setStunden(Math.round(n * 4) / 4, "input");
  };
  card.appendChild(hrow);

  // Klartext-Fragen (Sandro 25.08.); der Tages-Status wird daraus abgeleitet und live angezeigt.
  const frage = (label, key, optionen, mini) => {
    const row = dzEl("div", "ci-frage");
    row.appendChild(dzEl("div", "ci-frage-lbl", label));
    const wrap = dzEl("div", "ci-pills");
    optionen.forEach(([wert, lab, kl]) => {
      const b = dzEl("button", "ci-pill" + (kl ? " " + kl : ""), lab);
      b.type = "button";
      if (ci.wahl[key] === wert) b.classList.add("sel");
      b.onclick = () => {
        ci.wahl[key] = wert;
        Array.from(wrap.children).forEach(x => x.classList.remove("sel"));
        b.classList.add("sel");
        syncSave();
      };
      wrap.appendChild(b);
    });
    row.appendChild(wrap);
    if (mini) row.appendChild(dzEl("div", "ci-mini", mini));
    return row;
  };
  const geplantRow = frage("Unter " + CI_KERNBLOCK_H + " h — war das vorher geplant?", "geplant",
    [[true, "Ja — Joker", "p-joker"], [false, "Nein — Rot", "p-rot"]]);
  geplantRow.classList.add("ci-geplant");
  card.appendChild(geplantRow);
  card.appendChild(frage("Musik gemacht?", "musik", [[true, "Ja"], [false, "Nein"]]));
  card.appendChild(frage("Sport gemacht?", "sport", [[true, "Ja"], [false, "Nein"]]));

  // Live-Anzeige des abgeleiteten Status
  const statuszeile = dzEl("div", "ci-status-zeile");
  card.appendChild(statuszeile);

  const ta = dzEl("textarea", "ci-notiz");
  ta.rows = 2;
  ta.placeholder = "Anmerkung (optional) — einfach diktieren";
  if (est && est.notiz) ta.value = est.notiz;
  card.appendChild(ta);

  const save = dzEl("button", "primary ci-save", "Speichern");
  save.type = "button";
  const hint = dzEl("div", "dz-hint");
  syncSave = () => {
    const st = ciAbleiten(ci.wahl);
    // Geplant-Rueckfrage nur zeigen, wenn die Stunden unter dem Kernblock liegen
    geplantRow.hidden = !(ci.wahl.stunden != null && !ciKernblock(ci.wahl));
    dzClear(statuszeile);
    statuszeile.className = "ci-status-zeile" + (st ? " st-" + st : "");
    statuszeile.textContent = st ? ("→ Tag zählt als: " + CI_STATUS_TEXT[st])
                                 : "→ Stunden antippen, der Tages-Status ergibt sich daraus.";
    save.disabled = !st;
  };
  setStunden(ci.wahl.stunden, "init");
  // Eine Speicherroutine fuer beide Wege (Joker-Schnellknopf + Formular). Musik/Sport ohne
  // Antwort zaehlen als Nein; eine vorhandene Tages-Notiz bleibt erhalten (Feld ist vorbefuellt).
  const speichern = async (wahl, btn) => {
    if (ci.busy) return;
    const st = ciAbleiten(wahl);
    if (!st) return;
    ci.busy = true;
    const alt = btn.textContent;
    btn.disabled = true; btn.textContent = "Speichere …"; hint.textContent = "";
    try {
      const r = await api("ci_save", { token: state.token, datum: ci.datum,
        stunden: wahl.stunden, kernblock: ciKernblock(wahl),
        musik: wahl.musik === true, sport: wahl.sport === true,
        status: st, notiz: ta.value.trim() });
      if (!r || !r.ok) throw new Error((r && r.error) || "Fehler beim Speichern");
      ci.days = r.days || ci.days;
      if (r.heute) ci.heute = r.heute;
      if (r.soll && typeof r.soll === "object") ci.soll = r.soll;
      ci.feedback = "✓ Gespeichert (" + ciSchoen(ci.datum) + ")";
      ciRender();
    } catch (err){
      hint.textContent = String(err && err.message ? err.message : err);
      btn.textContent = alt; btn.disabled = false;
      syncSave();
    } finally { ci.busy = false; }
  };
  save.onclick = () => { if (!save.disabled) speichern(ci.wahl, save); };
  // Joker-Schnellknopf: bereits angetippte Stunden unter 3 h bleiben erhalten, sonst 0 h.
  q2.onclick = () => speichern({ stunden: (ci.wahl.stunden != null && !ciKernblock(ci.wahl)) ? ci.wahl.stunden : 0,
                                 geplant: true, musik: ci.wahl.musik === true, sport: ci.wahl.sport === true }, q2);
  card.appendChild(save);
  card.appendChild(hint);
  v.appendChild(card);

  // Streak + 7-Tage-Matrix + 30-Tage-Quote
  const skarte = dzEl("div", "ci-card");
  const n = ciStreak(ci.days, ci.heute);
  const sbox = dzEl("div", "ci-streak");
  sbox.appendChild(dzEl("span", "ci-streak-zahl" + (n ? "" : " leer"), String(n)));
  sbox.appendChild(dzEl("span", "ci-streak-lbl", n === 1 ? "Tag im System" : "Tage im System"));
  skarte.appendChild(sbox);
  skarte.appendChild(dzEl("div", "ci-mini",
    "Regel: nie 2 rote Tage in Folge. Grün & Joker brechen nichts, ein einzelnes Rot auch nicht. " +
    "Nur eingetragene Tage zählen — eine Lücke beendet die Zählung. " +
    "Die Streak zählt NUR den Kernblock (ab " + CI_KERNBLOCK_H + " h) — Musik und Sport sind reine Statistik und können sie nie brechen."));

  const stats = {};
  CI_ITEMS.forEach(it => { stats[it.key] = ciStat(it.key, CI_TAGE_QUOTE); });
  skarte.appendChild(dzEl("div", "ci-untertitel", "Letzte " + CI_TAGE_MATRIX + " Tage"));
  skarte.appendChild(ciMatrix(stats));
  const ohne = CI_ITEMS.filter(it => stats[it.key].ohne > 0);
  if (ohne.length)
    skarte.appendChild(dzEl("div", "ci-mini", "Ohne Eintrag an Soll-Tagen (" + CI_TAGE_QUOTE + " T): " +
      ohne.map(it => it.label.replace(" (h)", "") + " " + stats[it.key].ohne).join(" · ") + "."));
  skarte.appendChild(dzEl("div", "ci-mini",
    "Zahl = Business-Stunden: ab " + CI_KERNBLOCK_H + " h grün, Joker orange, Rot = ungeplant darunter. " +
    "Musik/Sport: ✓ gemacht, – nicht; grau = an dem Tag laut Kalender nicht geplant (Joker-Tage, Musik an Spätschicht-Tagen). " +
    CI_TAGE_QUOTE + "-T-Quote = erledigt / eingetragene Soll-Tage (Samstag ist kein Business-Soll). " +
    "Kachel antippen = Tag nachtragen (bis 7 Tage zurück)."));
  v.appendChild(skarte);
}

/* ---------- 7-Tage-Matrix: Kopfzeile (Wochentag + Datum) + je Item eine Zeile ---------- */
// interaktiv=false (Tablet-Dashboard): reine Anzeige, Kacheln nicht antippbar, keine Auswahl-Markierung.
function ciMatrix(stats, interaktiv){
  if (interaktiv === undefined) interaktiv = true;
  const box = dzEl("div", "ci-matrix");
  const tage = [];
  for (let i = CI_TAGE_MATRIX - 1; i >= 0; i--) tage.push(ciShift(ci.heute, -i));
  const head = dzEl("div", "ci-mrow ci-mhead");
  tage.forEach(d => {
    const h = dzEl("button", "ci-z ci-zh" + (d === ci.heute ? " z-heute" : "") + (interaktiv && d === ci.datum ? " z-akt" : ""));
    h.type = "button";
    h.appendChild(dzEl("span", "ci-zh-wt", ciWtag(d)));
    h.appendChild(dzEl("span", "ci-zh-dt", d.slice(8,10) + "."));
    h.title = ciSchoen(d) + (ci.days[d] ? "" : " · kein Eintrag");
    if (interaktiv) h.onclick = () => { ci.datum = d; ci.feedback = ""; ciRender(); };
    else h.tabIndex = -1;
    head.appendChild(h);
  });
  box.appendChild(head);
  CI_ITEMS.forEach(item => {
    const cap = dzEl("div", "ci-mcap");
    cap.appendChild(dzEl("strong", null, item.label));
    cap.appendChild(dzEl("span", "ci-mstat", ciStatText(item.key, stats[item.key])));
    box.appendChild(cap);
    const row = dzEl("div", "ci-mrow");
    tage.forEach(d => row.appendChild(ciZelle(item.key, d, interaktiv)));
    box.appendChild(row);
  });
  return box;
}

function ciZelle(item, d, interaktiv){
  if (interaktiv === undefined) interaktiv = true;
  const e = ci.days[d] || null;
  const soll = ciSollTag(item, d, e);
  let text = "", kl = "z-leer", tip = "kein Eintrag";
  if (e && item === "business"){
    const hasH = typeof e.stunden === "number";
    const hTxt = hasH ? ciH(e.stunden) + " h" : null;
    if (e.status === "joker"){ kl = "z-joker"; text = (hasH && e.stunden > 0) ? ciH(e.stunden) : "J"; tip = "Joker" + (hTxt ? " · " + hTxt : ""); }
    else if (e.status === "gruen"){ kl = "z-gruen"; text = hasH ? ciH(e.stunden) : "3+"; tip = "Grün · " + (hTxt || "Kernblock"); }
    else { kl = "z-rot"; text = hasH ? ciH(e.stunden) : "<3"; tip = "Rot · " + (hTxt || "kein Kernblock"); }
  } else if (e){
    const erl = ciErledigt(item, e);
    if (erl === null){ kl = "z-na"; text = "?"; tip = "keine Angabe"; }
    else if (erl){ kl = "z-gruen"; text = "✓"; tip = "gemacht"; }
    else if (soll){ kl = "z-rot"; text = "–"; tip = "nicht gemacht"; }
    else { kl = "z-frei"; text = "–"; tip = "nicht gemacht (laut Kalender nicht geplant)"; }
  }
  const k = dzEl("button", "ci-z " + kl + (d === ci.heute ? " z-heute" : "") + (interaktiv && d === ci.datum ? " z-akt" : ""), text);
  k.type = "button";
  k.title = ciSchoen(d) + " · " + tip + (e && e.notiz ? " · " + e.notiz.slice(0, 80) : "");
  if (interaktiv) k.onclick = () => { ci.datum = d; ci.feedback = ""; ciRender(); };
  else k.tabIndex = -1;
  return k;
}

/* =================================================================== */
/*  TABLET-DASHBOARD (Sandro-Wunsch 13.09.2026): Streak + 7-Tage-Matrix   */
/*  + 30-T-Quoten in Tablet-Groesse, Google-Kalender daneben (Embed,     */
/*  abschaltbar), Auto-Refresh alle 10 min + beim Sichtbarwerden,        */
/*  Bildschirm-Wachhalten per Screen Wake Lock (Chrome Android, HTTPS).  */
/*  Direktlink: …/#tablet — die 30-Tage-Sitzung greift wie am Handy.     */
/* =================================================================== */
const TB_REFRESH_MS = 10 * 60 * 1000;
const TB_KAL_URL = "https://calendar.google.com/calendar/embed?src=sandro%40wuensche-management.com" +
  "&ctz=Europe%2FBerlin&mode=AGENDA&hl=de&showTitle=0&showNav=0&showDate=0&showPrint=0&showTabs=0&showCalendars=0&showTz=0";
const tb = { timer:null, uhrTimer:null, wakeLock:null, hooked:false };

function tbKalAn(){ try { return localStorage.getItem("qc_tb_kal") !== "0"; } catch(e){ return true; } }
function tbKalSetzen(an){ try { localStorage.setItem("qc_tb_kal", an ? "1" : "0"); } catch(e){} }
function tbJetzt(opts){
  try { return new Intl.DateTimeFormat("de-DE", Object.assign({ timeZone:"Europe/Berlin" }, opts)).format(new Date()); }
  catch(e){ return ""; }
}
async function tbWakeLock(){
  // Best effort: haelt den Tablet-Bildschirm an, solange die Seite sichtbar ist. Ohne API/Recht: still weiter.
  try {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    if (tb.wakeLock && !tb.wakeLock.released) return;
    tb.wakeLock = await navigator.wakeLock.request("screen");
  } catch(e){ tb.wakeLock = null; }
}
function tbStop(){
  if (tb.timer){ clearInterval(tb.timer); tb.timer = null; }
  if (tb.uhrTimer){ clearInterval(tb.uhrTimer); tb.uhrTimer = null; }
  if (tb.wakeLock){ try { tb.wakeLock.release(); } catch(e){} tb.wakeLock = null; }
}
async function tbMount(){
  const v = $("tablet-view");
  if (!v) return;
  tbStop();
  dzClear(v);
  v.appendChild(dzEl("div", "dz-loading", "Lade Check-in …"));
  try {
    await ciLaden_();
    tbRender();
  } catch (err){
    dzClear(v);
    v.appendChild(dzEl("div", "dz-error", "Dashboard nicht ladbar: " + (err && err.message ? err.message : err)));
    const retry = dzEl("button", "dz-btn", "Nochmal versuchen");
    retry.onclick = tbMount;
    v.appendChild(retry);
  }
  tb.timer = setInterval(async () => {
    if (state.mode !== "tablet"){ tbStop(); return; }
    try { await ciLaden_(); tbRender(); } catch(e){ /* alte Anzeige stehen lassen, naechster Tick versucht es wieder */ }
  }, TB_REFRESH_MS);
  tbWakeLock();
  if (!tb.hooked){
    tb.hooked = true;
    document.addEventListener("visibilitychange", async () => {
      if (state.mode !== "tablet" || document.visibilityState !== "visible") return;
      tbWakeLock();
      try { await ciLaden_(); tbRender(); } catch(e){}
    });
  }
}
window.tbMount = tbMount;

function tbRender(){
  const v = $("tablet-view");
  if (!v) return;
  dzClear(v);
  if (tb.uhrTimer){ clearInterval(tb.uhrTimer); tb.uhrTimer = null; }

  // Kopfzeile: Datum + Uhr (Kalenderdatum; die Matrix markiert den effektiven Check-in-Tag) + Knoepfe
  const head = dzEl("div", "tb-head");
  const dat = dzEl("div", "tb-datum");
  dat.appendChild(dzEl("span", "tb-tag", tbJetzt({ weekday:"long", day:"numeric", month:"long" })));
  const uhr = dzEl("span", "tb-uhr", tbJetzt({ hour:"2-digit", minute:"2-digit" }));
  dat.appendChild(uhr);
  head.appendChild(dat);
  tb.uhrTimer = setInterval(() => { uhr.textContent = tbJetzt({ hour:"2-digit", minute:"2-digit" }); }, 30000);

  const knoepfe = dzEl("div", "tb-knoepfe");
  const wechsel = (modus) => {
    const sel = $("mode-select"); if (sel) sel.value = modus;
    state.mode = modus; state.typ = null; dzSwitchMode();
  };
  const bEintragen = dzEl("button", "primary tb-btn tb-btn-primary", "Check-in eintragen");
  bEintragen.type = "button"; bEintragen.onclick = () => wechsel("checkin");
  const bKal = dzEl("button", "dz-btn tb-btn", tbKalAn() ? "Kalender aus" : "Kalender an");
  bKal.type = "button"; bKal.onclick = () => { tbKalSetzen(!tbKalAn()); tbRender(); };
  const bRefresh = dzEl("button", "dz-btn tb-btn", "↻");
  bRefresh.type = "button"; bRefresh.title = "Jetzt aktualisieren";
  bRefresh.onclick = async () => { bRefresh.disabled = true; try { await ciLaden_(); tbRender(); } catch(e){ bRefresh.disabled = false; } };
  const bMenu = dzEl("button", "dz-btn tb-btn", "Menü");
  bMenu.type = "button"; bMenu.title = "Topbar mit Bereichswahl einblenden";
  bMenu.onclick = () => { document.body.classList.toggle("tablet-mode"); };
  [bEintragen, bKal, bRefresh, bMenu].forEach(b => knoepfe.appendChild(b));
  head.appendChild(knoepfe);
  v.appendChild(head);

  const grid = dzEl("div", "tb-grid" + (tbKalAn() ? " mit-kal" : ""));

  // Links: Streak + Matrix + Quoten (Anzeige-Modus, nicht antippbar)
  const links = dzEl("div", "tb-card");
  const n = ciStreak(ci.days, ci.heute);
  const sbox = dzEl("div", "ci-streak tb-streak");
  sbox.appendChild(dzEl("span", "ci-streak-zahl" + (n ? "" : " leer"), String(n)));
  sbox.appendChild(dzEl("span", "ci-streak-lbl", (n === 1 ? "Tag" : "Tage") + " im System · nie 2 rote in Folge"));
  links.appendChild(sbox);
  const stats = {};
  CI_ITEMS.forEach(it => { stats[it.key] = ciStat(it.key, CI_TAGE_QUOTE); });
  links.appendChild(dzEl("div", "ci-untertitel tb-untertitel", "Letzte " + CI_TAGE_MATRIX + " Tage"));
  links.appendChild(ciMatrix(stats, false));
  const heuteE = ci.days[ci.heute];
  links.appendChild(dzEl("div", "ci-mini tb-mini", heuteE
    ? "Heute (" + ciSchoen(ci.heute) + ") eingetragen: " + (CI_STATUS_TEXT[heuteE.status] || heuteE.status).split(" — ")[0]
      + (typeof heuteE.stunden === "number" ? " · " + ciH(heuteE.stunden) + " h" : "")
    : "Heute (" + ciSchoen(ci.heute) + ") noch kein Eintrag — Tagesgrenze 04:00 Uhr."));
  grid.appendChild(links);

  // Rechts: Google-Kalender (Agenda ab heute). Privater Kalender -> Browser muss mit dem Konto angemeldet sein.
  if (tbKalAn()){
    const rechts = dzEl("div", "tb-card tb-kal");
    const fr = document.createElement("iframe");
    fr.className = "tb-kal-frame";
    fr.src = TB_KAL_URL;
    fr.title = "Google Kalender";
    fr.setAttribute("loading", "lazy");
    fr.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
    rechts.appendChild(fr);
    rechts.appendChild(dzEl("div", "ci-mini tb-mini",
      "Bleibt der Kalender leer: im Tablet-Browser mit sandro@wuensche-management.com anmelden oder Drittanbieter-Cookies für calendar.google.com erlauben — sonst die Kalender-App im Split-Screen daneben legen."));
    grid.appendChild(rechts);
  }
  v.appendChild(grid);

  v.appendChild(dzEl("div", "ci-mini tb-fuss",
    "Stand " + tbJetzt({ hour:"2-digit", minute:"2-digit" }) + " Uhr · aktualisiert sich alle 10 Minuten und beim Aufwecken · Bildschirm bleibt an, solange diese Seite offen ist" +
    (tb.wakeLock && !tb.wakeLock.released ? "" : " (Wachhalten nicht aktiv — Browser/Netzteil prüfen)") + "."));
}
