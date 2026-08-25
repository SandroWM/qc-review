/* Daily Check-in — admin-only View der QC-Review-App (Minimaltag-System, definiert 2026-08-25).
   Backend: checkin.gs (ci_get / ci_save) -> os-data/checkins.json im Drive (synct auf den PC).
   XSS-Politik der App gilt auch hier: dynamische Daten NUR via textContent (dzEl), nie innerHTML.

   Datumsgrenze 04:00 Europe/Berlin: Sandros Tag endet erst gegen 01:00 (Nachtschicht) — ein
   Check-in um 00:45 gehoert zum VORHERIGEN Tag. Das effektive Datum liefert der Server (ci_get);
   bis dahin rechnet ciEffHeuteLokal_() dieselbe Formel clientseitig.

   Streak-Regel "nie zwei rote Tage in Folge": gruen/joker brechen nichts, ein EINZELNES Rot
   auch nicht — erst das zweite Rot in Folge setzt die Zaehlung zurueck. Es zaehlen nur
   dokumentierte Tage; eine Luecke beendet die Zaehlung (das Tracken selbst ist Teil der
   Gewohnheit, 1 min/Tag). Der laufende, noch nicht eingetragene Tag unterbricht nichts. */

const ci = { days:{}, heute:null, datum:null, busy:false, feedback:"",
             wahl:{ kernblock:null, musik:null, status:null } };

/* ---------- Datums-Helfer (reine Kalenderrechnung in UTC — DST-fest) ---------- */
function ciTagUtc(iso){ return Date.parse(iso + "T00:00:00Z"); }
function ciShift(iso, n){ return new Date(ciTagUtc(iso) + n*86400000).toISOString().slice(0,10); }
function ciDiffTage(a, b){ return Math.round((ciTagUtc(a) - ciTagUtc(b)) / 86400000); }
const CI_WTAGE = ["So","Mo","Di","Mi","Do","Fr","Sa"];
function ciWtag(iso){ return CI_WTAGE[new Date(ciTagUtc(iso)).getUTCDay()]; }
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

