/* Tablet-Tracker — neue Tablet-Ansicht (#tablet2), Sandro-Auftrag 2026-10-24: erst als zweite, umschaltbare
   Ansicht neben dem bisherigen Tablet-Dashboard (#tablet), damit er vergleichen kann. Musik-Modul gibt es hier nicht.
   Backend: tablet2.gs (t2_get / t2_save) -> os-data/tablet2.json. Messwerte des PCs (ActivityWatch + Claude-Code-
   Transkripte, Script C:\Users\Claude\tracker\aw_tracker.py alle 15 min) kommen read-only aus os-data/tracker-auto.json.
   XSS-Politik der App gilt auch hier: dynamische Daten nur per textContent (dzEl), nie innerHTML.

   Regeln (Sandro 24.10.):
   - Tag: Tagestyp Schicht/frei (Kalender "DHL …", ueberschreibbar) · Business-Timer, Ziel 3:00 h, unter 1:00 h rot ·
     Workout Tag A/B im Wechsel nach jedem erledigten Workout, rot wenn gestern ausgefallen (nie 2x in Folge) ·
     Deckel Games/Folgen/Videos je 3 -> 0 · unter 90 min Business sind die Deckel ausgegraut (sichtbar, NICHT gesperrt) ·
     Zigaretten + Aufstehzeit nur Daten · Schichttag: Games ab 07:00 bis Tagesende gesperrt ("kein Game nach der Schicht").
   - Woche: 21 h Ziel, Reset mit dem Montag, kein Uebertrag · Streaks Coaching (Tage >= 3 h) + Workout (nie 2 Pausen in
     Folge) · Social-Treffen-Datum, leer = rot ab Sonntag · Sonntag: Wochen-Review + Ziel naechste Woche (1 Satz).
   - Belohnungsleiter immer sichtbar: Coaching x/14 · Kirei EG = Business-Ziel 1 · Kirei ML = erster Euro · Latzug x/56.

   Business-Zeit eines Tages = manuelle Korrektur, sonst VEREINIGUNG aus Timer-Sitzungen und Tracker-Business-Intervallen
   (ActivityWatch, AFK abgezogen): der Timer faengt Arbeit ohne PC, der Tracker den vergessenen Timer, doppelt gezaehlt
   wird nichts. Games = Korrektur, sonst max(getippt, vom Tracker erkannt) — wer beim Start tippt, zaehlt nicht doppelt.
   Tagesgrenze 04:00 Europe/Berlin wie beim Check-in (ciEffHeuteLokal_/ciShift/ciDiffTage aus ci.js). */

const T2 = {
  ZIEL_MIN: 180, MIN_MIN: 60, REIHENFOLGE_MIN: 90, WOCHE_ZIEL_MIN: 21 * 60,
  DECKEL: 3, COACHING_TAGE: 14, LATZUG_TAGE: 56, MESS_TAGE: 14,
  SPERRE_AB: "07:00", EDIT_TAGE: 7, TIMER_WARN_MS: 6 * 3600000,
  REFRESH_MS: 5 * 60 * 1000, TRACKER_ALT_MS: 40 * 60 * 1000
};
const T2_DECKEL = [ { key:"games", label:"Games" }, { key:"folgen", label:"Folgen" }, { key:"videos", label:"Videos", hinweis:"1 pro Session" } ];

const t2 = { daten:null, auto:null, schichten:null, heute:null, offset:0, tag:null, seite:"tag", panel:"",
             queue:[], sendet:false, fehler:"", tick:null, refresh:null, hooked:false, refs:{},
             workoutWahl:{}, erreichtGesendet:{}, reviewText:null, agendaOffen:false };

/* ---------- Zeit (Europe/Berlin, DST-fest ueber Intl) ---------- */
const T2_FMT = new Intl.DateTimeFormat("en-CA", { timeZone:"Europe/Berlin", year:"numeric", month:"2-digit", day:"2-digit",
  hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23" });
function t2Teile(ms){
  const o = {};
  T2_FMT.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  return { y:+o.year, mo:+o.month, d:+o.day, h:(+o.hour) % 24, mi:+o.minute, s:+o.second };
}
function t2OffsetMs(ms){ const p = t2Teile(ms); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; }
// "YYYY-MM-DD" + "HH:MM" Berliner Wanduhr -> ms (zweimal angleichen, falls der Offset zwischen Schaetzung und Ziel wechselt)
function t2BerlinMs(datum, hhmm){
  const a = datum.split("-").map(Number), b = hhmm.split(":").map(Number);
  const wand = Date.UTC(a[0], a[1] - 1, a[2], b[0], b[1]);
  let ms = wand - t2OffsetMs(wand);
  ms = wand - t2OffsetMs(ms);
  return ms;
}
function t2TagStart(datum){ return t2BerlinMs(datum, "04:00"); }
function t2TagEnde(datum){ return t2BerlinMs(ciShift(datum, 1), "04:00"); }
// Uhrzeit innerhalb eines effektiven Tages: 00:00–03:59 gehoert schon zum naechsten Kalendertag
function t2ZeitImTag(datum, hhmm){ return Number(hhmm.slice(0, 2)) < 4 ? t2BerlinMs(ciShift(datum, 1), hhmm) : t2BerlinMs(datum, hhmm); }
function t2Jetzt(){ return Date.now() + t2.offset; }
function t2Zwei(n){ return String(n).padStart(2, "0"); }
function t2Uhr(ms){ const p = t2Teile(ms); return t2Zwei(p.h) + ":" + t2Zwei(p.mi); }
function t2HM(min){ const m = Math.max(0, Math.round(min)); return Math.floor(m / 60) + ":" + t2Zwei(m % 60); }
function t2HMS(ms){ const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 3600) + ":" + t2Zwei(Math.floor(s / 60) % 60) + ":" + t2Zwei(s % 60); }
function t2Std(min){ return (Math.round(min / 6) / 10).toLocaleString("de-DE", { minimumFractionDigits:1, maximumFractionDigits:1 }) + " h"; }
function t2Montag(datum){ return ciShift(datum, -((ciWtagNr(datum) + 6) % 7)); }
function t2KW(iso){
  const d = new Date(ciTagUtc(iso));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);           // Donnerstag der Woche
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}
function t2Kurz(iso){ return iso.slice(8, 10) + "." + iso.slice(5, 7) + "."; }

/* ---------- Daten-Zugriff ---------- */
function t2Tag(datum){ return (t2.daten && t2.daten.tage && t2.daten.tage[datum]) || {}; }
function t2AutoTag(datum){ return (t2.auto && t2.auto.tage && t2.auto.tage[datum]) || null; }
function t2Laeuft(){ return (t2.daten && t2.daten.timer && t2.daten.timer.laeuft) ? Date.parse(t2.daten.timer.laeuft) : null; }
function t2Start(){ return (t2.daten && t2.daten.start) || t2.heute; }
function t2Woche(montag){ return (t2.daten && t2.daten.wochen && t2.daten.wochen[montag]) || {}; }

function t2Schicht(datum){
  const o = t2Tag(datum).typ;
  const kal = (t2.schichten && t2.schichten.tage && t2.schichten.tage[datum]) || null;
  return { schicht: o ? o === "schicht" : !!kal, manuell: !!o, kal: kal };
}

