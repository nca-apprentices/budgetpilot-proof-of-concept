#!/bin/sh
#
# Öffnet die SQLite-Datenbank der App im laufenden iOS-Simulator.
#
#   npm run db                       -> interaktive sqlite3-Shell
#   npm run db -- ".tables"          -> ein Befehl, dann zurück
#   npm run db -- "SELECT * FROM line_items;"
#   npm run db -- --path             -> nur den Dateipfad ausgeben
#
# Warum ein Skript und kein fester Pfad: das Container-Verzeichnis der App
# (…/Application/<UUID>/) bekommt bei jeder Neuinstallation eine neue UUID.
# `simctl get_app_container` fragt den aktuellen Pfad zur Laufzeit ab.
#
# Anderes Gerät als das gerade gebootete: SIMCTL_DEVICE=<UDID> npm run db
# (UDIDs zeigt `xcrun simctl list devices`).

set -e

BUNDLE_ID="org.reactjs.native.example.budgetpilot"
DEVICE="${SIMCTL_DEVICE:-booted}"

CONTAINER=$(xcrun simctl get_app_container "$DEVICE" "$BUNDLE_ID" data 2>/dev/null) || {
  echo "Container nicht gefunden. Läuft ein Simulator und ist die App installiert?" >&2
  echo "Prüfen mit: xcrun simctl list devices booted" >&2
  exit 1
}

DB="$CONTAINER/Library/budgetpilot.sqlite"

if [ "$1" = "--path" ]; then
  echo "$DB"
  exit 0
fi

if [ ! -f "$DB" ]; then
  echo "Noch keine Datenbank: $DB" >&2
  echo "Die Datei entsteht beim ersten App-Start (initDatabase())." >&2
  exit 1
fi

# Pfad nach stderr, damit `npm run db -- "SELECT …" > out.csv` sauber bleibt.
echo "DB: $DB" >&2

# -header/-column: lesbare Tabellen statt pipe-getrennter Rohzeilen.
exec sqlite3 -header -column "$DB" "$@"