/* ---------- Laden + Rendern ---------- */
async function ciMount(){
  const v = $("ci-view");
  dzClear(v);
  v.appendChild(dzEl("div", "dz-loading", "Lade Check-in …"));
  try {
    const r = await api("ci_get", { token: state.token });
    if (!r || !r.ok) throw new Error((r && r.error) || "ci_get fehlgeschlagen");
    ci.days = r.days || {};
    ci.heute = r.heute || ciEffHeuteLokal_();
    ci.datum = ci.heute;
    ci.feedback = "";
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
  ci.wahl = est ? { kernblock: est.kernblock === true, musik: est.musik === true, status: est.status }
                : { kernblock: null, musik: null, status: null };

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
  if (est && !ci.feedback)
    card.appendChild(dzEl("div", "ci-mini ci-vorhanden", "Für diesen Tag ist schon ein Eintrag da — Speichern überschreibt ihn."));

  // Schnell abhaken (Sandro-Feedback 25.08.: Push -> 1 Tap = fertig). Speichert sofort;
  // eine schon vorhandene Tages-Notiz bleibt erhalten (Notiz-Feld ist vorbefuellt).
  const quick = dzEl("div", "ci-quick");
  const q1 = dzEl("button", "ci-pill p-gruen ci-quick-btn", "⚡ Grün — Kernblock ✓ · Musik ✓");
  q1.type = "button";
  const q2 = dzEl("button", "ci-pill p-joker ci-quick-btn", "Joker — freier Tag");
  q2.type = "button";
  quick.appendChild(q1); quick.appendChild(q2);
  card.appendChild(quick);
  card.appendChild(dzEl("div", "ci-mini", "… oder im Detail:"));

  // Die drei Fragen (je 1 Tap) + Notiz (optional) + Speichern (1 Tap)
  let syncSave = function(){};
  const frage = (label, key, optionen) => {
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
    return row;
  };
  card.appendChild(frage("Kernblock erledigt? (17–20 Uhr bzw. 3 h Business + Fenster/Bodo)", "kernblock",
    [[true, "Ja"], [false, "Nein"]]));
  card.appendChild(frage("Musik-Stunde gemacht?", "musik",
    [[true, "Ja"], [false, "Nein"]]));
  card.appendChild(frage("Tag insgesamt", "status",
    [["gruen", "Grün", "p-gruen"], ["joker", "Joker", "p-joker"], ["rot", "Rot", "p-rot"]]));

  const ta = dzEl("textarea", "ci-notiz");
  ta.rows = 2;
  ta.placeholder = "Anmerkung (optional) — einfach diktieren";
  if (est && est.notiz) ta.value = est.notiz;
  card.appendChild(ta);

  const save = dzEl("button", "primary ci-save", "Speichern");
  save.type = "button";
  const hint = dzEl("div", "dz-hint");
  syncSave = () => { save.disabled = ci.wahl.kernblock == null || ci.wahl.musik == null || !ci.wahl.status; };
  syncSave();
  // Eine Speicherroutine fuer beide Wege (Schnell-Buttons + Detail-Formular). Die vorhandene
  // Tages-Notiz bleibt bei den Schnell-Buttons erhalten, weil das Notiz-Feld vorbefuellt ist.
  const speichern = async (wahl, btn) => {
    if (ci.busy) return;
    ci.busy = true;
    const alt = btn.textContent;
    btn.disabled = true; btn.textContent = "Speichere …"; hint.textContent = "";
    try {
      const r = await api("ci_save", { token: state.token, datum: ci.datum,
        kernblock: wahl.kernblock === true, musik: wahl.musik === true,
        status: wahl.status, notiz: ta.value.trim() });
      if (!r || !r.ok) throw new Error((r && r.error) || "Fehler beim Speichern");
      ci.days = r.days || ci.days;
      if (r.heute) ci.heute = r.heute;
      ci.feedback = "✓ Eintrag für " + ciSchoen(ci.datum) + " gespeichert.";
      ciRender();
    } catch (err){
      hint.textContent = String(err && err.message ? err.message : err);
      btn.textContent = alt; btn.disabled = false;
      syncSave();
    } finally { ci.busy = false; }
  };
  save.onclick = () => { if (!save.disabled) speichern(ci.wahl, save); };
  q1.onclick = () => speichern({ kernblock: true,  musik: true,  status: "gruen" }, q1);
  q2.onclick = () => speichern({ kernblock: false, musik: false, status: "joker" }, q2);
  card.appendChild(save);
  card.appendChild(hint);
  v.appendChild(card);

  // Streak + letzte 14 Tage
  const skarte = dzEl("div", "ci-card");
  const n = ciStreak(ci.days, ci.heute);
  const sbox = dzEl("div", "ci-streak");
  sbox.appendChild(dzEl("span", "ci-streak-zahl" + (n ? "" : " leer"), String(n)));
  sbox.appendChild(dzEl("span", "ci-streak-lbl", n === 1 ? "Tag im System" : "Tage im System"));
  skarte.appendChild(sbox);
  skarte.appendChild(dzEl("div", "ci-mini",
    "Regel: nie 2 rote Tage in Folge. Grün & Joker brechen nichts, ein einzelnes Rot auch nicht. " +
    "Nur eingetragene Tage zählen — eine Lücke beendet die Zählung."));

  const grid = dzEl("div", "ci-kacheln");
  for (let i = 13; i >= 0; i--){
    const d = ciShift(ci.heute, -i);
    const e = ci.days[d];
    const k = dzEl("button", "ci-kachel " + (e ? "k-" + e.status : "k-leer"));
    k.type = "button";
    if (d === ci.heute) k.classList.add("k-heute");
    if (d === ci.datum) k.classList.add("k-akt");
    k.title = ciSchoen(d) + " · " + (e ? e.status + (e.notiz ? " · " + e.notiz.slice(0, 80) : "") : "kein Eintrag");
    k.appendChild(dzEl("span", "ci-kachel-tag", ciWtag(d)));
    if (ciDiffTage(ci.heute, d) <= 7)
      k.onclick = () => { ci.datum = d; ci.feedback = ""; ciRender(); };
    else k.disabled = true;
    grid.appendChild(k);
  }
  skarte.appendChild(grid);
  skarte.appendChild(dzEl("div", "ci-mini", "Kachel antippen = Tag nachtragen (bis 7 Tage zurück)."));
  v.appendChild(skarte);
}