/* ---------- Rechnen ---------- */
function t2Vereinigung(iv){
  const s = iv.filter(x => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  let summe = 0, a = null, e = null;
  s.forEach(x => {
    if (a === null || x[0] > e){ if (a !== null) summe += e - a; a = x[0]; e = x[1]; }
    else if (x[1] > e) e = x[1];
  });
  if (a !== null) summe += e - a;
  return summe;
}
// Business-Zeit des Tages (Minuten). Laufender Timer zaehlt bis jetzt, auf die Tagesgrenzen geschnitten.
function t2Business(datum){
  const s0 = t2TagStart(datum), e0 = t2TagEnde(datum), jetzt = t2Jetzt();
  const tag = t2Tag(datum), a = t2AutoTag(datum);
  const clip = (x) => [Math.max(x[0], s0), Math.min(x[1], e0)];
  const timer = (tag.timer || []).map(clip);
  const lauf = t2Laeuft();
  if (lauf !== null && lauf < e0 && jetzt > s0) timer.push(clip([lauf, jetzt]));
  const timerMs = timer.reduce((n, x) => n + Math.max(0, x[1] - x[0]), 0);
  let autoIv = (a && Array.isArray(a.business_iv)) ? a.business_iv.map(clip) : [];
  const autoMin = (a && a.min && typeof a.min.business === "number") ? a.min.business : null;
  let vereinigt;
  if (autoIv.length || autoMin === null) vereinigt = t2Vereinigung(timer.concat(autoIv)) / 60000;
  else vereinigt = Math.max(timerMs / 60000, autoMin);                       // alter Tracker-Tag ohne Intervalle
  const korr = (typeof tag.business_min === "number") ? tag.business_min : null;
  return { min: korr !== null ? korr : vereinigt, timerMin: timerMs / 60000, autoMin: autoMin, vereinigt: vereinigt,
           korr: korr, timer: timer, laeuftHeute: lauf !== null && lauf < e0 && jetzt > s0 };
}
function t2Deckel(datum, key){
  const tag = t2Tag(datum), manuell = (tag.z && tag.z[key]) || 0;
  let genutzt = manuell, auto = null, korr = null;
  if (key === "games"){
    const a = t2AutoTag(datum);
    auto = a && typeof a.games === "number" ? a.games : null;
    korr = typeof tag.games_korr === "number" ? tag.games_korr : null;
    genutzt = korr !== null ? korr : Math.max(manuell, auto || 0);
  }
  return { genutzt: genutzt, rest: T2.DECKEL - genutzt, manuell: manuell, auto: auto, korr: korr };
}
function t2GameSperre(datum){
  if (!t2Schicht(datum).schicht) return null;
  const ab = t2BerlinMs(datum, T2.SPERRE_AB);
  const a = t2AutoTag(datum);
  const verstoss = !!(a && Array.isArray(a.game_phasen) && a.game_phasen.some(p => p[0] >= ab));
  return { ab: ab, aktiv: datum < t2.heute || t2Jetzt() >= ab, verstoss: verstoss };
}
function t2WorkoutTypVorher(datum){
  const tage = (t2.daten && t2.daten.tage) || {};
  const k = Object.keys(tage).filter(d => d < datum && tage[d].workout).sort();
  return k.length ? tage[k[k.length - 1]].workout.typ : null;
}
function t2Workout(datum){
  const w = t2Tag(datum).workout || null;
  const vorher = t2WorkoutTypVorher(datum);
  const geplant = vorher === "A" ? "B" : "A";
  const gestern = ciShift(datum, -1);
  return { erledigt: !!w, typ: w ? w.typ : (t2.workoutWahl[datum] || geplant), um: w ? w.um : null,
           naechster: w ? (w.typ === "A" ? "B" : "A") : null,
           gesternAus: gestern >= t2Start() && !t2Tag(gestern).workout };
}
// Coaching: aufeinanderfolgende Tage mit >= 3 h. Der laufende Tag zaehlt, sobald erreicht, und bricht nichts.
function t2CoachingStreak(){
  const start = t2Start();
  let n = t2Business(t2.heute).min >= T2.ZIEL_MIN ? 1 : 0;
  for (let d = ciShift(t2.heute, -1); d >= start && t2Business(d).min >= T2.ZIEL_MIN; d = ciShift(d, -1)) n++;
  return n;
}
// Workout (Latzug): Kalendertage seit dem letzten Doppel-Ausfall (zwei Tage in Folge ohne Workout). Ein einzelner
// Pausentag zaehlt mit; heute zaehlt erst, wenn erledigt (der laufende Tag bricht nichts).
function t2WorkoutStreak(){
  const start = t2Start(), erledigt = (d) => !!t2Tag(d).workout;
  let n = erledigt(t2.heute) ? 1 : 0;
  for (let d = ciShift(t2.heute, -1); d >= start; d = ciShift(d, -1)){
    const vor = ciShift(d, -1);
    if (!erledigt(d) && vor >= start && !erledigt(vor)) break;
    n++;
  }
  return n;
}
function t2WocheStat(montag){
  const tage = [];
  let summe = 0;
  for (let i = 0; i < 7; i++){
    const d = ciShift(montag, i), zukunft = d > t2.heute;
    const min = zukunft ? 0 : t2Business(d).min;
    summe += min;
    tage.push({ datum: d, min: min, zukunft: zukunft, vorStart: d < t2Start() });
  }
  const sonntag = ciShift(montag, 6);
  const restTage = (t2.heute >= montag && t2.heute <= sonntag) ? ciDiffTage(sonntag, t2.heute) + 1 : 0;
  return { montag: montag, sonntag: sonntag, tage: tage, summe: summe, restTage: restTage, rest: Math.max(0, T2.WOCHE_ZIEL_MIN - summe) };
}
function t2Aufstehen(datum){
  const o = t2Tag(datum).aufstehzeit, a = t2AutoTag(datum);
  if (o) return { zeit: o, quelle: "manuell" };
  if (a && a.aufstehzeit) return { zeit: a.aufstehzeit, quelle: "Tracker" };
  return { zeit: null, quelle: "" };
}
function t2ErsterStart(datum){
  const b = t2Business(datum), starts = (t2Tag(datum).timer || []).map(x => x[0]);
  const lauf = t2Laeuft();
  if (b.laeuftHeute && lauf !== null) starts.push(Math.max(lauf, t2TagStart(datum)));
  return starts.length ? Math.min.apply(null, starts) : null;
}

/* ---------- Laden + Speichern ---------- */
async function t2Laden(){
  const r = await api("t2_get", { token: state.token });
  if (!r || !r.ok) throw new Error((r && r.error) || "t2_get fehlgeschlagen");
  t2.daten = r.daten; t2.auto = r.auto || null; t2.schichten = r.schichten || null;
  t2.heute = r.heute || ciEffHeuteLokal_();
  if (typeof r.jetzt === "number") t2.offset = r.jetzt - Date.now();
  if (!t2.tag || t2.tag > t2.heute || ciDiffTage(t2.heute, t2.tag) > T2.EDIT_TAGE) t2.tag = t2.heute;
}
// Jede Aenderung geht einzeln und in Reihenfolge ans Backend; Zaehler/Timer werden sofort lokal angezeigt (optimistisch),
// die Server-Antwort ersetzt den Stand, sobald nichts mehr aussteht. Fehler: Hinweis + frisch laden.
function t2Senden(op, lokal){
  if (lokal && t2.daten){ try { lokal(t2.daten); } catch(e){} }
  t2.queue.push(op);
  t2Render();
  if (!t2.sendet) t2Abarbeiten();
}
async function t2Abarbeiten(){
  t2.sendet = true;
  while (t2.queue.length){
    const op = t2.queue[0];
    let r = null, fehler = "";
    try {
      r = await api("t2_save", Object.assign({ token: state.token }, op));
      if (!r || !r.ok) fehler = (r && r.error) || "keine Antwort vom Backend";
    } catch(e){ fehler = String(e && e.message ? e.message : e); }
    t2.queue.shift();
    if (fehler){
      t2.queue = []; t2.sendet = false;
      t2.fehler = "Nicht gespeichert: " + fehler;
      try { await t2Laden(); } catch(e){}
      t2Render();
      return;
    }
    if (typeof r.jetzt === "number") t2.offset = r.jetzt - Date.now();
    if (r.heute) t2.heute = r.heute;
    if (!t2.queue.length) t2.daten = r.daten;
  }
  t2.sendet = false;
  t2.fehler = "";
  t2Render();
}
function t2TagLokal(daten, datum){ return daten.tage[datum] = daten.tage[datum] || {}; }

/* ---------- Mount, Takt, Refresh ---------- */
function t2Stop(){
  if (t2.tick){ clearInterval(t2.tick); t2.tick = null; }
  if (t2.refresh){ clearInterval(t2.refresh); t2.refresh = null; }
}
function t2DarfNeuZeichnen(){
  const f = document.activeElement;
  return !t2.panel && !t2.sendet && !(f && /INPUT|TEXTAREA/.test(f.tagName) && f.closest("#tablet2-view"));
}
async function t2Mount(){
  const v = $("tablet2-view");
  if (!v) return;
  t2Stop();
  dzClear(v);
  v.appendChild(dzEl("div", "dz-loading", "Lade Tablet-Tracker …"));
  try {
    await t2Laden();
    t2.seite = "tag"; t2.panel = "";
    t2Render();
  } catch (err){
    dzClear(v);
    v.appendChild(dzEl("div", "dz-error", "Tracker nicht ladbar: " + (err && err.message ? err.message : err)));
    const retry = dzEl("button", "dz-btn", "Nochmal versuchen");
    retry.onclick = t2Mount;
    v.appendChild(retry);
    const alt = dzEl("button", "dz-btn", "Zur klassischen Ansicht");
    alt.onclick = () => t2Wechsel("tablet");
    v.appendChild(alt);
    return;
  }
  let sek = 0;
  t2.tick = setInterval(() => {
    if (state.mode !== "tablet2"){ t2Stop(); return; }
    sek++;
    if (ciEffHeuteLokal_(t2Jetzt()) !== t2.heute){ t2NeuLaden(); return; }   // 04:00-Grenze ueberschritten
    t2Sekunde();
    if (sek % 60 === 0 && t2DarfNeuZeichnen()) t2Render();                   // Uhr, Sperren, Reihenfolge
  }, 1000);
  t2.refresh = setInterval(() => { if (state.mode === "tablet2" && t2DarfNeuZeichnen()) t2NeuLaden(); }, T2.REFRESH_MS);
  if (window.tbWakeLock) tbWakeLock();
  if (!t2.hooked){
    t2.hooked = true;
    document.addEventListener("visibilitychange", () => {
      if (state.mode !== "tablet2" || document.visibilityState !== "visible") return;
      if (window.tbWakeLock) tbWakeLock();
      if (t2DarfNeuZeichnen()) t2NeuLaden();
    });
  }
}
window.t2Mount = t2Mount;
async function t2NeuLaden(){
  if (t2.sendet) return;
  try { await t2Laden(); t2Render(); } catch(e){ /* alter Stand bleibt, naechster Takt versucht es wieder */ }
}
// Umschalten alt <-> neu; die Wahl gilt auch fuer den Startbildschirm-Link #tablet (app.js startApp)
function t2Wechsel(modus){
  try { localStorage.setItem("qc_tb_variante", modus === "tablet2" ? "neu" : "alt"); } catch(e){}
  try { history.replaceState(null, "", "#" + modus); } catch(e){}
  const sel = $("mode-select"); if (sel) sel.value = modus;
  state.mode = modus; state.typ = null; dzSwitchMode();
}
window.t2Wechsel = t2Wechsel;

// Sekundentakt: nur Uhr, Timer-Anzeige und Business-Balken aktualisieren (kein Neuaufbau, offene Felder bleiben)
function t2Sekunde(){
  const r = t2.refs;
  if (r.uhr) r.uhr.textContent = t2Uhr(t2Jetzt());
  const lauf = t2Laeuft();
  if (lauf === null || t2.tag !== t2.heute) return;
  if (r.timer) r.timer.textContent = t2HMS(t2Jetzt() - lauf);
  if (r.business) t2BusinessAnzeige(r.business, t2Business(t2.heute));
}

/* ---------- Rendern ---------- */
function t2Btn(text, cls, onclick, title){
  const b = dzEl("button", cls || "dz-btn", text);
  b.type = "button";
  if (title) b.title = title;
  if (onclick) b.onclick = onclick;
  return b;
}
function t2Balken(anteil, cls, marken){
  const bar = dzEl("div", "t2-bar" + (cls ? " " + cls : ""));
  const fill = dzEl("div", "t2-bar-fill");
  fill.style.width = Math.round(Math.max(0, Math.min(1, anteil)) * 1000) / 10 + "%";
  bar.appendChild(fill);
  (marken || []).forEach(m => {
    const mk = dzEl("span", "t2-bar-marke", "");
    mk.style.left = Math.round(m.pos * 1000) / 10 + "%";
    mk.title = m.titel;
    bar.appendChild(mk);
  });
  return bar;
}
function t2Render(){
  const v = $("tablet2-view");
  if (!v || !t2.daten) return;
  const scroll = window.scrollY;
  dzClear(v);
  t2.refs = {};
  v.appendChild(t2Kopf());
  if (t2.fehler) v.appendChild(dzEl("div", "t2-fehler", t2.fehler));
  if (t2.seite === "review") v.appendChild(t2ReviewSeite());
  else {
    const grid = dzEl("div", "t2-grid");
    const s1 = dzEl("div", "t2-spalte t2-spalte-tag");
    s1.appendChild(t2KarteBusiness(t2.tag));
    s1.appendChild(t2KarteWorkout(t2.tag));
    s1.appendChild(t2KarteDeckel(t2.tag));
    s1.appendChild(t2KarteDaten(t2.tag));
    const s2 = dzEl("div", "t2-spalte t2-spalte-woche");
    s2.appendChild(t2KarteWoche());
    s2.appendChild(t2KarteMesswerte(t2.tag));
    const s3 = dzEl("div", "t2-spalte t2-spalte-leiter");
    s3.appendChild(t2KarteLeiter());
    grid.appendChild(s1); grid.appendChild(s2); grid.appendChild(s3);
    v.appendChild(grid);
  }
  if (t2.agendaOffen) v.appendChild(t2AgendaLade());
  window.scrollTo(0, scroll);
  t2Meilensteine();
}

// Stufen der Belohnungsleiter einmalig festhalten (einmal erreicht bleibt erreicht, auch wenn die Streak spaeter reisst)
function t2Meilensteine(){
  const er = (t2.daten.leiter && t2.daten.leiter.erreicht) || {};
  [["coaching", t2CoachingStreak(), T2.COACHING_TAGE], ["latzug", t2WorkoutStreak(), T2.LATZUG_TAGE]].forEach(x => {
    if (x[1] >= x[2] && !er[x[0]] && !t2.erreichtGesendet[x[0]]){
      t2.erreichtGesendet[x[0]] = true;
      t2Senden({ op:"erreicht", feld:x[0], datum:t2.heute });
    }
  });
}

function t2Kopf(){
  const head = dzEl("div", "t2-kopf");
  const links = dzEl("div", "t2-kopf-links");
  links.appendChild(dzEl("span", "t2-datum", tbJetzt({ weekday:"long", day:"numeric", month:"long" })));
  const uhr = dzEl("span", "t2-uhr", t2Uhr(t2Jetzt()));
  t2.refs.uhr = uhr;
  links.appendChild(uhr);
  // Tagestyp heute: Kalender (DHL-Termin) oder manuell; Tippen setzt das Gegenteil bzw. zurueck auf den Kalender
  const sch = t2Schicht(t2.heute);
  const chip = t2Btn(sch.schicht ? "Schicht" + (sch.kal && !sch.manuell ? " " + sch.kal.map(k => k.s + "–" + k.e).join(", ") : "") : "Frei",
    "t2-chip " + (sch.schicht ? "t2-chip-schicht" : "t2-chip-frei"), () => {
      const kalSchicht = !!(t2.schichten && t2.schichten.tage && t2.schichten.tage[t2.heute]);
      const wert = sch.manuell ? null : (kalSchicht ? "frei" : "schicht");
      t2Senden({ op:"setzen", datum:t2.heute, feld:"typ", wert:wert }, d => {
        const t = t2TagLokal(d, t2.heute); if (wert) t.typ = wert; else delete t.typ;
      });
    }, "Tagestyp umschalten (Kalender ↔ manuell)");
  if (sch.manuell) chip.appendChild(dzEl("span", "t2-chip-zusatz", "manuell"));
  else chip.appendChild(dzEl("span", "t2-chip-zusatz", "Kalender"));
  links.appendChild(chip);
  if (t2.schichten && t2.schichten.fehler) links.appendChild(dzEl("span", "t2-mini t2-warn", "Kalender: " + t2.schichten.fehler));
  head.appendChild(links);

  const knoepfe = dzEl("div", "t2-knoepfe");
  if (t2.sendet || t2.queue.length) knoepfe.appendChild(dzEl("span", "t2-mini t2-speichert", "speichert …"));
  const montag = t2Montag(t2.heute);
  if (ciWtagNr(t2.heute) === 0 && !t2Woche(montag).review_um && t2.seite !== "review")
    knoepfe.appendChild(t2Btn("Wochen-Review", "primary t2-btn t2-btn-review", () => { t2.seite = "review"; t2.panel = ""; t2Render(); }));
  knoepfe.appendChild(t2Btn(t2.agendaOffen ? "Termine zu" : "Termine", "dz-btn t2-btn", async () => {
    t2.agendaOffen = !t2.agendaOffen; t2Render();
    if (t2.agendaOffen && window.tbLadeAgenda_){ await tbLadeAgenda_(); if (state.mode === "tablet2" && t2.agendaOffen) t2Render(); }
  }, "Kalender + Aufgaben (wie in der klassischen Ansicht)"));
  const bRefresh = t2Btn("↻", "dz-btn t2-btn", async () => { bRefresh.disabled = true; t2.fehler = ""; await t2NeuLaden(); bRefresh.disabled = false; }, "Jetzt aktualisieren");
  knoepfe.appendChild(bRefresh);
  knoepfe.appendChild(t2Btn("Klassische Ansicht", "dz-btn t2-btn", () => t2Wechsel("tablet"), "Zum bisherigen Tablet-Dashboard"));
  knoepfe.appendChild(t2Btn("Menü", "dz-btn t2-btn", () => { document.body.classList.toggle("tablet-mode"); }, "Topbar mit Bereichswahl einblenden"));
  head.appendChild(knoepfe);
  return head;
}

function t2KarteKopf(card, titel, zusatz){
  const k = dzEl("div", "t2-karte-kopf");
  k.appendChild(dzEl("span", "t2-karte-titel", titel));
  if (zusatz) k.appendChild(zusatz);
  card.appendChild(k);
  return k;
}
function t2Tagwahl(){
  const box = dzEl("div", "t2-tagwahl");
  const zurueck = t2Btn("‹", "dz-btn t2-pfeil", () => { t2.tag = ciShift(t2.tag, -1); t2.panel = ""; t2Render(); }, "Vortag");
  zurueck.disabled = ciDiffTage(t2.heute, t2.tag) >= T2.EDIT_TAGE;
  const vor = t2Btn("›", "dz-btn t2-pfeil", () => { t2.tag = ciShift(t2.tag, 1); t2.panel = ""; t2Render(); }, "Folgetag");
  vor.disabled = t2.tag >= t2.heute;
  box.appendChild(zurueck);
  box.appendChild(dzEl("span", "t2-tagwahl-text", t2.tag === t2.heute ? "Heute · " + ciSchoen(t2.tag) : ciSchoen(t2.tag)));
  box.appendChild(vor);
  if (t2.tag !== t2.heute) box.appendChild(t2Btn("Heute", "dz-btn t2-btn-klein", () => { t2.tag = t2.heute; t2.panel = ""; t2Render(); }));
  return box;
}

// Business-Status (Text, Balken, Farbe) — auch vom Sekundentakt genutzt
function t2BusinessAnzeige(refs, b){
  const st = b.min >= T2.ZIEL_MIN ? "st-gruen" : (b.min >= T2.MIN_MIN ? "st-amber" : "st-rot");
  refs.card.classList.remove("st-gruen", "st-amber", "st-rot");
  refs.card.classList.add(st);
  refs.summe.textContent = t2HM(b.min) + " h";
  refs.status.textContent = b.min >= T2.ZIEL_MIN ? "Ziel 3:00 h erreicht ✓"
    : b.min >= T2.MIN_MIN ? "Minimum geschafft — noch " + t2HM(T2.ZIEL_MIN - b.min) + " bis zum Ziel"
    : "Minimum 1:00 h — fehlt noch " + t2HM(T2.MIN_MIN - b.min);
  refs.fill.style.width = Math.round(Math.min(1, b.min / T2.ZIEL_MIN) * 1000) / 10 + "%";
  refs.detail.textContent = (b.korr !== null ? "Korrektur aktiv: " + t2HM(b.korr) + " h · " : "") +
    "Timer " + t2HM(b.timerMin) + " · Tracker " + (b.autoMin === null ? "–" : t2HM(b.autoMin)) + " · zusammen " + t2HM(b.vereinigt);
}

function t2KarteBusiness(datum){
  const card = dzEl("div", "t2-card t2-business");
  const kopf = t2KarteKopf(card, "Business", dzEl("span", "t2-pflicht", "Pflicht · Ziel 3:00 h"));
  kopf.appendChild(t2Tagwahl());
  const b = t2Business(datum);
  const lauf = t2Laeuft();
  if (datum === t2.heute){
    const zeile = dzEl("div", "t2-timer-zeile");
    const anzeige = dzEl("div", "t2-timer" + (lauf !== null ? " laeuft" : ""), lauf !== null ? t2HMS(t2Jetzt() - lauf) : "Timer aus");
    t2.refs.timer = lauf !== null ? anzeige : null;
    zeile.appendChild(anzeige);
    if (lauf === null) zeile.appendChild(t2Btn("▶ Start", "primary t2-timer-btn t2-start", () => {
      t2Senden({ op:"timer_start" }, d => { d.timer.laeuft = new Date(t2Jetzt()).toISOString(); });
    }));
    else zeile.appendChild(t2Btn("■ Stop", "primary t2-timer-btn t2-stopp", () => {
      t2Senden({ op:"timer_stop" }, d => {
        const s = Date.parse(d.timer.laeuft), e = t2Jetzt();
        d.timer.laeuft = null;
        if (e > s){ const t = t2TagLokal(d, t2.heute); (t.timer = t.timer || []).push([s, e]); }
      });
    }));
    card.appendChild(zeile);
    if (lauf !== null && t2Jetzt() - lauf > T2.TIMER_WARN_MS)
      card.appendChild(dzEl("div", "t2-warnzeile", "Timer läuft seit " + t2HM((t2Jetzt() - lauf) / 60000) + " h — vergessen? Stoppen und unter „Korrigieren“ anpassen."));
  } else if (lauf !== null && b.laeuftHeute === false && datum < t2.heute){
    card.appendChild(dzEl("div", "t2-mini", "Timer läuft gerade (heute)."));
  }
  const summeZeile = dzEl("div", "t2-summe-zeile");
  const summe = dzEl("span", "t2-summe", "");
  const status = dzEl("span", "t2-status", "");
  summeZeile.appendChild(summe);
  summeZeile.appendChild(status);
  card.appendChild(summeZeile);
  const bar = t2Balken(0, "t2-bar-business", [
    { pos: T2.MIN_MIN / T2.ZIEL_MIN, titel: "Minimum 1:00 h" },
    { pos: T2.REIHENFOLGE_MIN / T2.ZIEL_MIN, titel: "90 min: ab hier Deckel frei" } ]);
  card.appendChild(bar);
  const detailZeile = dzEl("div", "t2-detail-zeile");
  const detail = dzEl("span", "t2-mini", "");
  detailZeile.appendChild(detail);
  detailZeile.appendChild(t2Btn(t2.panel === "business" ? "Schließen" : "✎ Korrigieren", "dz-btn t2-btn-klein", () => {
    t2.panel = t2.panel === "business" ? "" : "business"; t2Render();
  }));
  card.appendChild(detailZeile);
  const refs = { card: card, summe: summe, status: status, fill: bar.firstChild, detail: detail };
  if (datum === t2.heute) t2.refs.business = refs;
  t2BusinessAnzeige(refs, b);
  if (t2.panel === "business") card.appendChild(t2PanelBusiness(datum, b));
  return card;
}

function t2PanelBusiness(datum, b){
  const p = dzEl("div", "t2-panel");
  const tag = t2Tag(datum);
  p.appendChild(dzEl("div", "t2-panel-titel", "Timer-Sitzungen " + (datum === t2.heute ? "heute" : ciSchoen(datum))));
  const liste = tag.timer || [];
  if (!liste.length) p.appendChild(dzEl("div", "t2-mini", "keine abgeschlossenen Sitzungen"));
  liste.forEach((x, i) => {
    const z = dzEl("div", "t2-sitzung");
    z.appendChild(dzEl("span", "", t2Uhr(x[0]) + "–" + t2Uhr(x[1]) + " · " + t2HM((x[1] - x[0]) / 60000) + " h"));
    z.appendChild(t2Btn("Löschen", "dz-btn t2-btn-klein", () => {
      if (!confirm("Sitzung " + t2Uhr(x[0]) + "–" + t2Uhr(x[1]) + " löschen?")) return;
      t2Senden({ op:"sitzung_loeschen", datum:datum, idx:i });
    }));
    p.appendChild(z);
  });
  if (datum === t2.heute && t2Laeuft() !== null)
    p.appendChild(t2Btn("Laufenden Timer verwerfen (nicht zählen)", "dz-btn t2-btn-klein", () => {
      if (!confirm("Laufenden Timer verwerfen? Die Zeit seit " + t2Uhr(t2Laeuft()) + " zählt dann nicht.")) return;
      t2Senden({ op:"timer_verwerfen" }, d => { d.timer.laeuft = null; });
    }));
  p.appendChild(dzEl("div", "t2-mini", "Tracker (Fenster, ohne AFK): " + (b.autoMin === null ? "keine Daten" : t2HM(b.autoMin) + " h") +
    " · Timer ∪ Tracker: " + t2HM(b.vereinigt) + " h"));
  const zeile = dzEl("div", "t2-panel-zeile");
  zeile.appendChild(dzEl("span", "t2-mini", "Tag gesamt manuell:"));
  const inp = document.createElement("input");
  inp.className = "t2-input"; inp.type = "text"; inp.inputMode = "decimal"; inp.placeholder = "z. B. 2:30";
  inp.value = b.korr !== null ? t2HM(b.korr) : "";
  zeile.appendChild(inp);
  zeile.appendChild(t2Btn("Übernehmen", "primary t2-btn-klein", () => {
    const m = /^\s*(\d{1,2})(?:[:,.](\d{1,2}))?\s*$/.exec(inp.value);
    if (!m){ alert("Bitte als h:mm (2:30) oder Stunden (2,5)."); return; }
    let min;
    if (inp.value.indexOf(":") >= 0) min = Number(m[1]) * 60 + Number(m[2] || 0);
    else min = Math.round(parseFloat(inp.value.replace(",", ".")) * 60);
    if (!(min >= 0 && min <= 1440)){ alert("0 bis 24 Stunden."); return; }
    t2.panel = "";
    t2Senden({ op:"setzen", datum:datum, feld:"business_min", wert:min }, d => { t2TagLokal(d, datum).business_min = min; });
  }));
  if (b.korr !== null) zeile.appendChild(t2Btn("Automatik", "dz-btn t2-btn-klein", () => {
    t2.panel = "";
    t2Senden({ op:"setzen", datum:datum, feld:"business_min", wert:null }, d => { delete t2TagLokal(d, datum).business_min; });
  }, "Korrektur entfernen: wieder Timer ∪ Tracker"));
  p.appendChild(zeile);
  return p;
}

function t2KarteWorkout(datum){
  const w = t2Workout(datum);
  const card = dzEl("div", "t2-card t2-workout" + (w.erledigt ? " st-gruen" : (w.gesternAus ? " st-rot" : "")));
  t2KarteKopf(card, "Workout · Tag " + w.typ, dzEl("span", "t2-pflicht", "Pflicht · nie 2× in Folge aus"));
  const zeile = dzEl("div", "t2-workout-zeile");
  if (w.erledigt){
    zeile.appendChild(dzEl("span", "t2-workout-ok", "✓ Tag " + w.typ + " erledigt" + (w.um ? " · " + t2Uhr(Date.parse(w.um)) : "")));
    zeile.appendChild(t2Btn("Rückgängig", "dz-btn t2-btn-klein", () => {
      t2Senden({ op:"workout", datum:datum, erledigt:false });
    }));
  } else {
    zeile.appendChild(t2Btn("✓ Tag " + w.typ + " erledigt", "primary t2-workout-btn", () => {
      t2Senden({ op:"workout", datum:datum, erledigt:true, typ:w.typ });
    }));
    zeile.appendChild(t2Btn("A/B tauschen", "dz-btn t2-btn-klein", () => {
      t2.workoutWahl[datum] = w.typ === "A" ? "B" : "A"; t2Render();
    }, "Falls du heute den anderen Tag trainierst"));
  }
  if (w.erledigt) zeile.appendChild(dzEl("span", "t2-mini", "Nächstes Workout: Tag " + w.naechster));
  else if (!w.gesternAus) zeile.appendChild(dzEl("span", "t2-mini", "wechselt nach jedem erledigten Workout"));
  card.appendChild(zeile);
  if (!w.erledigt && w.gesternAus) card.appendChild(dzEl("div", "t2-warnzeile", (datum === t2.heute ? "Gestern" : "Am Vortag") + " ausgefallen — heute Pflicht."));
  return card;
}

function t2KarteDeckel(datum){
  const b = t2Business(datum);
  const grau = datum === t2.heute && b.min < T2.REIHENFOLGE_MIN;
  const card = dzEl("div", "t2-card t2-deckel" + (grau ? " t2-grau" : ""));
  t2KarteKopf(card, "Deckel " + (datum === t2.heute ? "heute" : ciSchoen(datum)),
    dzEl("span", "t2-mini", grau ? "erst Business: noch " + t2HM(T2.REIHENFOLGE_MIN - b.min) + " bis 90 min" : "je 3 pro Tag"));
  const reihe = dzEl("div", "t2-deckel-reihe");
  const a = t2AutoTag(datum);
  T2_DECKEL.forEach(it => {
    const dk = t2Deckel(datum, it.key);
    const sperre = it.key === "games" ? t2GameSperre(datum) : null;
    const gesperrt = !!(sperre && sperre.aktiv);
    const kachel = dzEl("div", "t2-kachel" + (dk.rest < 0 || (sperre && sperre.verstoss) ? " st-rot" : (dk.rest === 0 ? " st-amber" : "")) + (gesperrt ? " t2-gesperrt" : ""));
    kachel.appendChild(dzEl("div", "t2-kachel-label", it.label + (gesperrt ? " 🔒" : "")));
    const zahlZeile = dzEl("div", "t2-kachel-zahlzeile");
    zahlZeile.appendChild(dzEl("span", "t2-kachel-zahl", String(dk.rest)));
    zahlZeile.appendChild(dzEl("span", "t2-mini", dk.rest < 0 ? (-dk.rest) + " über dem Deckel" : "von " + T2.DECKEL + " übrig"));
    kachel.appendChild(zahlZeile);
    const k = dzEl("div", "t2-kachel-knoepfe");
    const nehmen = t2Btn("−1", "dz-btn t2-kachel-btn", () => {
      t2Senden({ op:"zaehler", datum:datum, key:it.key, delta:1 }, d => {
        const t = t2TagLokal(d, datum); t.z = t.z || {}; t.z[it.key] = (t.z[it.key] || 0) + 1;
      });
    }, it.label + ": eine nehmen");
    nehmen.disabled = gesperrt;
    const undo = t2Btn("↩", "dz-btn t2-kachel-btn t2-undo", () => {
      t2Senden({ op:"zaehler", datum:datum, key:it.key, delta:-1 }, d => {
        const t = t2TagLokal(d, datum); if (t.z && t.z[it.key]) t.z[it.key]--;
      });
    }, "Letztes Tippen zurücknehmen");
    undo.disabled = !dk.manuell;
    k.appendChild(nehmen); k.appendChild(undo);
    kachel.appendChild(k);
    if (it.key === "games"){
      const autoTxt = dk.korr !== null ? "korrigiert auf " + dk.korr : (dk.auto === null ? "Tracker: –" : "Tracker: " + dk.auto + " erkannt");
      kachel.appendChild(t2Btn(autoTxt + " ✎", "t2-link", () => {
        const w = prompt("Games " + (datum === t2.heute ? "heute" : ciSchoen(datum)) + " tatsächlich (leer = automatisch):", dk.korr !== null ? String(dk.korr) : "");
        if (w === null) return;
        const wert = w.trim() === "" ? null : Number(w.trim());
        if (wert !== null && !(wert >= 0 && wert <= 30 && Math.floor(wert) === wert)){ alert("Ganze Zahl 0–30."); return; }
        t2Senden({ op:"setzen", datum:datum, feld:"games_korr", wert:wert }, d => {
          const t = t2TagLokal(d, datum); if (wert === null) delete t.games_korr; else t.games_korr = wert;
        });
      }, "Tracker-Zählung korrigieren"));
      if (sperre) kachel.appendChild(dzEl("div", "t2-mini" + (sperre.verstoss ? " t2-rot" : ""),
        sperre.verstoss ? "Game nach 07:00 am Schichttag" : "Schichttag: ab 07:00 kein Game"));
    } else {
      const minK = it.key === "folgen" ? "serie" : "youtube";
      if (a && a.min && typeof a.min[minK] === "number" && a.min[minK] > 0)
        kachel.appendChild(dzEl("div", "t2-mini", "PC: " + t2HM(a.min[minK]) + " h " + (minK === "serie" ? "Serie" : "YouTube")));
      else if (it.hinweis) kachel.appendChild(dzEl("div", "t2-mini", it.hinweis));
    }
    reihe.appendChild(kachel);
  });
  card.appendChild(reihe);
  return card;
}

function t2KarteDaten(datum){
  const card = dzEl("div", "t2-card t2-daten");
  card.title = "Nur Daten, ohne Ziel";
  const reihe = dzEl("div", "t2-daten-reihe");
  // Zigaretten
  const zig = dzEl("div", "t2-datum-feld");
  zig.appendChild(dzEl("span", "t2-feld-label", "Zigaretten"));
  const zz = dzEl("div", "t2-stepper");
  const n = (t2Tag(datum).z && t2Tag(datum).z.zigaretten) || 0;
  const minus = t2Btn("−", "dz-btn t2-step", () => t2Senden({ op:"zaehler", datum:datum, key:"zigaretten", delta:-1 }, d => {
    const t = t2TagLokal(d, datum); if (t.z && t.z.zigaretten) t.z.zigaretten--;
  }));
  minus.disabled = !n;
  zz.appendChild(minus);
  zz.appendChild(dzEl("span", "t2-step-zahl", String(n)));
  zz.appendChild(t2Btn("+", "dz-btn t2-step", () => t2Senden({ op:"zaehler", datum:datum, key:"zigaretten", delta:1 }, d => {
    const t = t2TagLokal(d, datum); t.z = t.z || {}; t.z.zigaretten = (t.z.zigaretten || 0) + 1;
  })));
  zig.appendChild(zz);
  reihe.appendChild(zig);
  // Aufstehzeit (Tracker: erste Aktivitaet nach >= 5 h AFK; manuell ueberschreibbar)
  const auf = t2Aufstehen(datum);
  const af = dzEl("div", "t2-datum-feld");
  af.appendChild(dzEl("span", "t2-feld-label", "Aufgestanden"));
  const az = dzEl("div", "t2-auf");
  az.appendChild(dzEl("span", "t2-step-zahl", auf.zeit || "–"));
  if (auf.quelle) az.appendChild(dzEl("span", "t2-mini", auf.quelle));
  az.appendChild(t2Btn("✎", "dz-btn t2-step", () => {
    const w = prompt("Aufstehzeit " + (datum === t2.heute ? "heute" : ciSchoen(datum)) + " (HH:MM, leer = vom Tracker):", t2Tag(datum).aufstehzeit || "");
    if (w === null) return;
    const s = w.trim().replace(".", ":");
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (s !== "" && (!m || Number(m[1]) > 23 || Number(m[2]) > 59)){ alert("Bitte als HH:MM."); return; }
    const wert = s === "" ? null : t2Zwei(Number(m[1])) + ":" + m[2];
    t2Senden({ op:"setzen", datum:datum, feld:"aufstehzeit", wert:wert }, d => {
      const t = t2TagLokal(d, datum); if (wert) t.aufstehzeit = wert; else delete t.aufstehzeit;
    });
  }, "Aufstehzeit korrigieren"));
  af.appendChild(az);
  reihe.appendChild(af);
  card.appendChild(reihe);
  return card;
}

function t2KarteWoche(){
  const montag = t2Montag(t2.heute), w = t2WocheStat(montag), wo = t2Woche(montag);
  const card = dzEl("div", "t2-card t2-woche");
  t2KarteKopf(card, "Woche · KW " + t2KW(montag), dzEl("span", "t2-mini", t2Kurz(montag) + "–" + t2Kurz(w.sonntag)));
  if (wo.ziel) card.appendChild(dzEl("div", "t2-wochenziel", "Ziel: " + wo.ziel));
  const zeile = dzEl("div", "t2-summe-zeile");
  zeile.appendChild(dzEl("span", "t2-summe", t2Std(w.summe).replace(" h", "") + " / 21 h"));
  zeile.appendChild(dzEl("span", "t2-status", w.rest <= 0 ? "Wochenziel erreicht ✓"
    : "noch " + t2Std(w.rest) + " in " + w.restTage + (w.restTage === 1 ? " Tag" : " Tagen") +
      (w.restTage ? " · Ø " + t2Std(w.rest / w.restTage) + "/Tag" : "")));
  card.appendChild(zeile);
  card.appendChild(t2Balken(w.summe / T2.WOCHE_ZIEL_MIN, w.rest <= 0 ? "t2-bar-gruen" : ""));
  // Tagesleiste Mo–So
  const leiste = dzEl("div", "t2-woche-tage");
  w.tage.forEach(t => {
    const st = t.zukunft || t.vorStart ? "z-na" : (t.min >= T2.ZIEL_MIN ? "z-gruen" : (t.min >= T2.MIN_MIN ? "z-joker" : (t.datum === t2.heute ? "z-leer" : "z-rot")));
    const z = dzEl("div", "t2-wt " + st + (t.datum === t2.heute ? " z-heute" : ""));
    z.appendChild(dzEl("span", "t2-wt-tag", CI_WTAGE[ciWtagNr(t.datum)]));
    z.appendChild(dzEl("span", "t2-wt-h", t.zukunft || t.vorStart ? "·" : t2HM(t.min)));
    leiste.appendChild(z);
  });
  card.appendChild(leiste);
  // Streaks
  const sr = dzEl("div", "t2-streaks");
  const cs = t2CoachingStreak(), ws = t2WorkoutStreak();
  const s1 = dzEl("div", "t2-streak");
  s1.appendChild(dzEl("span", "t2-streak-zahl", String(cs)));
  s1.appendChild(dzEl("span", "t2-streak-lbl", (cs === 1 ? "Tag" : "Tage") + " in Folge ≥ 3 h"));
  const s2 = dzEl("div", "t2-streak");
  s2.appendChild(dzEl("span", "t2-streak-zahl", String(ws)));
  s2.appendChild(dzEl("span", "t2-streak-lbl", (ws === 1 ? "Tag" : "Tage") + " Workout ohne 2× Pause"));
  sr.appendChild(s1); sr.appendChild(s2);
  card.appendChild(sr);
  // Social-Treffen
  const sonntag = ciWtagNr(t2.heute) === 0;
  const soc = dzEl("div", "t2-social" + (!wo.social && sonntag ? " st-rot" : (wo.social ? " st-gruen" : "")));
  soc.appendChild(dzEl("span", "t2-feld-label", "Social-Treffen"));
  const inp = document.createElement("input");
  inp.type = "date"; inp.className = "t2-input t2-date";
  inp.min = montag; inp.max = w.sonntag; inp.value = wo.social || "";
  inp.onchange = () => {
    const wert = inp.value || null;
    t2Senden({ op:"woche", montag:montag, feld:"social", wert:wert }, d => {
      const x = d.wochen[montag] = d.wochen[montag] || {}; if (wert) x.social = wert; else delete x.social;
    });
  };
  soc.appendChild(inp);
  soc.appendChild(dzEl("span", "t2-mini", wo.social ? (wo.social <= t2.heute ? "✓ war am " + ciSchoen(wo.social) : "geplant") : (sonntag ? "fehlt diese Woche" : "noch offen")));
  card.appendChild(soc);
  card.appendChild(t2Btn(sonntag ? "Wochen-Review machen" : "Wochen-Review ansehen", (sonntag && !wo.review_um ? "primary " : "dz-btn ") + "t2-btn t2-review-btn",
    () => { t2.seite = "review"; t2.panel = ""; t2Render(); }));
  return card;
}

function t2KarteMesswerte(datum){
  const card = dzEl("div", "t2-card t2-mess");
  const a = t2AutoTag(datum);
  // Messphase ab Installation von ActivityWatch (Tracker liefert messbeginn); "erst 2 Wochen Daten, dann Regeln"
  const ersteTag = t2.auto ? (t2.auto.messbeginn || (t2.auto.tage ? Object.keys(t2.auto.tage).sort()[0] : null)) : null;
  const messTag = ersteTag ? ciDiffTage(t2.heute, ersteTag) + 1 : 0;
  t2KarteKopf(card, "Messwerte (Tracker)", dzEl("span", "t2-mini", messTag && messTag <= T2.MESS_TAGE
    ? "Messphase Tag " + messTag + "/" + T2.MESS_TAGE + " — erst Daten, dann Regeln"
    : (messTag ? "Messphase vorbei — Regeln ableiten" : "")));
  if (!t2.auto){
    card.appendChild(dzEl("div", "t2-mini", "Noch keine Tracker-Daten. Der PC schreibt sie alle 15 min (ActivityWatch + Claude-Code-Verläufe), sobald er an ist."));
    return card;
  }
  const kach = dzEl("div", "t2-mess-reihe");
  const kachel = (zahl, label, sub) => {
    const k = dzEl("div", "t2-mess-kachel");
    k.appendChild(dzEl("div", "t2-mess-zahl", zahl));
    k.appendChild(dzEl("div", "t2-mess-label", label));
    if (sub) k.appendChild(dzEl("div", "t2-mini", sub));
    kach.appendChild(k);
  };
  const cl = a && a.claude, kw = a && a.kw;
  kachel(a && a.min ? t2HM(a.min.business || 0) : "–", "Business (Fenster)", "ohne AFK");
  kachel(cl ? t2HM(cl.aktiv_min || 0) : "–", "Claude aktiv",
    cl ? (cl.prompts_h != null ? String(cl.prompts_h).replace(".", ",") + " Prompts/h" : "") + (cl.laengster_block_min ? " · Block max " + t2HM(cl.laengster_block_min) : "") : "");
  kachel(kw && kw.pro_h != null ? String(kw.pro_h).replace(".", ",") : "–", "Kontextwechsel/h", kw && kw.block_min ? "im Block (" + t2HM(kw.block_min) + " h)" : "im Business-Block");
  const auf = t2Aufstehen(datum), erster = t2ErsterStart(datum);
  let bisTimer = "–", sub = "Aufstehen → Timer-Start";
  if (auf.zeit && erster !== null) bisTimer = Math.max(0, Math.round((erster - t2ZeitImTag(datum, auf.zeit)) / 60000)) + " min";
  else if (auf.zeit && datum === t2.heute){ bisTimer = "läuft"; sub = "seit Aufstehen " + t2HM((t2Jetzt() - t2ZeitImTag(datum, auf.zeit)) / 60000) + " h ohne Timer"; }
  kachel(bisTimer, "bis Timer-Start", sub);
  card.appendChild(kach);
  if (a && a.min){
    const rest = [["league", "League"], ["serie", "Serie"], ["youtube", "YouTube"]].filter(x => a.min[x[0]] > 0)
      .map(x => x[1] + " " + t2HM(a.min[x[0]]));
    if (rest.length) card.appendChild(dzEl("div", "t2-mini", "PC außerdem: " + rest.join(" · ")));
  }
  const stand = typeof t2.auto.standMs === "number" ? t2.auto.standMs : Date.parse(t2.auto.stand || "");
  if (!isNaN(stand)){
    const alt = t2Jetzt() - stand > T2.TRACKER_ALT_MS;
    card.appendChild(dzEl("div", "t2-mini" + (alt ? " t2-warn" : ""), "Tracker-Stand " + t2Uhr(stand) + (alt ? " — seitdem keine Daten (PC aus oder Tracker gestoppt)" : "")));
  }
  if (t2.auto.fehler) card.appendChild(dzEl("div", "t2-mini t2-warn", "Tracker meldet: " + t2.auto.fehler));
  return card;
}

function t2KarteLeiter(){
  const L = t2.daten.leiter || {}, er = L.erreicht || {}, ziele = L.ziele || [];
  const card = dzEl("div", "t2-card t2-leiter");
  t2KarteKopf(card, "Belohnungsleiter");
  const cs = t2CoachingStreak(), ws = t2WorkoutStreak();
  const stufe = (name, inhalt, erreicht) => {
    const s = dzEl("div", "t2-stufe" + (erreicht ? " t2-stufe-ok" : ""));
    s.appendChild(dzEl("div", "t2-stufe-name", (erreicht ? "✓ " : "") + name));
    s.appendChild(inhalt);
    card.appendChild(s);
  };
  const fortschritt = (x, ziel, datumErreicht, text) => {
    const box = dzEl("div", "t2-stufe-inhalt");
    const anzeige = datumErreicht ? ziel : Math.min(x, ziel);
    box.appendChild(t2Balken(anzeige / ziel, datumErreicht ? "t2-bar-gruen" : ""));
    box.appendChild(dzEl("div", "t2-mini", datumErreicht ? "erreicht am " + ciSchoen(datumErreicht) + (x ? " · Streak jetzt " + x : "")
      : anzeige + "/" + ziel + " " + text));
    return box;
  };
  const haken = (text, an, onchange) => {
    const lab = dzEl("label", "t2-haken");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = !!an; cb.onchange = () => onchange(cb.checked);
    lab.appendChild(cb);
    lab.appendChild(dzEl("span", "", text));
    return lab;
  };
  const zielSetzen = (nr, an) => t2Senden({ op:"leiter", feld:"ziel" + nr, wert:an }, d => { d.leiter.ziele[nr - 1].ok = an; });
  stufe("Coaching", fortschritt(cs, T2.COACHING_TAGE, er.coaching, "Tage in Folge ≥ 3 h"), !!er.coaching);
  const z1 = ziele[0] || { name:"Business-Ziel 1", ok:false };
  stufe("Kirei EG", haken(z1.name, z1.ok, an => zielSetzen(1, an)), !!z1.ok);
  stufe("Kirei ML", haken("Erster Euro verdient", L.kirei_ml, an => t2Senden({ op:"leiter", feld:"kirei_ml", wert:an }, d => { d.leiter.kirei_ml = an; })), !!L.kirei_ml);
  stufe("Latzug", fortschritt(ws, T2.LATZUG_TAGE, er.latzug, "Tage Workout ohne 2× Pause"), !!er.latzug);
  card.appendChild(dzEl("div", "t2-untertitel", "Business-Ziele"));
  ziele.forEach((z, i) => {
    const row = dzEl("div", "t2-ziel" + (z.ok ? " t2-ziel-ok" : ""));
    row.appendChild(haken((i + 1) + ". " + z.name, z.ok, an => zielSetzen(i + 1, an)));
    row.appendChild(t2Btn("✎", "dz-btn t2-step", () => {
      const name = prompt("Name für Business-Ziel " + (i + 1) + ":", z.name);
      if (name === null) return;
      t2Senden({ op:"ziel_name", nr:i + 1, name:name }, d => { d.leiter.ziele[i].name = name.trim() || ("Business-Ziel " + (i + 1)); });
    }, "Ziel umbenennen"));
    card.appendChild(row);
  });
  return card;
}

/* Sonntag: Wochen-Review — Woche als Tabelle (Stunden, Workouts, Games, Folgen, Videos) + Ziel naechste Woche */
function t2ReviewSeite(){
  const montag = t2Montag(t2.heute), w = t2WocheStat(montag), wo = t2Woche(montag);
  const naechster = ciShift(montag, 7), woN = t2Woche(naechster);
  const box = dzEl("div", "t2-card t2-review");
  const kopf = t2KarteKopf(box, "Wochen-Review · KW " + t2KW(montag) + " (" + t2Kurz(montag) + "–" + t2Kurz(w.sonntag) + ")");
  kopf.appendChild(t2Btn("Zurück", "dz-btn t2-btn", () => { t2.seite = "tag"; t2Render(); }));
  const tab = dzEl("table", "t2-tabelle");
  const kz = dzEl("tr", "");
  ["Tag", "Business", "Workout", "Games", "Folgen", "Videos"].forEach(h => kz.appendChild(dzEl("th", "", h)));
  tab.appendChild(kz);
  const sum = { h:0, wo:0, games:0, folgen:0, videos:0 };
  w.tage.forEach(t => {
    const tr = dzEl("tr", t.zukunft ? "t2-zukunft" : "");
    const wk = t2Tag(t.datum).workout;
    const g = t2Deckel(t.datum, "games").genutzt, f = t2Deckel(t.datum, "folgen").genutzt, vi = t2Deckel(t.datum, "videos").genutzt;
    if (!t.zukunft){ sum.h += t.min; sum.wo += wk ? 1 : 0; sum.games += g; sum.folgen += f; sum.videos += vi; }
    [ciSchoen(t.datum), t.zukunft ? "" : t2HM(t.min), wk ? "Tag " + wk.typ : (t.zukunft || t.vorStart ? "" : "–"),
     t.zukunft ? "" : String(g), t.zukunft ? "" : String(f), t.zukunft ? "" : String(vi)].forEach((x, i) => {
      const td = dzEl("td", i === 1 && !t.zukunft ? (t.min >= T2.ZIEL_MIN ? "t2-gruen" : (t.min < T2.MIN_MIN && !t.vorStart ? "t2-rot" : "")) : "", x);
      tr.appendChild(td);
    });
    tab.appendChild(tr);
  });
  const tf = dzEl("tr", "t2-summe-tr");
  ["Summe", t2HM(sum.h) + " / 21:00", sum.wo + " ×", String(sum.games), String(sum.folgen), String(sum.videos)].forEach(x => tf.appendChild(dzEl("td", "", x)));
  tab.appendChild(tf);
  box.appendChild(tab);
  const fakten = dzEl("div", "t2-review-fakten");
  fakten.appendChild(dzEl("div", "", "Social-Treffen: " + (wo.social ? ciSchoen(wo.social) : "keins eingetragen")));
  const cs = t2CoachingStreak(), ws = t2WorkoutStreak();
  fakten.appendChild(dzEl("div", "", "Streaks: " + cs + (cs === 1 ? " Tag" : " Tage") + " in Folge ≥ 3 h · " + ws + (ws === 1 ? " Tag" : " Tage") + " Workout ohne 2× Pause"));
  if (wo.ziel) fakten.appendChild(dzEl("div", "", "Ziel dieser Woche war: " + wo.ziel));
  box.appendChild(fakten);
  box.appendChild(dzEl("div", "t2-untertitel", "Ziel nächste Woche (KW " + t2KW(naechster) + ") — ein Satz"));
  const zeile = dzEl("div", "t2-panel-zeile");
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "t2-input t2-input-breit"; inp.maxLength = 240;
  inp.placeholder = "z. B. Jeden Tag 3 h Business vor dem ersten Game";
  inp.value = t2.reviewText !== null ? t2.reviewText : (woN.ziel || "");
  inp.oninput = () => { t2.reviewText = inp.value; };
  zeile.appendChild(inp);
  zeile.appendChild(t2Btn("Speichern", "primary t2-btn", () => {
    const text = inp.value.trim();
    if (!text){ alert("Ein Satz für nächste Woche."); return; }
    t2.reviewText = null;
    t2Senden({ op:"woche", montag:naechster, feld:"ziel", wert:text }, d => { (d.wochen[naechster] = d.wochen[naechster] || {}).ziel = text; });
    t2Senden({ op:"woche", montag:montag, feld:"review", wert:true }, d => { (d.wochen[montag] = d.wochen[montag] || {}).review_um = new Date(t2Jetzt()).toISOString(); });
  }));
  box.appendChild(zeile);
  if (wo.review_um) box.appendChild(dzEl("div", "t2-mini t2-gruen", "Review gespeichert um " + t2Uhr(Date.parse(wo.review_um)) + " Uhr" +
    (woN.ziel ? " · ab Montag steht oben: „" + woN.ziel + "“" : "")));
  return box;
}

// Termine + Aufgaben aus der klassischen Ansicht (ci.js: tbLadeAgenda_/tbAgenda) als aufklappbare Kachel
function t2AgendaLade(){
  const huelle = dzEl("div", "t2-agenda-huelle");
  const box = dzEl("div", "tb-card tb-kal t2-agenda");
  const ag = (typeof tb !== "undefined" && tb.agenda) || null;          // tb ist ein const in ci.js, kein window-Feld
  if (ag && ag.ok && window.tbAgenda) tbAgenda(box, ag);
  else if (ag && !ag.ok) box.appendChild(dzEl("div", "t2-mini t2-warn", "Kalender nicht ladbar: " + (ag.error || "")));
  else box.appendChild(dzEl("div", "dz-loading t2-mini", "Lade Kalender und Aufgaben …"));
  huelle.appendChild(box);
  return huelle;
}
