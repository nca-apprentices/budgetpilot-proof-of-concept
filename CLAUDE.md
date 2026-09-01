# BudgetPilot — Proof of Concept (Projektkontext)

> Diese Datei fasst den aktuellen Stand und alle bereits getroffenen Entscheidungen zusammen.
> Gedacht als Kontext für Claude Code (z. B. als `CLAUDE.md` im Projekt-Root) und als Referenz für den POC-Bericht.

## Status (aktueller Stand)

- ✅ Projekt-Setup: React Native 0.87 (TypeScript), erstellt in IntelliJ
- ✅ GitHub-Repo verbunden: `github.com/nca-apprentices/budgetpilot-proof-of-concept` (privat)
- ✅ **Grösstes technisches Risiko widerlegt:** Gemma 3 1B-IT läuft nachweislich on-device im iOS-Simulator (`react-native-litert-lm`), liefert korrekte, verständliche Antworten, funktioniert offline
- ✅ Bekannter Bug gefunden & gelöst (siehe "Lessons Learned" unten)
- ✅ "Ausgabe erfassen" + "Budget" + "Kalender" + "LLM-Test" Screens implementiert (App.tsx): Freitext ODER Beleg-Foto → Gemma-4-E2B-it-Extraktion → Entwurf zum Bestätigen, bewusst ohne Persistenz
- ✅ Baseline Budget Engine implementiert (`budget.ts` Datenmodell, `budgetEngine.ts` reine `computeBudget`-Funktion, Budget-Tab in App.tsx mit Einkommen-Eingabe, Fixkosten-/geplante-Käufe-Liste, Restbudget + Warnungen)
- ✅ PDF-Export implementiert und im Simulator verifiziert: "Freundlich"-Layout (`pdfExport.ts`, reines `pdf-lib`, kein natives PDF-Modul) mit farbigen Kategorie-Chips + Datums-Pillen pro Posten, abgerundeten Posten-Karten, Zwischen-/Gesamtsumme, Restbudget-Fortschrittsbalken, Warnungs-Banner und einer KI-Zusammenfassungs-Box ("KI · BITTE PRÜFEN"), Speichern via `react-native-fs` + Teilen über den eingebauten `Share`-Dialog. Custom-Font-Embedding (Fraunces/Karla) ist am Hermes-Runtime gescheitert, läuft daher mit Standard-Fonts (Times-Italic für die grossen Zahlen, Helvetica/HelveticaBold sonst) — siehe Lessons Learned. `LineItem` um ein manuell editierbares Kaufdatum ergänzt (Textfeld "TT.MM.JJJJ" im Entwurf-Screen, kein nativer Datums-Picker).
- ✅ **Wichtiger Bugfix, wirkt sich auf die ganze App aus:** `model.reset()` wird jetzt vor jedem unabhängigen `generate()`-Aufruf aufgerufen (LLM-Test, Freitext-Extraktion, PDF-Zusammenfassung) — vorher hing jeder Aufruf an derselben, endlos wachsenden Modell-Konversation, was zu Kontext-Verschmutzung zwischen völlig unabhängigen Anfragen führte (siehe Lessons Learned)
- ✅ Kalender-Tab implementiert und im Simulator verifiziert (`react-native-calendars`, reines JS, kein natives Modul): Monatsansicht mit Punkt-Markierung an Tagen mit bereits erfassten Posten. Antippen eines Tages wechselt zu "Ausgabe erfassen" und füllt das Kaufdatum im Entwurf-Screen mit dem angetippten Datum vor (statt heutigem Datum) — nutzt das Kaufdatum-Feld aus dem PDF-Export-Feature weiter.
- ✅ Projekt-Quelldateien nach `src/` umstrukturiert (App.tsx, budget.ts, budgetEngine.ts, pdfExport.ts, `__tests__/`); Config-Dateien bleiben im Root
- ✅ Umstieg auf Gemma 4 E2B-it (multimodal, ersetzt Gemma 3 1B-IT komplett) vollständig umgesetzt UND im Simulator verifiziert: Download (~2.6 GB, automatisch über `ModelRegistry`), Kamera-/Galerie-Erfassung (`react-native-image-picker`, Auswahl "Jetzt aufnehmen"/"Hochladen")
- ✅ Foto-Extraktion auf OCR-first umgestellt (`ios/budgetpilot/ReceiptOCR.swift`, natives Modul um Apples Vision-Framework/`VNRecognizeTextRequest`): statt den Beleg als Bild direkt an Gemma 4 E2B-it zu geben, liest Vision zuerst den Rohtext aus, der dann über denselben bewährten Freitext-Extraktionspfad läuft. **Deutlich besser, aber noch nicht zuverlässig** (siehe Lessons Learned #14): bei einspaltigen Beträgen präzise und mit plausibler, konfidenter Kategorie; bei mehrspaltigen Tabellen-Belegen weiterhin falsche, teils unbegründet selbstsichere Beträge. Nur iOS — Android-Äquivalent (z. B. ML Kit) noch offen.
- ⏳ Offen: lokale Datenbank, Preislogik (toppreise.ch), Golden Set, Tests auf echten Geräten (aktuell nur Simulator), iOS Extended-Virtual-Addressing-Entitlement (braucht kostenpflichtigen Apple-Developer-Account, noch nicht eingerichtet), Genauigkeit der Foto-Extraktion verbessern/weiter untersuchen

## Feststehende Tech-Entscheidungen

Diese Punkte waren im ursprünglichen Plan noch offen ("je nach Team-Know-how" etc.) — sind aber jetzt entschieden und sollten nicht mehr zur Diskussion stehen:

| Punkt | Entscheidung |
|---|---|
| Programmiersprache / Framework | React Native + TypeScript (nicht Flutter) |
| On-Device-LLM | Gemma 4 E2B-it (multimodal: Text + Vision + Audio) — **ersetzt Gemma 3 1B-IT vollständig** (ein Modell für alle Tabs, statt zwei parallel geladene Modelle; Begründung: einfachere Architektur, in Kauf genommener Trade-off ist der größere Download/RAM-Bedarf auch für die reinen Text-Flows) |
| Modell-Quelle | `litert-community/gemma-4-E2B-it-litert-lm` auf Hugging Face, Datei **`gemma-4-E2B-it.litertlm`** — **verifiziert per HuggingFace-API** (nicht geraten): exakt 2'588'147'712 Bytes (≈ 2.59 GB), Repo-Metadaten bestätigen `gated: false` (kein Login/Lizenz-Klick nötig, anders als beim alten Gemma-3-1B-IT-Repo). `react-native-litert-lm` exportiert die passende URL fertig als Konstante `GEMMA_4_E2B_IT`. Das Repo enthält zusätzlich Hardware-spezifische Varianten (Tensor G5, Intel LNL/PTL, Qualcomm) und eine Web/WASM-Variante (`-web.litertlm`/`.task`) — keine davon relevant für iPhone 12/Galaxy S21 FE, die generische `gemma-4-E2B-it.litertlm` ist richtig. |
| LLM-Runtime/Bibliothek | `react-native-litert-lm@0.6.1` (LiteRT-LM-Engine 0.15.0) + `react-native-nitro-modules` (nicht llama.cpp/MediaPipe direkt). Explizit geprüft: Version unterstützt Gemma 4 nativ (Paketbeschreibung: "Optimized for Gemma 4"), kein Update nötig. |
| Kamera-/Beleg-Erfassung | `react-native-image-picker` (`launchCamera()`/`launchImageLibrary()`) — bewusst statt `react-native-vision-camera`, da nur ein Einzelfoto benötigt wird, kein Live-Preview/Frame-Processing. Installiert und via `pod install` gelinkt, im Simulator verifiziert. |
| Beleg-Texterkennung (OCR) | Eigenes natives Modul `ReceiptOCR` (`ios/budgetpilot/ReceiptOCR.swift` + `.m`-Bridge ohne Bridging-Header, per `xcodeproj`-Gem ins Xcode-Projekt eingebunden) um Apples `Vision`/`VNRecognizeTextRequest` — ersetzt die direkte Bild-Übergabe an Gemma 4 E2B-it (`sendMultimodalMessage`) für den Foto-Pfad. Begründung: kleine Multimodal-Modelle sind bei feinem Beleg-Druck unzuverlässig, dediziertes On-Device-OCR liest zuverlässiger, danach läuft derselbe Text-Extraktionspfad wie bei Freitext. Nur iOS umgesetzt, Android (z. B. ML Kit Text Recognition) noch offen. |
| Zielplattformen | Beide von Anfang an — iPhone 12 (iOS 15.1+) und Samsung Galaxy S21 FE |
| Wichtige Einschränkung | iOS-Simulator-Test nur auf Apple-Silicon-Mac (arm64) möglich — bei uns gegeben |
| Backend für Inferenz | `cpu` (GPU/Metal im Simulator unzuverlässig, ggf. später auf echtem Gerät testen) |
| Datenhaltung | Lokal, SQLite (konkretes RN-Paket noch offen: `expo-sqlite` oder `react-native-sqlite-storage`) |
| PDF-Erstellung | `pdf-lib` (reines JS, kein natives Modul/pod install nötig, manuelles Text-/Formen-Layout via `drawText`/`drawSvgPath`) statt `react-native-html-to-pdf` (nativ, seit längerem nicht mehr aktiv gepflegt) — bewusst risikoärmer nach den nativen Stolpersteinen bei anderen Libraries. Layout "Freundlich" (von 4 Optionen ausgewählt, nach Feedback angepasst: Einkommen statt Restbudget oben). Fonts: Standard-Fonts (kein Custom-Embedding, siehe Lessons Learned). Datei-Speicherung via `react-native-fs`, Teilen via eingebauten `Share` aus `react-native` (keine weitere native Dependency nötig). |
| Netzwerkzugriff (toppreise.ch) | `fetch` (eingebaut) oder `axios` |

## Ziel des POC

Nachweisen, dass BudgetPilot als On-Device-App (offline möglich) zuverlässig:

- Budget/Einkommen + Wunschliste erfassen kann (auch als Freitext)
- Budgetposten & Ausgaben automatisch extrahiert und kategorisiert (Gemma 4 E2B-it on device, Text + Beleg-Foto)
- Produktpreise manuell oder via toppreise.ch bezieht
- Restbudget nach geplanten Käufen korrekt berechnet
- eine verständliche Ausgaben-Zusammenfassung generiert und als PDF exportiert
- sensible Daten lokal verarbeitet (Privacy-by-Design)

## POC-Umfang (MVP-Schnitt)

### In Scope

1. **Dateneingabe**
   - Monatliches Einkommen/Budget (z. B. "Ich habe 4500 CHF Einkommen, Fixkosten 1200 CHF Miete…")
   - Wunschliste geplante Käufe (Freitext + strukturierte Eingabe)
2. **On-Device KI (Gemma 4 E2B-it)**
   - Extraktion: Betrag, Intervall (monatlich/einmalig), Händler/Produkt, Kategorie, Notizen
   - Kategorisierung in vordefinierte Kategorien (Wohnen, Lebensmittel, Mobilität, Freizeit, Gesundheit, Abos, Sonstiges)
   - Erklärbarkeit: kurze "Warum"-Begründung pro Zuordnung (1 Satz)
3. **Preislogik**
   - Manuell: Preis direkt eingeben
   - toppreise.ch: Suche/Lookup (vereinfachte Schnittstelle) + Auswahl eines Preises
   - Caching der zuletzt gefundenen Preise (offline-freundlich)
4. **Budgetberechnung**
   - Summe Fixkosten + geplante Käufe
   - Restbudget (absolut + Prozent)
   - Warnungen bei Überschreitung
5. **Zusammenfassung & Export**
   - KI-Textzusammenfassung — vereinfacht auf einen einzelnen Fliesstext-Absatz (kein Kurz-/Detail-Split, kein JSON mehr nötig, siehe Lessons Learned). Zahlen werden dem Modell als feststehende Fakten vorgegeben, um Rechenfehler zu vermeiden — verhindert aber nicht, dass die KI beim Umformulieren trotzdem falsche Zahlen einstreut (bestätigt, siehe Lessons Learned) — deshalb "KI · BITTE PRÜFEN"-Kennzeichnung im PDF
   - PDF-Export (1–2 Seiten) — implementiert (`pdfExport.ts`), "Freundlich"-Layout: Einkommen/Restbudget als grosse Zahlen, farbige Kategorie-Chips + Datums-Pillen pro Posten, Zwischen- und Gesamtsumme, Fortschrittsbalken, Warnungs-Banner, KI-Zusammenfassungs-Box. Verifiziert im Simulator, automatischer Seitenumbruch vorhanden aber noch nicht mit genug Posten getestet.
6. **Offline-Nachweis**
   - App bleibt funktionsfähig ohne Netzwerk (ausser toppreise.ch-Preisabruf) — **Grundprinzip bereits einzeln bestätigt** (KI-Antwort lief lokal ohne Server)
7. **Kamera-/Beleg-Erfassung** — implementiert
   - Kassenzettel/Belege per Kamera fotografieren oder aus der Galerie hochladen (`react-native-image-picker`, Auswahl-Dialog "Jetzt aufnehmen"/"Hochladen"), Gemma 4 E2B-it extrahiert über `sendMultimodalMessage()` dieselben Felder wie beim Freitext-Pfad (gleiches JSON-Schema, gleiche `buildDraftFromRaw()`-Normalisierung, gleicher DraftScreen)
   - Entwurf-Screen zeigt das hochgeladene Foto zur Kontrolle direkt über den Feldern an
   - Technisch im Simulator verifiziert, inhaltliche Genauigkeit bei echten Belegen aber noch ungenügend, siehe Status/Risiken
8. **Kalender-Ansicht** (neu, per Feedback) — implementiert
   - Monatskalender (`react-native-calendars`) mit Punkt-Markierung an Tagen mit bereits erfassten Posten
   - Antippen eines Tages öffnet "Ausgabe erfassen" mit vorausgefülltem Kaufdatum

### Out of Scope (für POC)

- Bankkonto-Integration / automatische Transaktionsimporte
- Multi-Monats-Reporting, Forecasting, komplexe Sparziele
- Mehrbenutzer, Cloud-Sync, Login
- Vollständige Internationalisierung / Steuerthemen

## Erfolgskriterien (Definition of Done)

**Funktional**

- Freitext-Parsing: ≥ 85 % der Testinputs werden korrekt in strukturierte Posten überführt (Betrag + Kategorie)
- Kategorisierung: ≥ 80 % Trefferquote auf einem kuratierten Testset (mind. 50 Beispiele)
- Restbudget-Berechnung stimmt zu 100 % (deterministisch testbar)
- PDF exportiert ohne Layoutfehler — **im Simulator bereits nachgewiesen** (mehrseitiger Umbruch über `PdfWriter` in `pdfExport.ts` ist vorbereitet, aber noch nicht mit genug Posten getestet, um einen echten Seitenumbruch auszulösen)
- **Foto-Extraktion (Stichprobe, nicht repräsentativ):** mit direkter Bild-Übergabe ans LLM 0/2 echte Kassenzettel korrekt extrahiert. Nach Umstellung auf Vision-OCR-first (siehe Lessons Learned #14) verbessert, aber weiterhin nicht zuverlässig: 1/2 mit plausiblem Betrag und konfidenter, korrekter Kategorie, 1/2 mit falschem Betrag ohne Low-Confidence-Warnung (mehrspaltiger Tabellen-Beleg). Deutet weiterhin darauf hin, dass die 85%/80%-Ziele oben für den Foto-Pfad aktuell nicht erreichbar sind. Vor einer belastbaren Aussage braucht es ein größeres Testset echter Belege (Golden Set).

**Privacy/Offline**

- Alle KI-Inferenz läuft lokal; kein Versand von Finanztexten an Server — **im Simulator bereits nachgewiesen**
- Offline-Demo: Kernfunktionen funktionieren im Flugmodus (ohne Preisabruf)

**UX**

- Neuer User kann in ≤ 3 Minuten ein erstes Budget + 3 Wunschlisteneinträge erfassen
- Korrekturen sind möglich (User kann Kategorie/Betrag manuell überschreiben)

## Architektur (high level)

1. UI Eingabe → 2. Normalisierung/Preprocessing → 3. On-Device LLM (JSON-Output)
2. Validierung & Post-Processing (Beträge, Intervalle, Kategorien) → 5. Persistenz lokal
3. Budget Engine → 7. Summary Generator (LLM, templated prompts) → 8. PDF-Export

## Datenmodell (POC)

- **BudgetMonth**: `income`, `items[]` — bewusst **eine** Liste statt getrennter `fixedCosts[]`/`plannedPurchases[]`; welcher Posten Fixkosten vs. geplanter Kauf ist, wird aus `item.cadence` abgeleitet (`monthly` → Fixkosten, `one_time` → geplanter Kauf), nicht separat gepflegt. Ggf. später explizite Trennung nötig, falls ein Posten mal beides sein soll (z. B. ein teilweise wiederkehrender Kauf) — aktuell nicht abbildbar.
- **LineItem** (`budget.ts`): `id`, `description`, `amount`, `currency`, `cadence` (monthly/one_time), `category`, `source` (free_text/photo/manual/toppreise — `free_text` und `photo` aktuell angebunden, `manual`/`toppreise` noch nicht), `confidence`, `notes`, `date` (ISO `YYYY-MM-DD`, Kaufdatum — vom Nutzer im Entwurf-Screen als Freitextfeld "TT.MM.JJJJ" editierbar, vorausgefüllt mit dem heutigen Datum bzw. dem im Kalender-Tab angetippten Datum; kein Datums-Picker, um keine weitere native Dependency einzuführen; wird nicht vom Modell extrahiert)
- **PriceResult**: `query`, `productName`, `price`, `shop`, `url`, `timestamp` (noch nicht implementiert)

`computeBudget(income, items)` (`budgetEngine.ts`) ist eine reine Funktion ohne React-Abhängigkeiten (keine Hooks, kein State, kein I/O) und liefert `totalFixedCosts`, `totalPlannedPurchases`, `totalSpent`, `restbudget`, `restbudgetPercent` und `warnings[]`. Getestet in `__tests__/budgetEngine.test.ts` (7 Fälle, u. a. Normalfall, Überschreitung, knappes Restbudget, `income === null`, leere Liste, Items mit `amount === null`, `income <= 0`).

## KI-Teil: Prompts & Output-Format

Ziel: Immer strukturiertes JSON ausgeben, das nachträglich validiert werden kann.

```json
{
  "items": [
    {
      "description": "Miete",
      "amount": 1200,
      "currency": "CHF",
      "cadence": "monthly",
      "category": "Wohnen",
      "confidence": 0.92,
      "reason": "Miete ist typischerweise eine Wohnkostenposition."
    }
  ]
}
```

**Fallback-Regeln**

- Wenn Betrag fehlt → Rückfrage/Markierung "needs_input"
- Wenn Kategorie unsicher → Top-2 Kategorien + confidence anzeigen

> Aktueller Stand: In App.tsx (`buildExtractionPrompt`) läuft bereits eine vereinfachte Variante produktiv — Modell antwortet mit einem einzelnen JSON-Objekt (kein `items`-Array), `category: "needs_input"` als Sentinel statt separatem `needs_input`-Array. Funktioniert im Simulator. Der ursprünglich entworfene, ausführlichere Extraktions-Prompt mit `items`-Array, `needs_input`- und `category_alternatives`-Arrays liegt separat in `entwurf-extraktion-prompt.md` — als Referenz für eine mögliche spätere Erweiterung (z. B. mehrere Posten pro Text, differenziertere Low-Confidence-Behandlung), aktuell aber nicht das, was im Code läuft.

## Testplan (POC)

1. **Golden Set** (noch anzulegen):
   - 30 Freitext-Budgets (Deutsch) mit Fixkosten/Variablen
   - 20 Wunschlistentexte (Produkt + Preis/ohne Preis)
2. **Automatisierte Tests**
   - Parser/Validator Unit Tests
   - Budget Engine deterministic tests
3. **Manuelle UX-Tests**
   - 5 Testpersonen, 30 Minuten Session, Beobachtung + Feedback

## Risiken & Mitigation

- LLM halluziniert Beträge/Kategorien → JSON-Schema-Validierung + harte Regeln, Low-Confidence-Flag, manuelle Overrides
- Performance/Memory → Quantisierung, Prompt kürzen, Batching vermeiden, Lazy Loading
- Offline-Preisabruf → Mock + Cache; klare UI "Preisabruf benötigt Internet"
- Datenschutz → keine Telemetrie mit Finanztext; optional nur anonyme Event-Zähler
- **Neu (aus Praxis):** Bibliotheken können anhand von Dateinamen/Heuristiken falsche Annahmen treffen (siehe Lessons Learned) → Konfiguration immer explizit setzen, nicht auf Auto-Erkennung verlassen
- **Neu:** Gemma 4 E2B-it braucht laut Library-Doku min. 4 GB RAM — das iPhone 12 hat insgesamt nur 4 GB → echtes OOM/Jetsam-Risiko auf diesem Zielgerät. **Bereits im Mac-Simulator real aufgetreten** (siehe Lessons Learned #5) — auf dem Zielgerät mit fixem 4-GB-Limit (kein Freiräumen wie am Mac möglich) vermutlich noch kritischer. Mitigation: vor Geräte-Testing Xcode-Instruments-Messung, ggf. `maxContextTokens` reduzieren oder auf das kleinere Gemma 3 1B-IT zurückfallen, falls sich das Risiko bestätigt.
- **Neu, bestätigt (Foto-Extraktion halluziniert):** Bei 2 von 2 getesteten *echten* fotografierten Kassenzetteln (Coop Restaurant, CHF 9.95 und CHF 37.10) hat Gemma 4 E2B-it bei direkter Bild-Übergabe den Betrag und die Beschreibung komplett falsch extrahiert (u. a. "Kauf von einem Kaktus" für einen Kaffee/Saft-Beleg) — einmal davon mit fälschlich hoher Confidence (95%), was das Confidence-basierte Sicherheitsnetz aushebelt. Die technische Bildübertragung ist nachweislich korrekt (Byte-Länge geprüft, reales JPEG kommt an), es handelt sich also um eine echte Modell-Grenze bei der Fein-Text-/OCR-Lesung aus Fotos, nicht um einen Integrationsbug. **Mitigation umgesetzt (siehe Lessons Learned #14):** Vision-Framework-OCR liest den Beleg-Text jetzt vor, das LLM bekommt nur noch Text statt Bild — verbessert die Ergebnisse spürbar, löst das Problem aber nicht vollständig: bei mehrspaltigen Tabellen-Belegen bleibt das Risiko einer falschen, unbegründet selbstsicheren Zahl bestehen (kein Low-Confidence-Flag beim CHF-37.10-Beleg trotz falschem Betrag). Weiterhin offen: mehr echte Belege für ein belastbares Bild ansammeln, Prompt stärker auf die "TOTAL"-Zeile fokussieren, Confidence-Wert beim Foto-Pfad nicht blind vertrauen.

## Lessons Learned (bisher)

1. **npm Script-Genehmigung:** Neuere npm-Versionen blockieren automatisch ausgeführte "postinstall"-Skripte von Paketen (Sicherheitsfeature). Lösung: Skript-Quellcode vor Freigabe geprüft (lädt nur offizielles, signiertes iOS-Framework von GitHub Releases), dann gezielt freigegeben.
2. **Multimodal-Bug (mit Gemma 3 1B-IT, inzwischen nicht mehr relevant):** `react-native-litert-lm` erkennt anhand des Dateinamens ("gemma3" oder "3n" im Pfad), ob ein Modell multimodal ist, und nimmt dann automatisch ein GPU-Vision-Backend an. Da unsere damalige Datei `gemma3-1b-it-int4.litertlm` hiess, das Modell aber rein textbasiert war, schlug die Engine-Initialisierung zunächst fehl ("Failed to create conversation context"). Fix: `multimodal: false` explizit übergeben.
3. **Modellname beim Umstieg auf Gemma 4 E2B-it falsch geraten, dann per API korrigiert:** Die ursprüngliche Annahme war die Datei heisse `gemma-4-E2B-it-litert-lm.litertlm` (das ist der Repo-Name, nicht der Dateiname). Per HuggingFace-API-Abfrage der echten Repo-Dateiliste verifiziert: die korrekte Datei heisst **`gemma-4-E2B-it.litertlm`** (2'588'147'712 Bytes), und `react-native-litert-lm` exportiert dafür bereits die fertige Konstante `GEMMA_4_E2B_IT`. **Lehre:** bei Modell-Dateinamen nie aus dem Repo-Namen ableiten/raten, sondern die Repo-Dateiliste (oder eine von der Library mitgelieferte Konstante) direkt prüfen. Ausserdem verifiziert: Repo ist `gated: false` (kein Login/Lizenz-Klick nötig, anders als beim alten Gemma-3-1B-IT-Repo), und die installierte `react-native-litert-lm`-Version unterstützt Gemma 4 nativ (kein Update nötig). Die Dateinamens-Heuristik für `multimodal` (sucht nur "gemma3"/"3n") betrifft `gemma-4-E2B-it.litertlm` ohnehin nicht — wir setzen `multimodal: true` trotzdem explizit, um uns nicht auf Zufall zu verlassen.
4. **Modellpfad war bisher hartcodiert** (absoluter Pfad auf dem Mac) — funktionierte nur im iOS-Simulator. Mit dem Umstieg auf Gemma 4 E2B-it **gelöst für dieses Modell**: `useModel(GEMMA_4_E2B_IT, …)` übergibt jetzt eine HTTPS-URL statt eines lokalen Pfads, die Library lädt und cached die Datei selbst über ihre `ModelRegistry` — funktioniert dadurch auch auf echten Geräten, kein manueller In-App-Download-Mechanismus mehr nötig.
5. **RAM-Risiko real aufgetreten (Mac-Simulator):** Beim ersten echten Download+Load-Versuch schlug das Laden mit `MemoryError: Refusing to load model (2468 MB): Estimated usage exceeds available memory by ~275 MB` fehl — der Pre-Flight-Check der Library (dokumentiertes Sicherheitsfeature) hat das Laden aktiv verweigert, weil dem Mac zu diesem Zeitpunkt zu wenig freier Speicher zur Verfügung stand. Nach Schliessen ein paar speicherhungriger Apps (freie `vm_stat`-Pages von ~62 MB auf ~1.6 GB gestiegen) und komplettem Neustart der App (`simctl terminate` + `launch`) lud das Modell danach sofort erfolgreich. **Lehre:** dieser Fehler zeigt sich nicht als Absturz, sondern nur als leise fehlschlagender `error`-State im `useModel`-Hook — der `EntryScreen` zeigte diesen `error`-State ursprünglich gar nicht an (nur der LLM-Test-Screen tat das), der Nutzer wäre bei einem endlos ladenden Screen ratlos geblieben. Inzwischen behoben: `ExpenseFlow` zeigt `model.error` jetzt ebenfalls im Status-Text an. Für echte Geräte mit fixem RAM-Limit (kein Freiräumen möglich wie am Mac) ist das trotzdem ein ernstzunehmendes Risiko, siehe oben.
6. **JPEG-Qualität bei Foto-Erfassung von 0.7 auf 1.0 erhöht:** Als möglicher Beitrag zur Foto-Halluzinations-Problematik — niedrigere JPEG-Qualität könnte feine Beleg-Schrift durch Kompressionsartefakte zusätzlich verschlechtern. Ursprüngliche Annahme "wirkt sich nur auf `launchCamera()` aus, nicht auf `launchImageLibrary()`-Uploads bereits bestehender Dateien" war vermutlich falsch: derselbe Testbeleg (`test-quittung.jpg`, Coop Pratteln) lieferte mit `quality: 1.0` per Upload ein anderes Ergebnis (korrektes `needs_input` statt vorher falscher Betrag mit 95% Confidence) als zuvor mit `quality: 0.7` — die Library scheint auch Library-Bilder beim Export neu zu komprimieren. **Einschränkung:** nur eine Einzelbeobachtung (n=1) ohne Kontrolle der resultierenden Bytegrösse, Modell-Sampling ist ausserdem nicht vollständig deterministisch — kein belastbarer Beweis, aber ein Hinweis, dass sich eine spätere systematischere Untersuchung lohnen könnte.
7. **Fast Refresh setzt einen laufenden Modell-Download zurück:** Während des ersten ~2.6-GB-Downloads führte jede noch so kleine Code-Änderung in `App.tsx` (auch nur eine geänderte Konstante) zu einem von React Native automatisch ausgelösten vollständigen Reload, der `useModel` neu mountete und `loadModel()` erneut von einem niedrigeren Fortschritt startete (beobachtete Sprünge z. B. 26%→22%, 36%→8%). **Lehre:** während eines laufenden großen Downloads/Ladevorgangs keine Code-Änderungen vornehmen — der Download läuft sonst nie durch. Falls doch nötig, Fortschritt danach neu beobachten statt anzunehmen, dass er weiterläuft.
8. **`console.log`/`console.error` landen bei diesem Setup nicht zuverlässig im Metro-Terminal oder im `xcrun simctl log stream`:** Für Debugging der rohen Modell-Antworten musste stattdessen ein `Alert.alert(...)` direkt in der UI verwendet werden, um Werte (z. B. `imageBuffer.byteLength`, rohe JSON-Antwort) sichtbar zu machen. `console.error` erscheint immerhin im nativen System-Log (z. B. der `MemoryError` oben), `console.log` dagegen nicht.
9. **Konversationshistorie akkumuliert über alle `generate()`-Aufrufe hinweg (wichtiger Fund):** `react-native-litert-lm` hält standardmässig **eine einzige, fortlaufende Konversation** im geladenen Modell — jeder `generate()`/`execute()`-Aufruf hängt sich an die Historie aller vorherigen Aufrufe an, egal aus welchem Screen. Das führte zu beobachtbarer Kontext-Verschmutzung: eine PDF-Kurzzusammenfassung antwortete mit "Kopfhörer" (Rest aus dem LLM-Test-Default-Prompt), und der LLM-Test-Screen lieferte nach vielen Testläufen "komische" Antworten auch auf einfache Fragen. **Fix:** `model.reset()` (wrappt `resetConversation()`) wird jetzt vor jedem unabhängigen, einmaligen `generate()`-Aufruf aufgerufen (LLM-Test, Freitext-Extraktion, PDF-Zusammenfassung) — das behebt beides. **Wichtig für zukünftige Features:** jeder neue Ort, der `generate()`/`execute()` für eine in sich abgeschlossene Anfrage nutzt, braucht vorher ein `reset()`, sonst wiederholt sich das Problem.
10. **KI hielt sich nicht zuverlässig an JSON-Formatanweisungen, auch mit sauberem Kontext:** Der ursprüngliche PDF-Zusammenfassungs-Prompt verlangte JSON (`{"short":...,"detailed":...}`), das Modell antwortete aber teils mit reinem Fließtext statt JSON, obwohl der Prompt explizit "AUSSCHLIESSLICH JSON" verlangte und die Konversation frisch resettet war (siehe Punkt 9) — nicht reproduzierbar, trat unregelmässig auf. **Gelöst durch Vereinfachung statt Workaround:** Der Prompt verlangt inzwischen gar kein JSON mehr, sondern nur noch einen einzelnen Fliesstext-Absatz (passend zum "Freundlich"-PDF-Layout, das ohnehin nur eine KI-Box statt zwei vorsieht) — dadurch entfällt das Parsing-Problem komplett. Für zuverlässiges strukturiertes JSON böte sich bei Bedarf `enableStructuredOutput`/`responseSchema` der Library an (constrained decoding, siehe deren README), aktuell nicht nötig.
11. **Custom-Font-Embedding (Fraunces/Karla via `pdf-lib` + `@pdf-lib/fontkit`) scheiterte unter Hermes, obwohl in Node fehlerfrei:** WOFF-Fontdateien wurden als Base64-Konstanten eingebettet; das Laden warf keinen Fehler, aber alle Glyphen wurden als unleserliche Punkte/Striche gerendert. Ein identischer Test mit denselben Font-Bytes lief in einem reinen Node-Skript einwandfrei — die Ursache liegt also spezifisch in der Hermes/React-Native-Laufzeit (z. B. `@pdf-lib/fontkit` + `pako`-Dekompression), nicht am eigenen Base64-Decoder (byteweise gegen Node's `Buffer` verifiziert, identisch). **Fix: auf pdf-lib-Standard-Fonts umgeschwenkt** (`Times-Italic` für die grossen "Hero"-Zahlen, `Helvetica`/`HelveticaBold` sonst) statt weiter Zeit in die Fehlersuche zu stecken — genau der Fallback, der im Auftrag für diesen Fall vorgesehen war. `@pdf-lib/fontkit` und die generierten Font-Base64-Dateien wurden wieder entfernt.
12. **`pdf-lib`s `drawSvgPath` erwartet die obere linke Ecke als Anker, nicht die untere:** Beim Bau einer eigenen `drawRoundedRect()`-Hilfsfunktion (abgerundete Rechtecke gibt es in `pdf-lib` nicht nativ) wurde `y` fälschlich wie bei `drawRectangle`/`drawText` als **untere** linke Ecke behandelt. Das verschiebt jede Form um ihre eigene Höhe nach unten — bei unterschiedlich hohen Formen (Karte 34pt vs. Chip 16pt) fallen Chip und Karte dadurch sichtbar auseinander. **Fix:** `drawRoundedRect()` nimmt weiterhin `y` = untere Ecke entgegen (konsistent zum Rest des Codes) und rechnet intern selbst auf die von `drawSvgPath` erwartete obere Ecke um (`y + height`), statt dass jede Aufrufstelle das selbst berücksichtigen müsste.
13. **KI erfindet auch beim reinen Umformulieren vorgegebener Zahlen neue Werte:** Obwohl der PDF-Zusammenfassungs-Prompt die korrekte Restbudget-Prozentzahl (z. B. 32.3%) explizit als feststehenden Fakt vorgibt ("verwende ausschliesslich diese Zahlen"), hat das Modell im Fliesstext wiederholt einen anderen, erfundenen Wert (z. B. "22%") ausgegeben. Bestätigt über mehrere Exporte hinweg reproduzierbar. Genau dafür ist die KI-Box im PDF mit "KI · BITTE PRÜFEN" gekennzeichnet — bewusst keine Korrektur, da eine zuverlässige Lösung eine grössere Umstellung bräuchte (z. B. Platzhalter-Vorlagen statt freier KI-Formulierung, damit die KI nur noch Ton/Stil beisteuert und keine Zahlen mehr selbst wiedergibt).
14. **Vision-Framework-OCR statt direkter Bild-Übergabe verbessert die Foto-Extraktion, löst sie aber nicht vollständig:** Da Gemma 4 E2B-it bei direkter Bild-Übergabe (`sendMultimodalMessage`) 0/2 echte Kassenzettel korrekt gelesen hat (siehe Risiken), wurde die Pipeline umgebaut: ein eigenes natives Swift-Modul (`ReceiptOCR`, per `VNRecognizeTextRequest`) liest den Beleg-Text zuerst per Vision-Framework aus, danach läuft der erkannte Rohtext über denselben, bereits bewährten Freitext-Extraktionspfad (`buildExtractionPrompt`-Familie) statt über den Bild-Pfad. Technisch als Swift-Klasse + separate `.m`-Bridge-Datei umgesetzt, bewusst **ohne** Bridging-Header (Resolver/Rejecter-Parameter als plain `(Any?) -> Void`/`(String?, String?, Error?) -> Void` statt der React-Typalias, damit die Swift-Datei kein React importieren muss) — Standard-Pattern für Swift-Module ohne bestehenden Bridging-Header. Neue Dateien mussten per `xcodeproj`-Ruby-Gem ins Xcode-Projekt eingetragen werden (reines Ablegen im Dateisystem reicht nicht); dabei zunächst falsche relative Pfade gesetzt (Datei-Referenzen dieses Projekts tragen den vollen `budgetpilot/…`-Pfad direkt am File-Ref statt am Gruppen-Objekt) — Build brach mit "Build input file cannot be found" ab, bis die Pfade korrigiert wurden. **Ergebnis nach n=2 (nicht repräsentativ):** deutliche Verbesserung gegenüber der reinen Bild-Extraktion (keine kompletten Halluzinationen wie "Kaktus" mehr), aber noch nicht zuverlässig — ein einspaltiger Beleg lieferte einen plausiblen Betrag (10 statt 9.95) mit konfidenter, korrekter Kategorie; ein Beleg mit mehrspaltiger Artikel-Tabelle lieferte einen komplett falschen Betrag (5901 statt 37.10, vermutlich Ziffern aus zwei verschiedenen Tabellenspalten zusammengeklebt, da Vision zeilenweise statt spaltenweise liest) **ohne** Low-Confidence-Warnung — das gefährliche "falsch aber selbstsicher"-Muster besteht also fort, nur bei anderen Beleg-Typen. Nur iOS umgesetzt, kein Android-Äquivalent.

## Meilensteine (ca. 3 Tage POC)

**Tag 1 – Setup & Basisfunktionen**

- ✅ App Skeleton + Git/GitHub-Setup
- ⏳ Lokale DB
- ✅ Eingabe (Freitext) — strukturierte Felder (Kategorie-Chips, Betrag, Häufigkeit) im Entwurf-Screen vorhanden
- ✅ Baseline Budget Engine (Restbudget, Warnungen) — Fixkosten/geplante Käufe aus `cadence` abgeleitet
- ⏳ Golden Set anlegen (mind. 20 Beispiele) + Messkriterien definieren

**Tag 2 – On-Device KI Integration**

- ✅ Gemma On-Device Inferenz integriert (minimaler Test, funktioniert)
- ✅ Strukturierte Extraktion + Kategorisierung + UI zum Korrigieren (DraftScreen mit needs_input-Markierung, Low-Confidence-Rahmen)
- ⏳ Erste Messung Accuracy/Latency auf Golden Set, Iteration der Prompts/Validator-Regeln
- ✅ Umstieg auf Gemma 4 E2B-it (multimodal) inkl. Kamera-/Galerie-Erfassung (`react-native-image-picker`) vollständig im Simulator verifiziert (Download, `pod install`, Foto-Vorschau im Entwurf-Screen) — ⏳ inhaltliche Genauigkeit der Foto-Extraktion bei echten Belegen ungenügend, weitere Untersuchung nötig (siehe Risiken/Lessons Learned)

**Tag 3 – Demo-Flow & Export**

- ⏳ toppreise.ch Integration (oder Mock + Cache), UI-Auswahl eines Preises
- ✅ Zusammenfassung (kurz + detailliert) + PDF-Export — im Simulator verifiziert, Layout/Design noch in Überarbeitung (siehe Status)
- ⏳ Offline-Demo (Flugmodus) + kurzes POC-Report + Demo-Skript
- ⏳ Test auf echten Geräten (iPhone 12, Galaxy S21 FE) — Modell-Download läuft jetzt automatisch über `ModelRegistry` (kein eigener Sandbox-Download-Mechanismus mehr nötig), aber iOS Extended-Virtual-Addressing-Entitlement (kostenpflichtiger Account) und RAM-Realitätscheck auf dem 4-GB-iPhone-12 stehen noch aus

## Deliverables

- POC App-Build (APK/TestFlight o. Ä.)
- Testset + Auswertung (Accuracy/Latency)
- Kurzes POC-Report-Dokument (1–2 Seiten) inkl. Screenshots und Lessons Learned
- Demo-Skript (5 Minuten)
