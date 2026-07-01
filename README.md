# QC-Review-App

Sichere Web-Oberfläche für die Content-Quality-Control des Wünsche-Marketing-Systems
(`full-ai-marketing-build` → `process/qc-system-spec.md`, Abschnitt „QC-Review-App").

**V2 (W2-Härtung + Typ-Tabs, 2026-07-02):** serverseitige Rechte-Prüfung (Item-Zuweisung, Modus-Rollen-Gate),
LockService gegen Races, Login-Rate-Limit + iteriertes Passwort-Hashing (Salt + Server-Pepper, Auto-Upgrade),
30%-Begründungs-Quote serverseitig, Screening ohne Login-Token (Test-Ref gegen `sheet-63` validiert, inkl.
NSFW-Consent-Zeitstempel), Typ-Tabs (Board je Content-Typ inkl. **Skript**), Skript-Items als Text,
XSS-sichere DOM-Erzeugung, Tastatur-Bedienung (A/R, 1–5, Enter), Notfall-Token-Revoke (`bumpTokenVersion()`).
Setup jetzt: `setup('EinmalAdminPasswort')` — kein Passwort mehr im Code.

**Ein Tool, drei Modi:**
- **Review** (Tier-0 Sandro / Tier-1 VAs) — Live-Queue `sheet-60-qc-queue` prüfen.
- **Spot-Check** (Sandro / Lead-VA, Meta-QC) — Stichprobe der VA-Entscheidungen re-reviewen (`sop-09-06`).
- **Screening** (Bewerber) — Golden-Set-Test (`sheet-64-qc-golden-set`), Auto-Scoring → `sheet-63` (`sop-09-07`).

> **Reviewer-Entscheidung = nur `approve` / `reject` (OK / nicht-OK) + Grund.** Der Mensch entscheidet
> **nicht**, ob etwas überarbeitet oder neu erstellt wird — das macht die Prozess-Orchestrierung
> `sop-09-05-content-qc-orchestration` (z. B. Revision vs. Neu-Generierung, anhand Grund + Iterations-Zahl).
> Die App schreibt darum nur `QC-Status = approved/rejected`, kein `Final-Decision`/`revision`.

## Architektur (kein Supabase)

```
Front-end (diese SPA)                 Backend (Google Apps Script Web App)        Daten
─────────────────────                 ────────────────────────────────────        ─────
index.html / app.js / style.css  ──►  Code.gs  (JSON-API: login/next/submit)  ──►  Google Sheets
GitHub Pages (statisch)               + qc-users-Tab (salted Passwort-Hash)        sheet-60 (Queue)
                                      + Session-Token (HMAC, kurzlebig)           sheet-64 (Golden-Set)
                                      + Bild-URLs aus Google Drive                sheet-63 (Recruiting)
```

- **Front-end:** statische SPA (Vanilla JS, kein Build-Schritt) — deploybar auf GitHub Pages wie `intents-crew`.
- **Backend:** eine Google-Apps-Script-Web-App als JSON-API. Liest/schreibt die Sheets, serviert Drive-Bild-URLs.
- **Login mit eigenen Zugangsdaten:** `qc-users`-Tab (Username + Salt + SHA-256-Hash + Rolle + VA-ID). Nicht an Google-Konten gebunden — du gibst die Logins aus.
- **Kein Supabase, keine externe DB.** Die Entscheidungen landen direkt in `sheet-60`, sodass `sop-09-05/06/08` unverändert weiterlaufen.

> **Sicherheits-Trade-off (bewusst, `qc-system-spec.md` D21):** selbstgebaute Auth (Apps Script) ist weniger gehärtet als ein dedizierter Auth-Provider. Für ein internes QC-Tool mit ausgegebenen Logins vertretbar (HTTPS via GitHub Pages + Apps Script, salted Passwort-Hash, signiertes kurzlebiges Token). Später auf einen gehärteten Provider hebbar, ohne das Front-end zu ändern.

## Sofort ansehen (Demo-Modus)

`app.js` startet mit `CONFIG.DEMO_MODE = true` → läuft **komplett ohne Backend** mit Mock-Daten. `index.html` im Browser öffnen, einsteigen:

| Login | Passwort | Rolle |
|---|---|---|
| `sandro` | `demo` | admin (Review + Spot-Check) |
| `va-007` | `demo` | va (Review) |
| *(Screening)* | — | `index.html?mode=screening` öffnen (kein Login) |

Live durchklickbar: **2-Button-Entscheidung (Approve / Reject)**, Pflicht-Begründung bei Reject, laufende **30 %-Begründungs-Quote**, Creator-Approved-Referenz-Galerie (wechselt je Creator), Tages-Stats.

## Deploy (live, gegen die echten Sheets)

> Voraussetzung: die QC-Sheets (`sheet-60`/`63`/`64` …) sind als Live-Google-Sheets angelegt (via `sheets-sync`), und du hast ihre Spreadsheet-IDs.

**1 — Backend (Apps Script):**
1. [script.google.com](https://script.google.com) → neues Projekt → Inhalt von `backend/Code.gs` einfügen; `backend/appsscript.json` als Manifest (Projekt-Einstellungen → „appsscript.json im Editor anzeigen").
2. `CONFIG`-Block oben füllen: Spreadsheet-IDs (`QUEUE_SSID` = sheet-60, `GOLDEN_SSID` = sheet-64, `RECRUIT_SSID` = sheet-63) + Tab-Namen + `DRIVE_FOLDER_ID`.
3. Einmal **`setup()`** ausführen (legt `qc-users` an, erzeugt das Token-Secret, legt Admin `sandro` an — Passwort in `setup()` setzen, danach ändern). Berechtigungen (Sheets + Drive) zulassen.
4. **Deploy → Neue Bereitstellung → Web-App** · „Ausführen als: Ich" · „Zugriff: Jeder". Die `/exec`-URL kopieren.

**2 — Front-end (GitHub Pages):**
1. Repo pushen, GitHub Pages auf den Branch zeigen.
2. In `app.js` `BACKEND_URL = '<die /exec-URL>'` setzen, `DEMO_MODE = false`.

**3 — VAs anlegen:** im Apps-Script-Editor `createUser('va-008','StartPasswort','va','va-008','Maria')` (pro VA). Übergabe der Zugangsdaten an den VA via `sop-09-07` (Onboarding-Mail).

## API-Vertrag (Front-end ↔ Backend)

Alle Calls: `POST <BACKEND_URL>` mit JSON-Body, Antwort `{ ok: bool, ... }`.

| action | Body | Antwort |
|---|---|---|
| `login` | `{action, username, password}` | `{ok, token, role, name, vaId}` |
| `next` | `{action, token, mode}` | `{ok, item, reference, stats}` · `item:null` = Queue leer |
| `submit` | `{action, token, mode, itemId, decision, rating, begruendung}` | `{ok, stats}` |

- `mode`: `review` \| `spotcheck` \| `screening`. `decision`: **`approve` \| `reject`** (keine `revision`-Option für den Reviewer).
- `item`: `{itemId, contentTyp, sourceSop, creatorId, creatorName, assetUrl, vaDecision?}` (`vaDecision` nur im Spot-Check).
- `reference`: `[{url, label}]` — Approved-/Persona-Referenz des Creators.
- `stats`: `{done, agreementPct, describedToday, neededToday, earningsToday}`.
- **Schreib-Mapping:** Review → `VA-Decision` (approve/reject) + `VA-Rating`/`VA-Begruendung`/`Reviewed-At` + `QC-Status` (approved/rejected) in `sheet-60`; **`Final-Decision` + Revision-Entscheidung gehören `sop-09-05`** (nicht der App). Spot-Check → `Sandro-Spot-Check`/`Sandro-Begruendung`. Screening → Score gegen `sheet-64:Ground-Truth-Decision` → `sheet-63`.
- **Regeln (Front-end erzwungen + Backend gegengeprüft):** Begründung Pflicht bei `reject` (bzw. bei Spot-Check-Abweichung); laufende Mindest-Quote `qc-begruendung-quote-prozent` (Default 30 %) über alle Entscheidungen.

## Dateien

```
qc-review/
├─ index.html        # App-Shell (Login + Review-Workspace)
├─ style.css         # Styling
├─ app.js            # Front-end-Logik (Demo + echte API), 3 Modi, Regeln
├─ README.md         # diese Datei
└─ backend/
   ├─ Code.gs        # Apps-Script-JSON-API (login/next/submit + Auth + Sheet-I/O)
   └─ appsscript.json# Apps-Script-Manifest
```
