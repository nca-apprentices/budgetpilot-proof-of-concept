# Lokale Modell-Dateien

Dieser Ordner ist bewusst leer im Git-Repo (`.gitignore` schließt `*.litertlm` aus) — die Datei ist zu groß, um sie zu committen.

## Setup — Gemma 4 E2B-it (aktuelles Modell)

Anders als beim vorherigen Gemma-3-1B-IT-Setup gibt es **keinen manuellen Download-Schritt**:

- App.tsx nutzt die von `react-native-litert-lm` exportierte Konstante `GEMMA_4_E2B_IT`
  (`https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm`).
- Das Repo ist **nicht gated** (`gated: false` laut HuggingFace-API) — kein Login, kein Lizenz-Klick nötig.
- Die Library lädt die Datei beim ersten `useModel()`-Aufruf selbst per HTTPS herunter (mit Progress-Callback, sichtbar über `downloadProgress`) und cached sie lokal über die interne `ModelRegistry`. Das funktioniert dadurch — anders als der alte hartcodierte Mac-Pfad — **auch auf echten Geräten**, nicht nur im Simulator.
- Datei-Größe: **2'588'147'712 Bytes** (≈ 2.59 GB, per HuggingFace-API verifiziert).

Beim ersten Start der App also einfach warten, bis der Download durchgelaufen ist (Fortschritt sichtbar im Status-Text + Fortschrittsbalken). Danach läuft die Inferenz komplett offline.

**Wichtig während des Downloads:** Keine Code-Änderungen an `App.tsx` vornehmen, solange der Download läuft — jeder Fast-Refresh-Reload setzt `useModel` zurück und der Download startet spürbar weiter hinten neu (siehe CLAUDE.md, Lessons Learned #7).

### Größen-/Speicher-Realitätscheck — im Mac-Simulator durchgeführt, echte Geräte noch offen

- Download: ~2.6 GB, hat im Test ca. 15–20 Minuten gedauert (zum Vergleich: das alte 584-MB-Textmodell lud deutlich schneller).
- Laut Library-Doku braucht Gemma 4 E2B-it **min. 4 GB RAM**. Im Simulator ist das reale Risiko bereits einmal eingetreten: `MemoryError: Refusing to load model (2468 MB): Estimated usage exceeds available memory by ~275 MB` — das Laden wurde von der Library aktiv verweigert (kein Absturz, aber auch keine sichtbare Fehlermeldung im UI, siehe Lessons Learned #5). Nach Schliessen einiger Mac-Apps (mehr freier Speicher) lud das Modell danach sofort erfolgreich.
- Das iPhone 12 hat **insgesamt 4 GB RAM** (System + App) und kann anders als der Mac nicht einfach "aufgeräumt" werden — das ist auf diesem Zielgerät ein reales Risiko, nicht nur eine Marginalie. Vor echtem Geräte-Testing unbedingt mit Xcode Instruments (RSS) prüfen, ob die App das übersteht, insbesondere während Vision-Inferenz (Foto-Extraktion).
- Auf der Galaxy S21 FE (mehr RAM) ist das Risiko geringer, aber ebenfalls noch nicht gemessen — Android-Profiler-Messung steht noch aus.

### iOS: Extended Virtual Addressing

Modelle über ~2 GB brauchen auf iOS das Extended-Virtual-Addressing-Entitlement, sonst deckelt iOS den virtuellen Speicher bei ~2 GB und Jetsam killt die App:

```xml
<key>com.apple.developer.kernel.extended-virtual-addressing</key>
<true/>
```

Das braucht einen **kostenpflichtigen Apple-Developer-Account** und ist aktuell **noch nicht eingerichtet** (keine `.entitlements`-Datei im Projekt). Ohne dieses Entitlement ist ein Test auf einem echten iPhone mit diesem Modell vermutlich nicht stabil möglich — im Simulator ist das Limit bisher nicht beobachtet worden, aber auch dort nicht abschliessend geprüft.

## Kamera-Erfassung (Beleg-Foto)

`react-native-image-picker` ist als npm-Paket installiert (`launchCamera()`), aber das native Setup ist noch offen:

- `NSCameraUsageDescription` ist bereits in `ios/budgetpilot/Info.plist` ergänzt.
- **`cd ios && pod install` wurde noch nicht ausgeführt** — ohne das linkt Xcode die native Kamera-Modul-Implementierung nicht ein, der Foto-Button in "Ausgabe erfassen" crasht dann beim Antippen.
- Vor dem ersten Kamera-Test also `pod install` laufen lassen und die App neu bauen.

## Altes Modell (Gemma 3 1B-IT)

Nicht mehr im Code verwendet (siehe CLAUDE.md, Lessons Learned). Falls für Vergleichstests trotzdem gewünscht: manuell unter
https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4.litertlm
herunterladen (Login + Lizenz-Akzeptanz nötig, 584 MB, text-only).
