# BudgetPilot — Proof of Concept (Projektkontext)

> Diese Datei fasst den aktuellen Stand und alle bereits getroffenen Entscheidungen zusammen.
> Gedacht als Kontext für Claude Code (z. B. als `CLAUDE.md` im Projekt-Root) und als Referenz für den POC-Bericht.

## Status (aktueller Stand)

- ✅ Projekt-Setup: React Native 0.87 (TypeScript), erstellt in IntelliJ
- ✅ GitHub-Repo verbunden: `github.com/nca-apprentices/budgetpilot-proof-of-concept` (privat)
- ✅ **Grösstes technisches Risiko widerlegt:** Gemma 3 1B-IT läuft nachweislich on-device im iOS-Simulator (`react-native-litert-lm`), liefert korrekte, verständliche Antworten, funktioniert offline
- ✅ Bekannter Bug gefunden & gelöst (siehe "Lessons Learned" unten)
- ✅ "Ausgabe erfassen" + "LLM-Test" Screens implementiert (App.tsx): Freitext → Gemma-3-1B-IT-Extraktion → Entwurf zum Bestätigen, bewusst ohne Persistenz
- ✅ Baseline Budget Engine implementiert (`budget.ts` Datenmodell, `budgetEngine.ts` reine `computeBudget`-Funktion, Budget-Tab in App.tsx mit Einkommen-Eingabe, Fixkosten-/geplante-Käufe-Liste, Restbudget + Warnungen)
- ✅ PDF-Export implementiert und im Simulator verifiziert: "Freundlich"-Layout (`pdfExport.ts`, reines `pdf-lib`, kein natives PDF-Modul) mit farbigen Kategorie-Chips + Datums-Pillen pro Posten, abgerundeten Posten-Karten, Zwischen-/Gesamtsumme, Restbudget-Fortschrittsbalken, Warnungs-Banner und einer KI-Zusammenfassungs-Box ("KI · BITTE PRÜFEN"), Speichern via `react-native-fs` + Teilen über den eingebauten `Share`-Dialog. Custom-Font-Embedding (Fraunces/Karla) ist am Hermes-Runtime gescheitert, läuft daher mit Standard-Fonts (Times-Italic für die grossen Zahlen, Helvetica/HelveticaBold sonst) — siehe Lessons Learned. `LineItem` um ein manuell editierbares Kaufdatum ergänzt (Textfeld "TT.MM.JJJJ" im Entwurf-Screen, kein nativer Datums-Picker).
- ✅ **Wichtiger Bugfix, wirkt sich auf die ganze App aus:** `model.reset()` wird jetzt vor jedem unabhängigen `generate()`-Aufruf aufgerufen (LLM-Test, Freitext-Extraktion, PDF-Zusammenfassung) — vorher hing jeder Aufruf an derselben, endlos wachsenden Modell-Konversation, was zu Kontext-Verschmutzung zwischen völlig unabhängigen Anfragen führte (siehe Lessons Learned)
- ⏳ Offen: lokale Datenbank, Preislogik (toppreise.ch), Golden Set, Tests auf echten Geräten (aktuell nur Simulator), Umstieg auf multimodales Modell für Kamera-/Beleg-Scan

## Feststehende Tech-Entscheidungen

Diese Punkte waren im ursprünglichen Plan noch offen ("je nach Team-Know-how" etc.) — sind aber jetzt entschieden und sollten nicht mehr zur Diskussion stehen:

