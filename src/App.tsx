/**
 * BudgetPilot — On-Device-LLM-Test (react-native-litert-lm) + Ausgabenerfassung.
 *
 * Lädt Gemma 4 E2B-it (multimodal: Text + Vision + Audio) und stellt fünf
 * Tabs bereit:
 * - "Ausgabe erfassen": Freitext ODER Beleg-Foto → KI-Extraktion → Entwurf
 *   zum Bestätigen, bevor irgendwas gespeichert wird.
 * - "Budget": Einkommen, bestätigte Posten, Restbudget + Warnungen.
 * - "Kalender": Monatsansicht, Antippen eines Tages öffnet "Ausgabe
 *   erfassen" mit dem Datum vorausgefüllt.
 * - "Preise": Freitext → Suchbegriff (KI) → Preisabruf toppreise.ch.
 * - "LLM-Test": freier Prompt ans Modell, fürs Golden-Set-Testen.
 *
 * Bestätigte Posten und das Einkommen liegen in einer lokalen SQLite-Datenbank
 * (siehe src/db/) und überleben einen App-Neustart. Der Entwurf selbst wird
 * bewusst nicht gespeichert — erst "Bestätigen" schreibt.
 *
 * @format
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  StatusBar,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useModel, GEMMA_4_E2B_IT } from 'react-native-litert-lm';
import type { LineItem } from './budget';
import RNFS from 'react-native-fs';
import {
  addLineItems,
  deleteLineItem,
  getMonth,
  incomeToCents,
  incomeToChf,
  initDatabase,
  kindFromCadence,
  listLineItems,
  parseChf,
  setIncomeCents,
  toNewLineItem,
  toUiLineItem,
  updateLineItem,
  type LineItemPatch,
  type SqlDatabase,
} from './db';
import { cleanupOldTempBelegFiles, deleteBelegFile } from './belegFiles';
import {
  DarkModeOverrideContext,
  computeThemeColors,
  readPersistedDarkMode,
  writePersistedDarkMode,
} from './theme';
import { getStyles } from './styles';
import type { Screen, UndoState } from './types';
import { ScreenTabs } from './components/ScreenTabs';
import { UndoSnackbar } from './components/UndoSnackbar';
import { ExpenseFlow } from './screens/ExpenseFlow';
import { BudgetScreen } from './screens/BudgetScreen';
import { CalendarScreen } from './screens/CalendarScreen';
import { PriceSearchScreen } from './screens/PriceSearchScreen';
import { LlmTestScreen } from './screens/LlmTestScreen';
import { SettingsScreen } from './screens/SettingsScreen';

// Öffentliche HuggingFace-URL (kein Login/Lizenz-Klick nötig, anders als das
// vorherige Gemma-3-1B-IT-Setup). react-native-litert-lm lädt die Datei beim
// ersten useModel()-Aufruf selbst per HTTPS herunter und cached sie lokal
// (ModelRegistry) — kein manuelles Ablegen mehr wie in models/README.md
// bisher beschrieben, und funktioniert dadurch (anders als der alte
// hartcodierte Mac-Pfad) auch auf echten Geräten. ~2.6 GB, siehe
// models/README.md für Download-Realitätscheck.
const MODEL_SOURCE = GEMMA_4_E2B_IT;

// Zeitfenster für "Rückgängig" nach Löschen/Neue-Quittung-Bestätigen — siehe
// App()s triggerUndo(). Dateibasierte Nebenwirkungen (Foto löschen/ersetzen)
// werden bis zum Ablauf aufgeschoben, damit ein Rückgängig-Machen wirklich
// alles wiederherstellen kann.
const UNDO_WINDOW_MS = 10000;

function App() {
  // Eigene State-Quelle statt useThemeColors(): App() rendert die
  // DarkModeOverrideContext.Provider erst in seinem JSX weiter unten, ein
  // useContext()-Aufruf hier oben würde also nie den eigenen Provider sehen
  // (Provider wirkt nur auf Nachfahren, nicht auf die Komponente, die ihn
  // erzeugt). computeThemeColors() ist deshalb als reine Funktion ausgelagert
  // und wird hier direkt mit dem lokalen State aufgerufen, statt über den Hook.
  const systemColorScheme = useColorScheme();
  const [darkModeOverride, setDarkModeOverride] = useState(
    () => systemColorScheme === 'dark',
  );
  // Persistierte Wahl beim Start nachladen — der obige useState-Initializer
  // kann nicht direkt darauf zugreifen (RNFS ist async, useState-Initializer
  // müssen synchron sein), deshalb übernimmt dieser Effekt sie nachträglich,
  // sobald sie geladen ist. Kein Wert auf der Platte (erster App-Start)
  // lässt den System-Theme-Default aus der Zeile oben unangetastet.
  useEffect(() => {
    let cancelled = false;
    readPersistedDarkMode().then(persisted => {
      if (!cancelled && persisted !== null) {
        setDarkModeOverride(persisted);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const setDarkModeOverrideAndPersist = useCallback((value: boolean) => {
    setDarkModeOverride(value);
    writePersistedDarkMode(value);
  }, []);
  const colors = useMemo(
    () => computeThemeColors(darkModeOverride),
    [darkModeOverride],
  );
  const styles = useMemo(() => getStyles(colors), [colors]);
  const model = useModel(MODEL_SOURCE, {
    // 'cpu' auf beiden Plattformen — auf Android macht die Wahl aktuell
    // ohnehin keinen Unterschied: der Audio-Encoder läuft laut Library immer
    // fest auf CPU/XNNPACK, egal welches Hauptbackend gewählt wird (cpu/gpu/
    // npu alle getestet, identischer Absturz). Siehe CLAUDE.md Lessons
    // Learned zum Android-XNNPACK-SIGILL-Emulatorproblem.
    backend: 'cpu',
    // Nur auf Android: die Vorab-Schätzung verweigert das Laden auf dem
    // echten Galaxy S21 FE (7.5 GB RAM) knapp (~450 MB "fehlend" laut
    // Schätzung, schwankt mit laufenden Hintergrund-Apps) — JS-seitiger
    // Override, siehe CLAUDE.md Lessons Learned. Auf iOS hat die
    // Vorab-Schätzung bisher nie fälschlich blockiert, daher dort nicht
    // pauschal umgangen.
    forceLoad: Platform.OS === 'android',
    // Explizit setzen statt uns auf die Dateinamens-Heuristik der Library zu
    // verlassen (die nur nach "3n"/"gemma3" im Pfad sucht — bei
    // "gemma-4-E2B-it.litertlm" würde sie ohnehin nicht greifen). Siehe
    // Lessons Learned in CLAUDE.md zum früheren Multimodal-Bug mit Gemma 3 1B-IT.
    multimodal: true,
    // Laut react-native-litert-lm-Typdefinitionen ist thinking bereits
    // standardmässig aktiv — hier trotzdem explizit gesetzt, um uns nicht auf
    // den impliziten Default zu verlassen. Getestet gegen den direkten
    // Bild-Pfad (wie Google AI Edge Gallery): hat dort NICHT geholfen (siehe
    // CLAUDE.md Lessons Learned) — bleibt trotzdem an, da es dem
    // Text-Extraktionsschritt der OCR-Pipeline plausibel beim Auflösen von
    // OCR-Mehrdeutigkeiten (z.B. mehrspaltige Belege) helfen kann.
    //
    // tokenBudget war ursprünglich -1 (unbegrenzt) — das hat bei einem
    // komplexeren Beleg (viele Artikel) dazu geführt, dass das Modell sein
    // gesamtes maxOutputTokens-Budget (Default 1024) mit Denken aufgebraucht
    // hat, ohne je zur JSON-Antwort zu kommen ("Keine JSON-Antwort im
    // Modell-Output gefunden", siehe CLAUDE.md Lessons Learned). Fix:
    // Denk-Budget gedeckelt UND maxOutputTokens erhöht, damit nach dem
    // Denken sicher noch Platz für die eigentliche Antwort bleibt.
    thinking: { enabled: true, tokenBudget: 512 },
    maxOutputTokens: 2048,
  });
  const [screen, setScreen] = useState<Screen>('expense');
  const [items, setItems] = useState<LineItem[]>([]);
  // Datum, das per Antippen im Kalender vorausgewählt wurde — füllt das
  // Kaufdatum im nächsten Entwurf vor, wird danach sofort wieder geleert.
  const [prefilledDate, setPrefilledDate] = useState<string | null>(null);
  // Posten, der per Antippen im Budget-Tab zum Bearbeiten geöffnet wurde —
  // wechselt den Tab zu "Ausgabe erfassen" und wird dort sofort konsumiert
  // (analog zu prefilledDate). Für den Kalender-Tag-Detail-Fall (Antippen
  // eines Postens in der existingItemsForDate-Liste) läuft der Sprung direkt
  // innerhalb von ExpenseFlow, ohne über diesen State zu gehen — dort ist
  // man ja schon auf dem richtigen Tab.
  const [itemToEdit, setItemToEdit] = useState<LineItem | null>(null);
  // Erst bei 'ready' rendern wir die Tabs — sonst würde BudgetScreen sein
  // Einkommens-Textfeld aus einem noch leeren `income` initialisieren und der
  // geladene Wert käme nie im Feld an.
  const [dbStatus, setDbStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [dbError, setDbError] = useState<string | null>(null);
  const dbRef = useRef<SqlDatabase | null>(null);
  // "Rückgängig"-Banner nach Löschen oder Bestätigen mit neuer Quittung
  // (siehe triggerUndo weiter unten) — läuft app-weit, damit es auch dann
  // noch sichtbar ist, wenn man inzwischen den Tab gewechselt hat.
  const [undo, setUndo] = useState<UndoState | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const db = await initDatabase();
        const rows = await listLineItems(db);
        if (cancelled) {
          return;
        }
        dbRef.current = db;
        setItems(rows.map(toUiLineItem));
        setDbStatus('ready');
      } catch (e) {
        console.error('[db] Initialisierung fehlgeschlagen:', e);
        if (cancelled) {
          return;
        }
        setDbError(e instanceof Error ? e.message : String(e));
        setDbStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Optimistisch: der Posten erscheint sofort in der Liste, das Schreiben läuft
  // daneben. Schlägt es fehl, wird er wieder entfernt — besser als eine Zeile,
  // die der User sieht und die beim nächsten Start still verschwunden ist.
  const addItem = (item: LineItem) => {
    setItems(prev => [...prev, item]);
    const db = dbRef.current;
    if (!db) {
      return;
    }
    addLineItems(db, [toNewLineItem(item)]).catch(e => {
      console.error('[db] Posten nicht gespeichert:', e);
      setItems(prev => prev.filter(existing => existing.id !== item.id));
      setDbError(`"${item.description}" konnte nicht gespeichert werden.`);
    });
  };

  // Bearbeiten eines bereits bestätigten Postens (z.B. falsche Quittung
  // gescannt) — im Unterschied zu addItem() ein UPDATE, kein INSERT.
  // Optimistisch wie addItem(): der Posten ändert sich sofort in der Liste,
  // bei einem Fehler wird der alte Stand wiederhergestellt.
  const updateItem = (id: string, patch: Partial<LineItem>) => {
    const previous = items.find(existing => existing.id === id) ?? null;
    setItems(prev =>
      prev.map(existing => (existing.id === id ? { ...existing, ...patch } : existing)),
    );
    const db = dbRef.current;
    if (!db) {
      return;
    }
    // Nur Felder mappen, die LineItemPatch tatsächlich unterstützt (siehe
    // db/repository.ts) — source/confidence/reason bleiben bewusst
    // unangetastet, damit lokaler State und DB nicht auseinanderlaufen.
    const dbPatch: LineItemPatch = { needsInput: false };
    if (patch.description !== undefined) {
      dbPatch.description = patch.description;
    }
    if (patch.amount !== undefined) {
      dbPatch.amountCents = patch.amount === null ? null : parseChf(patch.amount);
    }
    if (patch.currency !== undefined) {
      dbPatch.currency = patch.currency;
    }
    if (patch.cadence !== undefined) {
      dbPatch.cadence = patch.cadence;
      dbPatch.kind = kindFromCadence(patch.cadence);
    }
    if (patch.category !== undefined) {
      dbPatch.category = patch.category;
    }
    if (patch.date !== undefined) {
      dbPatch.date = patch.date;
    }
    if (patch.photoFilename !== undefined) {
      dbPatch.photoFilename = patch.photoFilename;
    }
    if (patch.manuallyEditedFields !== undefined) {
      dbPatch.manuallyEditedFields = patch.manuallyEditedFields;
    }
    updateLineItem(db, id, dbPatch).catch(e => {
      console.error('[db] Änderung nicht gespeichert:', e);
      if (previous) {
        setItems(prev => prev.map(existing => (existing.id === id ? previous : existing)));
      }
      setDbError(
        `"${previous?.description ?? 'Posten'}" konnte nicht aktualisiert werden.`,
      );
    });
  };

  // Zeigt das "Rückgängig"-Banner unten (siehe UndoSnackbar) für
  // UNDO_WINDOW_MS. `onExpire` läuft nur, wenn NICHT rückgängig gemacht
  // wurde — dort gehören dateibasierte Aufräumarbeiten hin, die man vor
  // Ablauf des Fensters noch rückgängig machen könnte (siehe deleteItem,
  // handleBestaetigen in ExpenseFlow).
  const triggerUndo = (
    message: string,
    handlers: { onUndo: () => void; onExpire: () => void },
  ) => {
    // Ein noch offenes Banner nicht einfach verwerfen, sonst würde dessen
    // aufgeschobene Aufräumarbeit (z.B. eine zum Löschen vorgemerkte
    // Foto-Datei) nie ausgeführt.
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undo?.onExpire();
    }
    const entry: UndoState = { key: Date.now(), message, ...handlers };
    setUndo(entry);
    undoTimerRef.current = setTimeout(() => {
      entry.onExpire();
      undoTimerRef.current = null;
      setUndo(current => (current?.key === entry.key ? null : current));
    }, UNDO_WINDOW_MS);
  };

  const handleUndoPress = () => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    undo?.onUndo();
    setUndo(null);
  };

  // Löscht einen Posten — der Bestätigungs-Dialog dafür läuft in ExpenseFlow
  // (handleLoeschen), hier nur noch die eigentliche Ausführung. Die
  // DB-Zeile/der lokale State werden sofort entfernt, ein evtl. dauerhaftes
  // Beleg-Foto aber erst gelöscht, wenn das Undo-Fenster abläuft — sonst
  // wäre "Rückgängig" kaputt (die Datei wäre schon weg).
  const deleteItem = (item: LineItem) => {
    setItems(prev => prev.filter(existing => existing.id !== item.id));
    const db = dbRef.current;
    if (db) {
      deleteLineItem(db, item.id).catch(e => {
        console.error('[db] Posten nicht gelöscht:', e);
        setItems(prev => [...prev, item]);
        setDbError(`"${item.description}" konnte nicht gelöscht werden.`);
      });
    }
    triggerUndo(`"${item.description}" gelöscht`, {
      onUndo: () => {
        setItems(prev => [...prev, item]);
        if (db) {
          addLineItems(db, [toNewLineItem(item)]).catch(e => {
            console.error('[db] Posten nicht wiederhergestellt:', e);
            setItems(prev => prev.filter(existing => existing.id !== item.id));
            setDbError(
              `"${item.description}" konnte nicht wiederhergestellt werden.`,
            );
          });
        }
      },
      onExpire: () => {
        if (item.photoFilename) {
          deleteBelegFile(`${RNFS.DocumentDirectoryPath}/${item.photoFilename}`);
        }
      },
    });
  };

  // Einkommen ist pro Monat gespeichert (budget_months.income_cents) — anders
  // als items gibt es dafür keinen sinnvollen "alle Monate auf einmal"-State
  // auf App-Ebene, deshalb lädt/speichert BudgetScreen es direkt für den
  // gerade ausgewählten Monat über diese beiden Funktionen.
  const getIncomeForMonth = async (month: string): Promise<number | null> => {
    const db = dbRef.current;
    if (!db) {
      return null;
    }
    const row = await getMonth(db, month);
    return incomeToChf(row?.incomeCents ?? null);
  };

  const setIncomeForMonth = (month: string, next: number | null) => {
    const db = dbRef.current;
    if (!db) {
      return;
    }
    setIncomeCents(db, month, incomeToCents(next)).catch(e => {
      console.error('[db] Einkommen nicht gespeichert:', e);
      setDbError('Einkommen konnte nicht gespeichert werden.');
    });
  };

  // Sicherheitsnetz: fängt liegen gebliebene Scan-Zwischenstände ab, falls
  // das Löschen beim Verwerfen/Bestätigen mal durch einen Absturz oder
  // Fast-Refresh-Reload übersprungen wurde (siehe cleanupOldTempBelegFiles).
  // Betrifft nicht die dauerhaften Beleg-Fotos bestätigter Posten.
  useEffect(() => {
    cleanupOldTempBelegFiles(24 * 60 * 60 * 1000);
  }, []);

  const darkModeOverrideValue = useMemo(
    () => ({ isDarkMode: darkModeOverride, setIsDarkMode: setDarkModeOverrideAndPersist }),
    [darkModeOverride, setDarkModeOverrideAndPersist],
  );

  if (dbStatus !== 'ready') {
    return (
      <DarkModeOverrideContext.Provider value={darkModeOverrideValue}>
        <SafeAreaProvider>
          <StatusBar
            barStyle={colors.isDarkMode ? 'light-content' : 'dark-content'}
          />
          <View style={[styles.appContainer, styles.dbGate]}>
            {dbStatus === 'loading' ? (
              <Text style={styles.status}>Datenbank wird geöffnet …</Text>
            ) : (
              <>
                <Text style={styles.title}>Datenbank nicht verfügbar</Text>
                <Text style={styles.errorText}>{dbError}</Text>
              </>
            )}
          </View>
        </SafeAreaProvider>
      </DarkModeOverrideContext.Provider>
    );
  }

  return (
    <DarkModeOverrideContext.Provider value={darkModeOverrideValue}>
      <SafeAreaProvider>
        <StatusBar barStyle={colors.isDarkMode ? 'light-content' : 'dark-content'} />
        <View style={styles.appContainer}>
          <ScreenTabs screen={screen} onChange={setScreen} />
          {dbError && (
            <Pressable onPress={() => setDbError(null)}>
              <Text style={styles.dbBanner}>
                {dbError} (tippen zum Ausblenden)
              </Text>
            </Pressable>
          )}
          {screen === 'expense' && (
            <ExpenseFlow
              model={model}
              items={items}
              onConfirmItem={addItem}
              onUpdateItem={updateItem}
              onDeleteItem={deleteItem}
              triggerUndo={triggerUndo}
              prefilledDate={prefilledDate}
              onPrefilledDateConsumed={() => setPrefilledDate(null)}
              itemToEdit={itemToEdit}
              onItemEditConsumed={() => setItemToEdit(null)}
            />
          )}
          {screen === 'budget' && (
            <BudgetScreen
              model={model}
              getIncomeForMonth={getIncomeForMonth}
              setIncomeForMonth={setIncomeForMonth}
              items={items}
              onEditItem={item => {
                setItemToEdit(item);
                setScreen('expense');
              }}
            />
          )}
          {screen === 'calendar' && (
            <CalendarScreen
              items={items}
              onSelectDate={date => {
                setPrefilledDate(date);
                setScreen('expense');
              }}
            />
          )}
          {screen === 'price' && <PriceSearchScreen model={model} />}
          {screen === 'llmTest' && <LlmTestScreen model={model} />}
          {screen === 'settings' && <SettingsScreen />}
        </View>
        {undo && (
          <UndoSnackbar
            key={undo.key}
            message={undo.message}
            durationMs={UNDO_WINDOW_MS}
            onPress={handleUndoPress}
          />
        )}
      </SafeAreaProvider>
    </DarkModeOverrideContext.Provider>
  );
}

export default App;
