# Lokale Modell-Dateien

Dieser Ordner ist bewusst leer im Git-Repo (`.gitignore` schließt `*.litertlm` aus) — die Datei ist zu groß und gated, um sie zu committen.

## Setup

1. Auf https://huggingface.co/litert-community/Gemma3-1B-IT einloggen und die Gemma-Lizenz akzeptieren (falls noch nicht geschehen).
2. Datei **`gemma3-1b-it-int4.litertlm`** (584 MB) herunterladen:
   https://huggingface.co/litert-community/Gemma3-1B-IT/resolve/main/gemma3-1b-it-int4.litertlm
3. Die Datei in diesen Ordner legen, sodass sie hier liegt:
   `models/gemma3-1b-it-int4.litertlm`

Der Pfad ist in `App.tsx` als absoluter Pfad auf diesem Rechner hinterlegt (nur für den iOS-Simulator geeignet — der Simulator liest direkt vom Mac-Dateisystem. Für ein echtes Gerät müsste die Datei stattdessen ins App-Sandbox-Verzeichnis heruntergeladen werden, z.B. über `ModelRegistry.resolveModel()` mit einem HF-Auth-Header).

Nach dem einmaligen Download läuft die Inferenz komplett offline.