| Punkt                          | Entscheidung                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Programmiersprache / Framework | React Native + TypeScript (nicht Flutter)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| On-Device-LLM                  | Gemma 3 1B-IT (`google/gemma-3-1b-it`), int4-quantisiert                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Modell-Quelle                  | `litert-community/Gemma3-1B-IT` auf Hugging Face, Datei `gemma3-1b-it-int4.litertlm` (584 MB, `.litertlm`-Format)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| LLM-Runtime/Bibliothek         | `react-native-litert-lm` + `react-native-nitro-modules` (nicht llama.cpp/MediaPipe direkt)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Zielplattformen                | Beide von Anfang an — iPhone 12 (iOS 15.1+) und Samsung Galaxy S21 FE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Wichtige Einschränkung         | iOS-Simulator-Test nur auf Apple-Silicon-Mac (arm64) möglich — bei uns gegeben                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Backend für Inferenz           | `cpu` (GPU/Metal im Simulator unzuverlässig, ggf. später auf echtem Gerät testen)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Datenhaltung                   | Lokal, SQLite (konkretes RN-Paket noch offen: `expo-sqlite` oder `react-native-sqlite-storage`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PDF-Erstellung                 | `pdf-lib` (reines JS, kein natives Modul/pod install nötig, manuelles Text-/Formen-Layout via `drawText`/`drawSvgPath`) statt `react-native-html-to-pdf` (nativ, seit längerem nicht mehr aktiv gepflegt) — bewusst risikoärmer nach den nativen Stolpersteinen bei anderen Libraries. Layout "Freundlich" (von 4 Optionen ausgewählt, nach Feedback angepasst: Einkommen statt Restbudget oben). Fonts: Standard-Fonts (kein Custom-Embedding, siehe Lessons Learned). Datei-Speicherung via `react-native-fs`, Teilen via eingebauten `Share` aus `react-native` (keine weitere native Dependency nötig). |
| Netzwerkzugriff (toppreise.ch) | `fetch` (eingebaut) oder `axios`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Ziel des POC

Nachweisen, dass BudgetPilot als On-Device-App (offline möglich) zuverlässig:

- Budget/Einkommen + Wunschliste erfassen kann (auch als Freitext)
- Budgetposten & Ausgaben automatisch extrahiert und kategorisiert (Gemma 3 1B-IT on device)
- Produktpreise manuell oder via toppreise.ch bezieht
- Restbudget nach geplanten Käufen korrekt berechnet
- eine verständliche Ausgaben-Zusammenfassung generiert und als PDF exportiert
- sensible Daten lokal verarbeitet (Privacy-by-Design)

## POC-Umfang (MVP-Schnitt)

### In Scope

1. **Dateneingabe**
   - Monatliches Einkommen/Budget (z. B. "Ich habe 4500 CHF Einkommen, Fixkosten 1200 CHF Miete…")
   - Wunschliste geplante Käufe (Freitext + strukturierte Eingabe)
2. **On-Device KI (Gemma 3 1B-IT)**
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
7. **Kamera-/Beleg-Erfassung** (neu, per Feedback)
   - Kassenzettel/Belege per Kamera fotografieren, multimodales Modell extrahiert dieselben Felder wie beim Freitext-Pfad
   - Details/Modellwahl noch offen, siehe Status oben

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
- **LineItem** (`budget.ts`): `id`, `description`, `amount`, `currency`, `cadence` (monthly/one_time), `category`, `source` (free_text/manual/toppreise — nur `free_text` aktuell angebunden), `confidence`, `notes`, `date` (ISO `YYYY-MM-DD`, Kaufdatum — vom Nutzer im Entwurf-Screen als Freitextfeld "TT.MM.JJJJ" editierbar, vorausgefüllt mit dem heutigen Datum; kein Datums-Picker, um keine weitere native Dependency einzuführen; wird nicht vom Modell extrahiert)
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

> Aktueller Stand: In App.tsx (`buildExtractionPrompt`) läuft bereits eine vereinfachte Variante produktiv — Modell antwortet mit einem einzelnen JSON-Objekt (kein `items`-Array), `category: "needs_input"` als Sentinel statt separatem `needs_input`-Array. Funktioniert im Simulator. Der ursprünglich entworfene, ausführlichere Extraktions-Prompt mit `items`-Array, `needs_input`- und `category_alternatives`-Arrays liegt separat in `../../../Downloads/entwurf-extraktion-prompt.md` — als Referenz für eine mögliche spätere Erweiterung (z. B. mehrere Posten pro Text, differenziertere Low-Confidence-Behandlung), aktuell aber nicht das, was im Code läuft.

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

## Lessons Learned (bisher)

1. **npm Script-Genehmigung:** Neuere npm-Versionen blockieren automatisch ausgeführte "postinstall"-Skripte von Paketen (Sicherheitsfeature). Lösung: Skript-Quellcode vor Freigabe geprüft (lädt nur offizielles, signiertes iOS-Framework von GitHub Releases), dann gezielt freigegeben.
2. **Multimodal-Bug:** `react-native-litert-lm` erkennt anhand des Dateinamens ("gemma3" oder "3n" im Pfad), ob ein Modell multimodal ist, und nimmt dann automatisch ein GPU-Vision-Backend an. Da unsere Datei `gemma3-1b-it-int4.litertlm` heisst, das Modell aber rein textbasiert ist, schlug die Engine-Initialisierung zunächst fehl ("Failed to create conversation context"). Fix: `multimodal: false` explizit übergeben. **Wichtig für den anstehenden Umstieg auf ein multimodales Modell:** dort ist `multimodal: true` vermutlich korrekt — nicht blind den alten Fix übernehmen, tatsächliches Verhalten prüfen.
3. **Modellpfad ist aktuell hartcodiert** (absoluter Pfad auf dem Mac) — funktioniert nur im iOS-Simulator, der direkt auf das Host-Dateisystem zugreift. Für echte Geräte (iPhone 12, Galaxy S21 FE) wird ein In-App-Download ins App-Sandbox-Verzeichnis benötigt — noch nicht umgesetzt.
4. **Konversationshistorie akkumuliert über alle `generate()`-Aufrufe hinweg (wichtiger Fund):** `react-native-litert-lm` hält standardmässig **eine einzige, fortlaufende Konversation** im geladenen Modell — jeder `generate()`/`execute()`-Aufruf hängt sich an die Historie aller vorherigen Aufrufe an, egal aus welchem Screen. Das führte zu beobachtbarer Kontext-Verschmutzung: eine PDF-Kurzzusammenfassung antwortete mit "Kopfhörer" (Rest aus dem LLM-Test-Default-Prompt), und der LLM-Test-Screen lieferte nach vielen Testläufen "komische" Antworten auch auf einfache Fragen. **Fix:** `model.reset()` (wrappt `resetConversation()`) wird jetzt vor jedem unabhängigen, einmaligen `generate()`-Aufruf aufgerufen (LLM-Test, Freitext-Extraktion, PDF-Zusammenfassung) — das behebt beides. **Wichtig für zukünftige Features:** jeder neue Ort, der `generate()`/`execute()` für eine in sich abgeschlossene Anfrage nutzt, braucht vorher ein `reset()`, sonst wiederholt sich das Problem.
5. **KI hielt sich nicht zuverlässig an JSON-Formatanweisungen, auch mit sauberem Kontext:** Der ursprüngliche PDF-Zusammenfassungs-Prompt verlangte JSON (`{"short":...,"detailed":...}`), das Modell antwortete aber teils mit reinem Fließtext statt JSON, obwohl der Prompt explizit "AUSSCHLIESSLICH JSON" verlangte und die Konversation frisch resettet war (siehe Punkt 4) — nicht reproduzierbar, trat unregelmässig auf. **Gelöst durch Vereinfachung statt Workaround:** Der Prompt verlangt inzwischen gar kein JSON mehr, sondern nur noch einen einzelnen Fliesstext-Absatz (passend zum "Freundlich"-PDF-Layout, das ohnehin nur eine KI-Box statt zwei vorsieht) — dadurch entfällt das Parsing-Problem komplett. Für zuverlässiges strukturiertes JSON böte sich bei Bedarf `enableStructuredOutput`/`responseSchema` der Library an (constrained decoding, siehe deren README), aktuell nicht nötig.
6. **Custom-Font-Embedding (Fraunces/Karla via `pdf-lib` + `@pdf-lib/fontkit`) scheiterte unter Hermes, obwohl in Node fehlerfrei:** WOFF-Fontdateien wurden als Base64-Konstanten eingebettet; das Laden warf keinen Fehler, aber alle Glyphen wurden als unleserliche Punkte/Striche gerendert. Ein identischer Test mit denselben Font-Bytes lief in einem reinen Node-Skript einwandfrei — die Ursache liegt also spezifisch in der Hermes/React-Native-Laufzeit (z. B. `@pdf-lib/fontkit` + `pako`-Dekompression), nicht am eigenen Base64-Decoder (byteweise gegen Node's `Buffer` verifiziert, identisch). **Fix: auf pdf-lib-Standard-Fonts umgeschwenkt** (`Times-Italic` für die grossen "Hero"-Zahlen, `Helvetica`/`HelveticaBold` sonst) statt weiter Zeit in die Fehlersuche zu stecken — genau der Fallback, der im Auftrag für diesen Fall vorgesehen war. `@pdf-lib/fontkit` und die generierten Font-Base64-Dateien wurden wieder entfernt.
7. **`pdf-lib`s `drawSvgPath` erwartet die obere linke Ecke als Anker, nicht die untere:** Beim Bau einer eigenen `drawRoundedRect()`-Hilfsfunktion (abgerundete Rechtecke gibt es in `pdf-lib` nicht nativ) wurde `y` fälschlich wie bei `drawRectangle`/`drawText` als **untere** linke Ecke behandelt. Das verschiebt jede Form um ihre eigene Höhe nach unten — bei unterschiedlich hohen Formen (Karte 34pt vs. Chip 16pt) fallen Chip und Karte dadurch sichtbar auseinander. **Fix:** `drawRoundedRect()` nimmt weiterhin `y` = untere Ecke entgegen (konsistent zum Rest des Codes) und rechnet intern selbst auf die von `drawSvgPath` erwartete obere Ecke um (`y + height`), statt dass jede Aufrufstelle das selbst berücksichtigen müsste.
8. **KI erfindet auch beim reinen Umformulieren vorgegebener Zahlen neue Werte:** Obwohl der PDF-Zusammenfassungs-Prompt die korrekte Restbudget-Prozentzahl (z. B. 32.3%) explizit als feststehenden Fakt vorgibt ("verwende ausschliesslich diese Zahlen"), hat das Modell im Fliesstext wiederholt einen anderen, erfundenen Wert (z. B. "22%") ausgegeben. Bestätigt über mehrere Exporte hinweg reproduzierbar. Genau dafür ist die KI-Box im PDF mit "KI · BITTE PRÜFEN" gekennzeichnet — bewusst keine Korrektur, da eine zuverlässige Lösung eine grössere Umstellung bräuchte (z. B. Platzhalter-Vorlagen statt freier KI-Formulierung, damit die KI nur noch Ton/Stil beisteuert und keine Zahlen mehr selbst wiedergibt).

## Meilensteine (ca. 3 Tage POC)

**Tag 1 – Setup & Basisfunktionen**

- ✅ App Skeleton + Git/GitHub-Setup
- ⏳ Lokale DB
- ✅ Eingabe (Freitext) — strukturierte Felder (Kategorie-Chips, Betrag, Häufigkeit) im Entwurf-Screen vorhanden
- ✅ Baseline Budget Engine (Restbudget, Warnungen) — Fixkosten/geplante Käufe werden aktuell aus `cadence` abgeleitet, nicht separat erfasst; ggf. später explizite Trennung nötig, falls ein Posten mal beides sein soll
- ⏳ Golden Set anlegen (mind. 20 Beispiele) + Messkriterien definieren

**Tag 2 – On-Device KI Integration**

- ✅ Gemma On-Device Inferenz integriert (minimaler Test, funktioniert)
- ✅ Strukturierte Extraktion + Kategorisierung + UI zum Korrigieren (DraftScreen mit needs_input-Markierung, Low-Confidence-Rahmen)
- ⏳ Erste Messung Accuracy/Latency auf Golden Set, Iteration der Prompts/Validator-Regeln
- ⏳ Umstieg auf multimodales Modell für Kamera-/Beleg-Scan (Modellname noch offen)

**Tag 3 – Demo-Flow & Export**

- ⏳ toppreise.ch Integration (oder Mock + Cache), UI-Auswahl eines Preises
- ✅ Zusammenfassung (kurz + detailliert) + PDF-Export — im Simulator verifiziert, Layout/Design noch in Überarbeitung (siehe Status)
- ⏳ Offline-Demo (Flugmodus) + kurzes POC-Report + Demo-Skript
- ⏳ Test auf echten Geräten (iPhone 12, Galaxy S21 FE) — Modell-Download-Mechanismus für Sandbox nötig

## Deliverables

- POC App-Build (APK/TestFlight o. Ä.)
- Testset + Auswertung (Accuracy/Latency)
- Kurzes POC-Report-Dokument (1–2 Seiten) inkl. Screenshots und Lessons Learned
- Demo-Skript (5 Minuten)
