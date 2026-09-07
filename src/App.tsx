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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Button,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { useModel, type UseModelResult, GEMMA_4_E2B_IT } from 'react-native-litert-lm';
import { Calendar, type DateData } from 'react-native-calendars';
import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import {
  ALLOWED_CATEGORIES,
  type Category,
  type Cadence,
  type LineItem,
  type Source,
} from './budget';
import { computeBudget } from './budgetEngine';
import { buildBudgetReportPdf, savePdfAndShare } from './pdfExport';
import RNFS from 'react-native-fs';
import { recognizeReceiptText } from './receiptOcr';
import { pickBestMatch, searchToppreise, type PriceResult } from './toppreise';
import {
  addLineItems,
  getMonth,
  incomeToCents,
  incomeToChf,
  initDatabase,
  listLineItems,
  monthOfDate,
  setIncomeCents,
  toNewLineItem,
  toUiLineItem,
  type SqlDatabase,
} from './db';

// Öffentliche HuggingFace-URL (kein Login/Lizenz-Klick nötig, anders als das
// vorherige Gemma-3-1B-IT-Setup). react-native-litert-lm lädt die Datei beim
// ersten useModel()-Aufruf selbst per HTTPS herunter und cached sie lokal
// (ModelRegistry) — kein manuelles Ablegen mehr wie in models/README.md
// bisher beschrieben, und funktioniert dadurch (anders als der alte
// hartcodierte Mac-Pfad) auch auf echten Geräten. ~2.6 GB, siehe
// models/README.md für Download-Realitätscheck.
const MODEL_SOURCE = GEMMA_4_E2B_IT;

const DEFAULT_PROMPT =
  'Fasse diese Ausgaben zusammen: Kopfhörer 150.-, Lebensmittel 320.-, Kino 40.-';

const DANGER_COLOR = '#dc2626';
const CAUTION_COLOR = '#f5a623';

type Draft = {
  description: string;
  amount: number | null;
  currency: string;
  cadence: Cadence;
  category: Category | null; // null = Modell lieferte "needs_input", muss ausgefüllt werden
  confidence: number | null;
  reason: string;
};

const LOW_CONFIDENCE_THRESHOLD = 0.7;

// Gemeinsames JSON-Schema für Freitext- UND Foto-Extraktion — eine Quelle
// der Wahrheit, damit beide Pfade garantiert dieselben Felder/Kategorien
// liefern und über dieselbe buildDraftFromRaw()-Normalisierung laufen.
function extractionSchemaInstructions(): string {
  return `Das JSON-Objekt muss genau diese Felder enthalten:
- "description": string — kurze Beschreibung der Ausgabe
- "amount": Zahl — der Betrag, oder null falls nicht erkennbar
- "currency": string — z.B. "CHF" oder "EUR"
- "cadence": entweder "monthly" (wiederkehrend/monatlich) oder "one_time" (einmalig)
- "category": genau eine dieser 7 Kategorien: Wohnen, Lebensmittel, Mobilität, Freizeit, Gesundheit, Abos, Sonstiges — oder "needs_input", falls keine sicher zugeordnet werden kann
- "confidence": Zahl zwischen 0 und 1 — wie sicher du bei dieser Extraktion insgesamt bist
- "reason": kurze Begründung auf Deutsch`;
}

function buildExtractionPrompt(userText: string): string {
  return `Du bist ein Extraktions-Assistent für die Budget-App BudgetPilot. Lies die folgende Freitext-Beschreibung einer Ausgabe und antworte AUSSCHLIESSLICH mit einem einzelnen JSON-Objekt — keine Erklärung, kein Markdown, kein Codeblock.

${extractionSchemaInstructions()}

Beispiel:
Text: "Miete 1200 CHF monatlich"
Antwort: {"description":"Miete","amount":1200,"currency":"CHF","cadence":"monthly","category":"Wohnen","confidence":0.95,"reason":"Eindeutige monatliche Mietzahlung."}

Text: "${userText}"
Antwort:`;
}

// Ersetzt die frühere direkte Bild-Extraktion (sendMultimodalMessage): statt
// Gemma 4 E2B-it den Kassenzettel als Bild lesen zu lassen (unzuverlässig
// bei feinem Druck, siehe CLAUDE.md Risiken/Lessons Learned), liest
// ReceiptOCR.swift den Text zuerst per Vision-Framework aus, und nur der
// erkannte Rohtext geht ans Modell — über denselben Extraktions-Pfad wie
// Freitext, nur mit einer Beleg-spezifischen Einleitung statt der
// Freitext-Einleitung von buildExtractionPrompt().
function buildReceiptOcrExtractionPrompt(ocrText: string): string {
  return `Du bist ein Extraktions-Assistent für die Budget-App BudgetPilot. Der folgende Text wurde per OCR aus einem fotografierten Kassenzettel/Beleg erkannt (Zeilenumbrüche und Layout können durcheinander sein). Finde den Gesamtbetrag (meist bei "TOTAL") und die Art der Ausgabe, und antworte AUSSCHLIESSLICH mit einem einzelnen JSON-Objekt — keine Erklärung, kein Markdown, kein Codeblock.

Manche Belege zeigen bei Kartenzahlung ZWEI Totale in unterschiedlichen Währungen (Fremdwährungs-Umrechnung/Dynamic Currency Conversion, z.B. eine Zeile "Total in EUR"/"Local currency ..." zusätzlich zum eigentlichen CHF-Betrag). Verwende in diesem Fall IMMER den CHF-Betrag, nicht die umgerechnete Fremdwährung.

Bei Barzahlung stehen oft ZUSÄTZLICH zum Gesamtbetrag noch der gegebene Bargeld-Betrag (Zeile "BAR" o.Ä.) und das Wechselgeld (Zeile "Zurück") auf dem Beleg. Verwende IMMER den Betrag bei "TOTAL", NIEMALS den Bargeld-/Wechselgeld-Betrag — der gegebene Bargeld-Betrag ist praktisch immer höher als der tatsächliche Kaufbetrag.

Beispiel für genau diesen Fall — ein OCR-Text enthält u.a. diese drei Zeilen:
TOTAL CHF 24.50
BAR 30.00
Zurück CHF -5.50
Der korrekte Betrag ist hier 24.50 (bei "TOTAL"). NICHT 30.00 (nur das gegebene Bargeld) und NICHT 5.50/-5.50 (nur das Wechselgeld).

${extractionSchemaInstructions()}

OCR-Text:
"""
${ocrText}
"""

Antwort:`;
}

// Sucht deterministisch die erste "TOTAL <Währung> <Betrag>"-Stelle im
// OCR-Text und nutzt sie als verlässlichen Betrag — statt das Modell frei
// zwischen mehreren echten Zahlen (Bargeld, Wechselgeld, Fremdwährungs-
// Umrechnung, Mengenangaben, Rabatt-Summen) wählen zu lassen, was sich
// wiederholt als unzuverlässig erwiesen hat, auch mit expliziten
// Anweisungen/Beispielen im Prompt (siehe CLAUDE.md Lessons Learned). Nutzt
// aus, dass der eigentliche Kaufbetrag auf Schweizer Kassenzetteln praktisch
// immer VOR sekundären Zeilen wie Bargeld/Wechselgeld oder einer
// Fremdwährungs-Umrechnung steht — deshalb reicht das erste Vorkommen.
// Verlangt einen Währungscode direkt nach "TOTAL" (kein reines "\d" davor
// erlaubt), damit z.B. "Sie sparen total 2.23" (Rabatt-Summe ohne
// Währungscode) NICHT fälschlich als Gesamtbetrag erkannt wird. Gibt null
// zurück, wenn kein eindeutiges "TOTAL <Währung> <Betrag>" gefunden wird
// (z.B. bei ungewöhnlichen Belegen), dann bleibt es beim vom Modell
// gelieferten Betrag als Fallback.
function findTotalAmountInOcrText(ocrText: string): number | null {
  const match = ocrText.match(/\bTOTAL\b\s*(?:CHF|EUR|USD|GBP)\s*(\d+[.,]\d{2})/i);
  return match ? parseAmount(match[1]) : null;
}

function buildSummaryPrompt(
  income: number | null,
  items: LineItem[],
  summary: ReturnType<typeof computeBudget>,
): string {
  const formatItems = (list: LineItem[]) =>
    list.length === 0
      ? '(keine)'
      : list
          .map(
            item =>
              `- ${item.description}: ${
                item.amount !== null
                  ? `${item.amount} ${item.currency}`
                  : 'unbekannt'
              } (${item.category ?? 'Sonstiges'})`,
          )
          .join('\n');

  const fixedCosts = items.filter(item => item.cadence === 'monthly');
  const plannedPurchases = items.filter(item => item.cadence === 'one_time');

  // Die Zahlen sind bereits von computeBudget() berechnet und werden dem
  // Modell als feststehende Fakten vorgegeben — es soll nur noch formulieren,
  // nicht selbst rechnen. Reduziert das Halluzinationsrisiko, das beim
  // Foto-Extraktionspfad bereits aufgefallen ist (siehe CLAUDE.md).
  return `Du bist ein Finanz-Assistent für die Budget-App BudgetPilot. Hier sind bereits berechnete, korrekte Zahlen zu einem Budget — verwende ausschliesslich diese Zahlen, erfinde, runde oder berechne nichts neu:

Einkommen: ${income !== null ? `${income} CHF/Monat` : 'nicht angegeben'}
Fixkosten (monatlich):
${formatItems(fixedCosts)}
Geplante Käufe (einmalig):
${formatItems(plannedPurchases)}
Fixkosten gesamt: ${summary.totalFixedCosts} CHF
Geplante Käufe gesamt: ${summary.totalPlannedPurchases} CHF
Restbudget: ${
    summary.restbudget !== null
      ? `${summary.restbudget} CHF (${summary.restbudgetPercent?.toFixed(
          1,
        )}% des Einkommens)`
      : 'unbekannt'
  }

Formuliere daraus einen kurzen, freundlichen Fliesstext (2-3 Sätze) auf Deutsch für den Nutzer. Antworte NUR mit diesem Fliesstext — keine Anführungszeichen, keine Überschrift, kein JSON, kein Markdown.

Antwort:`;
}

/**
 * Wandelt eine umgangssprachliche Produktbeschreibung in einen knappen
 * Suchbegriff für toppreise.ch um ("brauche neue kabellose Sony Kopfhörer
 * xm5" → "Sony WH-1000XM5"). Das Modell liefert NUR den Suchbegriff — den
 * Preis holt danach deterministischer Code, nie das Modell (siehe CLAUDE.md
 * Lessons Learned zu erfundenen Zahlen).
 */
function buildProductQueryPrompt(userText: string): string {
  return `Du hilfst bei einer Produktsuche auf dem Schweizer Preisvergleich toppreise.ch. Wandle die folgende Beschreibung in einen kurzen Suchbegriff um: Marke und Modellbezeichnung, keine Füllwörter, keine Farbe, keine Menge, kein Preis.

Antworte AUSSCHLIESSLICH mit dem Suchbegriff — keine Erklärung, keine Anführungszeichen, kein Satzzeichen am Ende.

Beispiel:
Text: "ich brauche neue kabellose kopfhörer von sony, die xm5"
Antwort: Sony WH-1000XM5

Beispiel:
Text: "eine günstige waschmaschine von bosch"
Antwort: Bosch Waschmaschine

Text: "${userText}"
Antwort:`;
}

/** Das Modell hängt gern Erklärungen oder Anführungszeichen an — nur die erste Zeile zählt. */
function cleanProductQuery(raw: string): string {
  return (raw.split('\n').find(line => line.trim().length > 0) ?? '')
    .replace(/^["'`\s]+|["'`\s.]+$/g, '')
    .slice(0, 80)
    .trim();
}

function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Keine JSON-Antwort im Modell-Output gefunden.');
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function parseAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  const n = parseFloat(
    String(raw)
      .replace(',', '.')
      .replace(/[^0-9.-]/g, ''),
  );
  return Number.isFinite(n) ? n : null;
}

function normalizeCadence(raw: unknown): Cadence {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (v === 'monthly' || v.includes('monat')) {
    return 'monthly';
  }
  if (
    v === 'one_time' ||
    v.includes('einmal') ||
    v.includes('one-time') ||
    v.includes('onetime')
  ) {
    return 'one_time';
  }
  // Unbekannter Wert (z.B. "yearly"): konservativ als Einmalzahlung werten,
  // statt fälschlich etwas als wiederkehrend einzuplanen.
  return 'one_time';
}

function normalizeCategory(raw: unknown): Category | null {
  if (raw === 'needs_input') {
    return null;
  }
  return (ALLOWED_CATEGORIES as readonly string[]).includes(raw as string)
    ? (raw as Category)
    : 'Sonstiges';
}

function buildDraftFromRaw(raw: any): Draft {
  const confidence =
    typeof raw?.confidence === 'number' && Number.isFinite(raw.confidence)
      ? raw.confidence
      : null;
  return {
    description: typeof raw?.description === 'string' ? raw.description : '',
    amount: parseAmount(raw?.amount),
    currency:
      typeof raw?.currency === 'string' && raw.currency.trim()
        ? raw.currency.trim()
        : 'CHF',
    cadence: normalizeCadence(raw?.cadence),
    category: normalizeCategory(raw?.category),
    confidence,
    reason: typeof raw?.reason === 'string' ? raw.reason : '',
  };
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Aufräum-Hilfsfunktionen für die nach RNFS.DocumentDirectoryPath kopierten
// Beleg-Fotos (siehe processBelegUri) — dieser Ordner wird von Android/iOS
// NICHT automatisch bereinigt (bewusst, siehe CLAUDE.md Lessons Learned zum
// CachesDirectoryPath-Bug), daher braucht es eigene Lösch-Logik, damit sich
// dort nicht unbegrenzt Datei-Leichen ansammeln.
const BELEG_FILE_PREFIX = 'beleg-';

async function listBelegFiles() {
  try {
    const entries = await RNFS.readDir(RNFS.DocumentDirectoryPath);
    return entries.filter(entry => entry.isFile() && entry.name.startsWith(BELEG_FILE_PREFIX));
  } catch (e) {
    console.error('[beleg-cleanup] Verzeichnis konnte nicht gelesen werden:', e);
    return [];
  }
}

// Löschen darf den eigentlichen Foto-Erfassungs-Flow nie blockieren oder zum
// Absturz bringen — die Datei könnte bereits gelöscht sein oder nie
// existiert haben, das ist unkritisch.
async function deleteBelegFile(path: string): Promise<void> {
  try {
    await RNFS.unlink(path);
  } catch {
    // Absichtlich ignoriert, siehe Kommentar oben.
  }
}

// Vor jedem neuen Beleg-Foto alle bisherigen löschen: pro Zeitpunkt ist immer
// nur ein Entwurf aktiv (siehe CLAUDE.md Status, "bewusst ohne Persistenz"),
// eine übrig gebliebene ältere Kopie kann also nur von einem vorherigen
// Absturz/Fast-Refresh-Reload stammen.
async function cleanupAllBelegFiles(): Promise<void> {
  const files = await listBelegFiles();
  await Promise.all(files.map(file => deleteBelegFile(file.path)));
}

// Sicherheitsnetz beim App-Start (siehe App()): fängt Datei-Leichen ab, falls
// das Löschen beim Verwerfen/Bestätigen (handleVerwerfen/handleBestaetigen)
// mal durch einen Absturz übersprungen wurde.
async function cleanupOldBelegFiles(maxAgeMs: number): Promise<void> {
  const files = await listBelegFiles();
  const cutoff = Date.now() - maxAgeMs;
  const stale = files.filter(file => file.mtime !== undefined && file.mtime.getTime() < cutoff);
  await Promise.all(stale.map(file => deleteBelegFile(file.path)));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDateDMY(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

// Robust: akzeptiert "TT.MM.JJJJ", füllt einstellige Tag/Monat-Angaben auf.
// Gibt null zurück statt zu werfen, wenn der Text nicht als Datum lesbar ist.
function parseDateDMY(text: string): string | null {
  const match = text.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) {
    return null;
  }
  const [, day, month, year] = match;
  const dayNum = Number(day);
  const monthNum = Number(month);
  if (dayNum < 1 || dayNum > 31 || monthNum < 1 || monthNum > 12) {
    return null;
  }
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// Sucht ein "TT.MM.JJJJ"-Datum irgendwo im Freitext (z.B. "Miete 15.09.2025")
// statt es beim Extrahieren still zu verwerfen und immer das heutige Datum
// vorzuschlagen. Bewusst per Regex statt übers LLM erkannt — deterministisch,
// kein Hallucinationsrisiko, kein zusätzlicher Modell-Aufruf nötig.
function findDateInText(text: string): string | null {
  const match = text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
  return match ? parseDateDMY(match[1]) : null;
}

type Screen = 'expense' | 'budget' | 'calendar' | 'price' | 'llmTest';

function App() {
  const colors = useThemeColors();
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
  const [income, setIncome] = useState<number | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);
  // Datum, das per Antippen im Kalender vorausgewählt wurde — füllt das
  // Kaufdatum im nächsten Entwurf vor, wird danach sofort wieder geleert.
  const [prefilledDate, setPrefilledDate] = useState<string | null>(null);
  // Erst bei 'ready' rendern wir die Tabs — sonst würde BudgetScreen sein
  // Einkommens-Textfeld aus einem noch leeren `income` initialisieren und der
  // geladene Wert käme nie im Feld an.
  const [dbStatus, setDbStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [dbError, setDbError] = useState<string | null>(null);
  const dbRef = useRef<SqlDatabase | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const db = await initDatabase();
        const [rows, month] = await Promise.all([
          listLineItems(db),
          getMonth(db, monthOfDate(todayIso())),
        ]);
        if (cancelled) {
          return;
        }
        dbRef.current = db;
        setItems(rows.map(toUiLineItem));
        setIncome(incomeToChf(month?.incomeCents ?? null));
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

  const changeIncome = (next: number | null) => {
    setIncome(next);
    const db = dbRef.current;
    if (!db) {
      return;
    }
    setIncomeCents(db, monthOfDate(todayIso()), incomeToCents(next)).catch(
      e => {
        console.error('[db] Einkommen nicht gespeichert:', e);
        setDbError('Einkommen konnte nicht gespeichert werden.');
      },
    );
  };

  // Sicherheitsnetz: fängt liegen gebliebene Beleg-Foto-Kopien ab, falls das
  // Löschen beim Verwerfen/Bestätigen mal durch einen Absturz oder
  // Fast-Refresh-Reload übersprungen wurde (siehe cleanupOldBelegFiles).
  useEffect(() => {
    cleanupOldBelegFiles(24 * 60 * 60 * 1000);
  }, []);

  if (dbStatus !== 'ready') {
    return (
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
    );
  }

  return (
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
            prefilledDate={prefilledDate}
            onPrefilledDateConsumed={() => setPrefilledDate(null)}
          />
        )}
        {screen === 'budget' && (
          <BudgetScreen
            model={model}
            income={income}
            onChangeIncome={changeIncome}
            items={items}
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
      </View>
    </SafeAreaProvider>
  );
}

function ScreenTabs({
  screen,
  onChange,
}: {
  screen: Screen;
  onChange: (s: Screen) => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const tabs: { key: Screen; label: string }[] = [
    { key: 'expense', label: 'Ausgabe erfassen' },
    { key: 'budget', label: 'Budget' },
    { key: 'calendar', label: 'Kalender' },
    { key: 'price', label: 'Preise' },
    { key: 'llmTest', label: 'LLM-Test' },
  ];
  // Horizontal scrollbar: ab 5 Tabs passen die Labels nicht mehr auf ein
  // iPhone — vorher wurde "LLM-Test" am rechten Rand abgeschnitten.
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={[styles.tabBar, { paddingTop: insets.top + 12 }]}
      contentContainerStyle={styles.tabBarContent}
    >
      {tabs.map(tab => (
        <Pressable
          key={tab.key}
          style={[
            styles.tabButton,
            screen === tab.key && styles.tabButtonActive,
          ]}
          onPress={() => onChange(tab.key)}
        >
          <Text
            style={[styles.tabText, screen === tab.key && styles.tabTextActive]}
          >
            {tab.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function ExpenseFlow({
  model,
  items,
  onConfirmItem,
  prefilledDate,
  onPrefilledDateConsumed,
}: {
  model: UseModelResult;
  items: LineItem[];
  onConfirmItem: (item: LineItem) => void;
  prefilledDate: string | null;
  onPrefilledDateConsumed: () => void;
}) {
  const {
    isReady,
    isGenerating,
    downloadProgress,
    error: modelError,
    generate,
    reset,
  } = model;
  // Nur relevant, wenn man aus dem Kalender kommt (Datum vorausgewählt) —
  // zeigt im Entry-Screen, was für diesen Tag schon erfasst wurde, statt
  // blind einen weiteren Posten hinzuzufügen, ohne die bestehenden zu sehen.
  const existingItemsForDate = useMemo(
    () => (prefilledDate ? items.filter(item => item.date === prefilledDate) : []),
    [items, prefilledDate],
  );
  const [step, setStep] = useState<'entry' | 'draft'>('entry');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftInitialDate, setDraftInitialDate] = useState(todayIso());
  const [draftSource, setDraftSource] = useState<Source>('free_text');
  const [draftPhotoUri, setDraftPhotoUri] = useState<string | null>(null);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Modell-Ladefehler (z.B. MemoryError) sind sonst unsichtbar — der Screen
  // bliebe endlos bei "Modell wird geladen…" hängen, ohne dass der Nutzer
  // erfährt, dass das Laden bereits fehlgeschlagen ist.
  const displayError = modelError ? `Fehler beim Laden des Modells: ${modelError}` : error;

  const handleWeiter = async () => {
    setError(null);
    try {
      // Jede Extraktion ist eine unabhängige Einzelanfrage — ohne Reset würde
      // sie an die wachsende Konversationshistorie älterer Aufrufe anhängen
      // und das Modell zunehmend verwirren (siehe CLAUDE.md Lessons Learned).
      reset();
      const result = await generate(buildExtractionPrompt(text));
      console.log('[extraction] Antwort:', result);
      const raw = extractJsonObject(result);
      setDraft(buildDraftFromRaw(raw));
      setDraftInitialDate(findDateInText(text) ?? prefilledDate ?? todayIso());
      onPrefilledDateConsumed();
      setDraftSource('free_text');
      setDraftPhotoUri(null);
      setStep('draft');
    } catch (e) {
      console.error('[extraction] Fehler:', e);
      setError(
        'Die Antwort des Modells konnte nicht ausgewertet werden. Bitte erneut versuchen.',
      );
    }
  };

  const processBelegUri = async (uri: string) => {
    if (!model.model) {
      setError('Modell ist noch nicht bereit.');
      return;
    }
    setIsProcessingPhoto(true);
    try {
      // Sofort in einen dauerhaften Ort im eigenen App-Speicher kopieren,
      // statt die vom Bild-Picker gelieferte URI direkt weiterzuverwenden:
      // react-native-image-picker räumt seine temporäre Cache-Datei auf
      // Android schnell wieder auf (auf iOS bisher nie beobachtet) — bis die
      // langsame OCR+LLM-Verarbeitung fertig ist und der Entwurf-Screen das
      // Foto anzeigen will, existiert die ursprüngliche Datei sonst nicht
      // mehr (bestätigt: leeres Vorschau-Feld auf Android, siehe CLAUDE.md
      // Lessons Learned). Bewusst DocumentDirectoryPath statt
      // CachesDirectoryPath: Gemma 4s eigene XNNPACK-Kompilierungs-Caches
      // liegen im selben Cache-Ordner und sind teils >700 MB gross, wodurch
      // Android die App-Cache-Quota sprengt sieht und regelmässig (per
      // installd, ca. alle 60s beobachtet) automatisch älteste Dateien
      // purgt — inklusive unserer gerade erst kopierten Beleg-Datei, bevor
      // der Entwurf-Screen sie anzeigen konnte (bestätigt per Logcat).
      // Alte Beleg-Kopien zuerst löschen (siehe cleanupAllBelegFiles) — sonst
      // sammeln sich in DocumentDirectoryPath unbegrenzt Dateien an, da
      // dieser Ordner (bewusst, anders als CachesDirectoryPath) nicht vom OS
      // automatisch bereinigt wird.
      await cleanupAllBelegFiles();
      const persistentPath = `${RNFS.DocumentDirectoryPath}/beleg-${Date.now()}.jpg`;
      await RNFS.copyFile(uri.replace('file://', ''), persistentPath);
      const persistentUri = `file://${persistentPath}`;

      const ocrText = await recognizeReceiptText(persistentUri);
      console.log('[extraction-photo] OCR-Text:', ocrText);
      // Wie beim Freitext-Pfad: jede Extraktion ist eine unabhängige
      // Einzelanfrage, sonst hängt sie an der Konversationshistorie
      // vorheriger Aufrufe (siehe CLAUDE.md Lessons Learned).
      reset();
      const result = await generate(buildReceiptOcrExtractionPrompt(ocrText));
      console.log('[extraction-photo] Antwort:', result);
      const raw = extractJsonObject(result);
      const photoDraft = buildDraftFromRaw(raw);
      // Betrag/Währung deterministisch überschreiben, falls die "TOTAL"-Zeile
      // im OCR-Text eindeutig gefunden wurde — zuverlässiger als das Modell
      // selbst zwischen mehreren echten Zahlen wählen zu lassen (siehe
      // findTotalAmountInOcrText und CLAUDE.md Lessons Learned).
      const totalHint = findTotalAmountInOcrText(ocrText);
      if (totalHint !== null) {
        photoDraft.amount = totalHint;
        photoDraft.currency = 'CHF';
      }
      setDraft(photoDraft);
      setDraftInitialDate(prefilledDate ?? todayIso());
      onPrefilledDateConsumed();
      setDraftSource('photo');
      setDraftPhotoUri(persistentUri);
      setStep('draft');
    } catch (e) {
      console.error('[extraction-photo] Fehler:', e);
      setError('Der Beleg konnte nicht ausgewertet werden. Bitte erneut versuchen.');
    } finally {
      setIsProcessingPhoto(false);
    }
  };

  const handleAufnehmen = async () => {
    setError(null);
    const photo = await launchCamera({ mediaType: 'photo', cameraType: 'back', quality: 1.0 });
    if (photo.didCancel) {
      return;
    }
    const uri = photo.assets?.[0]?.uri;
    if (photo.errorCode || !uri) {
      setError('Kamera konnte nicht geöffnet werden.');
      return;
    }
    await processBelegUri(uri);
  };

  const handleHochladen = async () => {
    setError(null);
    const photo = await launchImageLibrary({ mediaType: 'photo', quality: 1.0 });
    if (photo.didCancel) {
      return;
    }
    const uri = photo.assets?.[0]?.uri;
    if (photo.errorCode || !uri) {
      setError('Bild konnte nicht ausgewählt werden.');
      return;
    }
    await processBelegUri(uri);
  };

  const handleFoto = () => {
    Alert.alert('Beleg hinzufügen', undefined, [
      { text: 'Jetzt aufnehmen', onPress: handleAufnehmen },
      { text: 'Hochladen', onPress: handleHochladen },
      { text: 'Abbrechen', style: 'cancel' },
    ]);
  };

  const handleVerwerfen = () => {
    // Zugehöriges Beleg-Foto sofort löschen, statt bis zum nächsten
    // Foto-Erfassungsvorgang zu warten (siehe cleanupAllBelegFiles).
    if (draftPhotoUri) {
      deleteBelegFile(draftPhotoUri.replace('file://', ''));
    }
    setDraft(null);
    setDraftPhotoUri(null);
    setStep('entry');
  };

  const handleBestaetigen = (finalDraft: Draft, date: string) => {
    const item: LineItem = {
      id: createId(),
      description: finalDraft.description,
      amount: finalDraft.amount,
      currency: finalDraft.currency,
      cadence: finalDraft.cadence,
      category: finalDraft.category,
      source: draftSource,
      confidence: finalDraft.confidence,
      notes: finalDraft.reason,
      date,
    };
    console.log('[expense] Bestätigt:', item);
    onConfirmItem(item);
    // Zugehöriges Beleg-Foto wird nach dem Bestätigen nicht mehr gebraucht
    // (siehe cleanupAllBelegFiles) — nur zur Anzeige im Entwurf-Screen nötig.
    if (draftPhotoUri) {
      deleteBelegFile(draftPhotoUri.replace('file://', ''));
    }
    setDraft(null);
    setDraftPhotoUri(null);
    setText('');
    setStep('entry');
  };

  if (step === 'draft' && draft) {
    return (
      <DraftScreen
        draft={draft}
        initialDate={draftInitialDate}
        photoUri={draftPhotoUri}
        onConfirm={handleBestaetigen}
        onDiscard={handleVerwerfen}
      />
    );
  }

  return (
    <EntryScreen
      text={text}
      onChangeText={setText}
      onWeiter={handleWeiter}
      onFoto={handleFoto}
      isReady={isReady}
      isBusy={isGenerating || isProcessingPhoto}
      downloadProgress={downloadProgress}
      error={displayError}
      prefilledDate={prefilledDate}
      existingItemsForDate={existingItemsForDate}
    />
  );
}

function EntryScreen({
  text,
  onChangeText,
  onWeiter,
  onFoto,
  isReady,
  isBusy,
  downloadProgress,
  error,
  prefilledDate,
  existingItemsForDate,
}: {
  text: string;
  onChangeText: (t: string) => void;
  onWeiter: () => void;
  onFoto: () => void;
  isReady: boolean;
  isBusy: boolean;
  downloadProgress: number;
  error: string | null;
  prefilledDate: string | null;
  existingItemsForDate: LineItem[];
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);

  let status = 'Modell wird geladen…';
  if (isReady) {
    status = 'Modell bereit.';
  } else if (downloadProgress > 0) {
    status = 'Lade Modell (~2.6 GB)…';
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>Ausgabe erfassen</Text>
      <Text style={styles.status}>{status}</Text>
      {prefilledDate && (
        <Text style={styles.status}>
          Für {formatDateDMY(prefilledDate)} — aus dem Kalender ausgewählt.
        </Text>
      )}
      {!isReady && downloadProgress > 0 && (
        <DownloadProgressBar progress={downloadProgress} />
      )}

      <Text style={styles.label}>Ausgabe als Freitext:</Text>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={onChangeText}
        multiline
        placeholder="z.B. Miete 1200 CHF monatlich"
        placeholderTextColor={colors.placeholder}
      />

      {error && <Text style={styles.errorText}>{error}</Text>}

      {existingItemsForDate.length > 0 && (
        <>
          <Text style={styles.label}>
            Bereits erfasst für {formatDateDMY(prefilledDate as string)}:
          </Text>
          {existingItemsForDate.map(item => (
            <View key={item.id} style={styles.lineItemRow}>
              <Text style={styles.lineItemDescription}>{item.description}</Text>
              <Text style={styles.lineItemMeta}>
                {item.amount !== null
                  ? `${item.amount.toFixed(2)} ${item.currency}`
                  : '—'}{' '}
                · {item.category ?? 'Sonstiges'} ·{' '}
                {item.cadence === 'monthly' ? 'Fixkosten' : 'Einmalig'}
              </Text>
            </View>
          ))}
        </>
      )}

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <Button
            title={isBusy ? 'Analysiere…' : 'Weiter'}
            onPress={onWeiter}
            disabled={!isReady || isBusy || text.trim().length === 0}
          />
        </View>
        <View style={styles.buttonWrapper}>
          <Button
            title={isBusy ? 'Analysiere…' : '📷 Beleg fotografieren'}
            onPress={onFoto}
            disabled={!isReady || isBusy}
          />
        </View>
      </View>
    </ScrollView>
  );
}

function DraftScreen({
  draft,
  initialDate,
  photoUri,
  onConfirm,
  onDiscard,
}: {
  draft: Draft;
  initialDate: string;
  photoUri: string | null;
  onConfirm: (d: Draft, date: string) => void;
  onDiscard: () => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const [description, setDescription] = useState(draft.description);
  const [amountText, setAmountText] = useState(
    draft.amount === null ? '' : String(draft.amount),
  );
  const [currency, setCurrency] = useState(draft.currency);
  const [cadence, setCadence] = useState<Cadence>(draft.cadence);
  const [category, setCategory] = useState<Category | null>(draft.category);
  const [dateText, setDateText] = useState(formatDateDMY(initialDate));

  const lowConfidence =
    draft.confidence !== null && draft.confidence < LOW_CONFIDENCE_THRESHOLD;

  const parsedAmount = parseAmount(amountText);
  // An der aktuellen Eingabe statt am ursprünglichen KI-Wert festmachen, damit
  // der Hinweis verschwindet, sobald der Nutzer das Feld ausgefüllt hat.
  const amountNeedsInput = parsedAmount === null;
  const categoryNeedsInput = category === null;

  const canConfirm =
    description.trim().length > 0 && parsedAmount !== null && category !== null;

  const fieldStyle = (needsInput: boolean) => [
    styles.input,
    lowConfidence && styles.lowConfidenceBorder,
    needsInput && styles.needsInputBorder,
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>Entwurf bestätigen</Text>
      {draft.confidence !== null && (
        <Text style={styles.status}>
          Vertrauen der KI-Extraktion: {Math.round(draft.confidence * 100)}%
        </Text>
      )}

      {photoUri && (
        <Image
          source={{ uri: photoUri }}
          style={styles.receiptPreview}
          resizeMode="contain"
        />
      )}

      <Text style={styles.label}>Beschreibung</Text>
      <TextInput
        style={fieldStyle(false)}
        value={description}
        onChangeText={setDescription}
        placeholder="Beschreibung"
        placeholderTextColor={colors.placeholder}
      />

      <Text style={styles.label}>Betrag</Text>
      <TextInput
        style={fieldStyle(amountNeedsInput)}
        value={amountText}
        onChangeText={setAmountText}
        keyboardType="numeric"
        placeholder={amountNeedsInput ? 'Betrag eingeben' : undefined}
        placeholderTextColor={colors.placeholder}
      />
      {amountNeedsInput && (
        <Text style={styles.needsInputHint}>Bitte Betrag ausfüllen.</Text>
      )}

      <Text style={styles.label}>Währung</Text>
      <TextInput
        style={styles.input}
        value={currency}
        onChangeText={setCurrency}
        placeholder="CHF"
        placeholderTextColor={colors.placeholder}
      />

      <Text style={styles.label}>Häufigkeit</Text>
      <View
        style={[styles.segmentRow, lowConfidence && styles.lowConfidenceBorder]}
      >
        <Pressable
          style={[
            styles.segmentButton,
            cadence === 'monthly' && styles.segmentButtonActive,
          ]}
          onPress={() => setCadence('monthly')}
        >
          <Text
            style={[
              styles.segmentText,
              cadence === 'monthly' && styles.segmentTextActive,
            ]}
          >
            monatlich
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.segmentButton,
            cadence === 'one_time' && styles.segmentButtonActive,
          ]}
          onPress={() => setCadence('one_time')}
        >
          <Text
            style={[
              styles.segmentText,
              cadence === 'one_time' && styles.segmentTextActive,
            ]}
          >
            einmalig
          </Text>
        </Pressable>
      </View>

      <Text style={styles.label}>Kategorie</Text>
      <View
        style={[
          styles.chipContainer,
          lowConfidence && styles.lowConfidenceBorder,
          categoryNeedsInput && styles.needsInputBorder,
        ]}
      >
        {ALLOWED_CATEGORIES.map(c => (
          <Pressable
            key={c}
            style={[styles.chip, category === c && styles.chipSelected]}
            onPress={() => setCategory(c)}
          >
            <Text
              style={[
                styles.chipText,
                category === c && styles.chipTextSelected,
              ]}
            >
              {c}
            </Text>
          </Pressable>
        ))}
      </View>
      {categoryNeedsInput && (
        <Text style={styles.needsInputHint}>Bitte Kategorie auswählen.</Text>
      )}

      <Text style={styles.label}>Kaufdatum</Text>
      <TextInput
        style={styles.input}
        value={dateText}
        onChangeText={setDateText}
        placeholder="TT.MM.JJJJ"
        keyboardType="numeric"
        placeholderTextColor={colors.placeholder}
      />

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <Button
            title="Bestätigen"
            disabled={!canConfirm}
            onPress={() =>
              onConfirm(
                {
                  description: description.trim(),
                  amount: parsedAmount,
                  currency: currency.trim() || 'CHF',
                  cadence,
                  category,
                  confidence: draft.confidence,
                  reason: draft.reason,
                },
                parseDateDMY(dateText) ?? todayIso(),
              )
            }
          />
        </View>
        <View style={styles.buttonWrapper}>
          <Button title="Verwerfen" onPress={onDiscard} color="#999" />
        </View>
      </View>
    </ScrollView>
  );
}

function BudgetScreen({
  model,
  income,
  onChangeIncome,
  items,
}: {
  model: UseModelResult;
  income: number | null;
  onChangeIncome: (income: number | null) => void;
  items: LineItem[];
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const [incomeText, setIncomeText] = useState(
    income === null ? '' : String(income),
  );
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const handleIncomeChange = (t: string) => {
    setIncomeText(t);
    onChangeIncome(parseAmount(t));
  };

  // Fixkosten vs. geplante Käufe sind keine getrennt geführten Listen,
  // sondern nur eine Sicht auf `items`, abgeleitet aus `cadence`.
  const fixedCosts = items.filter(item => item.cadence === 'monthly');
  const plannedPurchases = items.filter(item => item.cadence === 'one_time');
  const summary = computeBudget(income, items);

  const handleExportPdf = async () => {
    setExportError(null);
    setIsExporting(true);
    let aiSummaryText: string | null = null;
    // KI-Zusammenfassung ist ein optionales Extra — schlägt sie fehl, wird
    // trotzdem ein PDF mit den (verlässlichen) strukturierten Daten exportiert.
    if (model.isReady) {
      try {
        model.reset();
        const raw = await model.generate(
          buildSummaryPrompt(income, items, summary),
        );
        aiSummaryText = raw.trim() || null;
      } catch (e) {
        console.error('[pdf-summary] Fehler:', e);
      }
    }
    try {
      const bytes = await buildBudgetReportPdf({
        income,
        items,
        summary,
        aiSummaryText,
      });
      await savePdfAndShare(bytes, `budgetpilot-bericht-${Date.now()}.pdf`);
    } catch (e) {
      console.error('[pdf-export] Fehler:', e);
      setExportError('PDF-Export fehlgeschlagen. Bitte erneut versuchen.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>Budget</Text>

      <Text style={styles.label}>Monatliches Einkommen</Text>
      <TextInput
        style={styles.input}
        value={incomeText}
        onChangeText={handleIncomeChange}
        keyboardType="numeric"
        placeholder="z.B. 4500"
        placeholderTextColor={colors.placeholder}
      />

      <Text style={styles.label}>Fixkosten (monatlich)</Text>
      {fixedCosts.length === 0 ? (
        <Text style={styles.status}>Noch keine erfasst.</Text>
      ) : (
        fixedCosts.map(item => <LineItemRow key={item.id} item={item} />)
      )}

      <Text style={styles.label}>Geplante Käufe (einmalig)</Text>
      {plannedPurchases.length === 0 ? (
        <Text style={styles.status}>Noch keine erfasst.</Text>
      ) : (
        plannedPurchases.map(item => <LineItemRow key={item.id} item={item} />)
      )}

      <Text style={styles.label}>Zusammenfassung</Text>
      <Text style={styles.status}>
        Fixkosten gesamt: {summary.totalFixedCosts.toFixed(2)} CHF{'\n'}
        Geplante Käufe gesamt: {summary.totalPlannedPurchases.toFixed(2)} CHF
        {'\n'}
        Ausgaben gesamt: {summary.totalSpent.toFixed(2)} CHF{'\n'}
        Restbudget:{' '}
        {summary.restbudget === null
          ? '—'
          : `${summary.restbudget.toFixed(2)} CHF`}
        {summary.restbudgetPercent !== null &&
          ` (${summary.restbudgetPercent.toFixed(1)}%)`}
      </Text>

      {summary.warnings.map((warning, index) => {
        const isOverBudget = warning.startsWith('Budget überschritten');
        return (
          <View
            key={index}
            style={[
              styles.warningBox,
              { borderColor: isOverBudget ? DANGER_COLOR : CAUTION_COLOR },
            ]}
          >
            <Text
              style={[
                styles.warningText,
                { color: isOverBudget ? DANGER_COLOR : CAUTION_COLOR },
              ]}
            >
              {warning}
            </Text>
          </View>
        );
      })}

      {exportError && <Text style={styles.errorText}>{exportError}</Text>}

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <Button
            title={isExporting ? 'Exportiere…' : 'Als PDF exportieren'}
            onPress={handleExportPdf}
            disabled={isExporting}
          />
        </View>
      </View>
    </ScrollView>
  );
}

function LineItemRow({ item }: { item: LineItem }) {
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  return (
    <View style={styles.lineItemRow}>
      <Text style={styles.lineItemDescription}>{item.description}</Text>
      <Text style={styles.lineItemMeta}>
        {item.amount !== null
          ? `${item.amount.toFixed(2)} ${item.currency}`
          : '—'}{' '}
        · {item.category ?? 'Sonstiges'}
      </Text>
    </View>
  );
}

const PROGRESS_SAMPLE_INTERVAL_MS = 1000;

// Der native Download-Callback feuert viel häufiger als jede Änderung
// sichtbar gemacht werden sollte — ungefiltert durchgereicht flackert die
// Prozentzahl mehrmals pro Sekunde. Hier wird nur der jeweils aktuellste
// Wert alle 250ms übernommen, statt bei jedem einzelnen Event neu zu rendern.
function useSampledProgress(value: number, intervalMs: number): number {
  const latestRef = useRef(value);
  latestRef.current = value;
  const [sampled, setSampled] = useState(value);

  useEffect(() => {
    const id = setInterval(() => setSampled(latestRef.current), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return sampled;
}

function DownloadProgressBar({ progress }: { progress: number }) {
  // `progress` ist ein Bruch (0–1), keine fertige Prozentzahl.
  const sampled = useSampledProgress(progress, PROGRESS_SAMPLE_INTERVAL_MS);
  const percent = Math.min(100, Math.max(0, Math.round(sampled * 100)));
  const animatedWidth = useRef(new Animated.Value(percent)).current;
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);

  useEffect(() => {
    Animated.timing(animatedWidth, {
      toValue: percent,
      duration: PROGRESS_SAMPLE_INTERVAL_MS,
      useNativeDriver: false, // 'width' unterstützt keinen Native Driver
    }).start();
  }, [percent, animatedWidth]);

  return (
    <View style={styles.progressRow}>
      <View style={styles.progressTrack}>
        <Animated.View
          style={[
            styles.progressFill,
            {
              width: animatedWidth.interpolate({
                inputRange: [0, 100],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      </View>
      <Text style={styles.progressLabel}>{percent}%</Text>
    </View>
  );
}

function CalendarScreen({
  items,
  onSelectDate,
}: {
  items: LineItem[];
  onSelectDate: (isoDate: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);

  // Tage mit mindestens einem erfassten Posten bekommen einen Punkt —
  // reine Anzeige, keine Auswahl-Logik.
  const markedDates = useMemo(() => {
    const marks: Record<string, { marked: true; dotColor: string }> = {};
    for (const item of items) {
      if (item.date) {
        marks[item.date] = { marked: true, dotColor: '#2563eb' };
      }
    }
    return marks;
  }, [items]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>Kalender</Text>
      <Text style={styles.status}>
        Auf ein Datum tippen, um dort eine Ausgabe zu erfassen.
      </Text>
      <Calendar
        markedDates={markedDates}
        onDayPress={(day: DateData) => onSelectDate(day.dateString)}
        theme={{
          todayTextColor: '#2563eb',
          arrowColor: '#2563eb',
          dotColor: '#2563eb',
          calendarBackground: colors.background,
          dayTextColor: colors.text,
          monthTextColor: colors.text,
          textSectionTitleColor: colors.textMuted,
          textDisabledColor: colors.borderSubtle,
        }}
      />
    </ScrollView>
  );
}

/**
 * Produktsuche mit Preisvergleich.
 *
 * Ablauf: Freitext → Gemma normalisiert ihn zu einem Suchbegriff → toppreise.ch
 * wird abgefragt und geparst → günstigstes Angebot des passendsten Produkts.
 * Der Suchbegriff bleibt editierbar, weil das Modell ihn manchmal danebenlegt.
 */
function PriceSearchScreen({ model }: { model: UseModelResult }) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const { isReady, isGenerating, generate, reset } = model;

  const [text, setText] = useState('');
  const [searchTerm, setSearchTerm] = useState<string | null>(null);
  const [results, setResults] = useState<PriceResult[] | null>(null);
  const [cacheNote, setCacheNote] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async (query: string) => {
    setIsSearching(true);
    setError(null);
    setCacheNote(null);
    try {
      const outcome = await searchToppreise(query);
      setResults(outcome.results);
      if (outcome.fromCache) {
        setCacheNote(
          `Offline — zwischengespeichertes Ergebnis, ca. ${outcome.cacheAgeHours} h alt.`,
        );
      }
    } catch (e) {
      console.error('[toppreise] Suche fehlgeschlagen:', e);
      setResults(null);
      setError(
        e instanceof Error
          ? `Preisabruf fehlgeschlagen: ${e.message}`
          : 'Preisabruf fehlgeschlagen. Benötigt Internet.',
      );
    } finally {
      setIsSearching(false);
    }
  };

  // Freitext → Suchbegriff (Modell) → Preisabruf (deterministisch).
  const handleSuchen = async () => {
    setError(null);
    setResults(null);
    let query = text.trim();
    if (query.length === 0) {
      return;
    }
    if (isReady) {
      try {
        // Unabhängige Einzelanfrage — ohne reset() hängt sie an der
        // Konversationshistorie (siehe CLAUDE.md Lessons Learned).
        reset();
        const raw = await generate(buildProductQueryPrompt(query));
        const cleaned = cleanProductQuery(raw);
        if (cleaned.length > 0) {
          query = cleaned;
        }
      } catch (e) {
        // Modellfehler ist nicht fatal — wir suchen dann mit dem Rohtext.
        console.warn('[toppreise] Normalisierung fehlgeschlagen:', e);
      }
    }
    setSearchTerm(query);
    await runSearch(query);
  };

  // Setzt den Screen auf den Ausgangszustand zurück — Eingabe, Suchbegriff,
  // Treffer und Meldungen. Der Cache auf der Platte bleibt bewusst bestehen.
  const handleZuruecksetzen = () => {
    setText('');
    setSearchTerm(null);
    setResults(null);
    setCacheNote(null);
    setError(null);
  };

  const hasSomethingToClear =
    text.length > 0 ||
    searchTerm !== null ||
    results !== null ||
    error !== null ||
    cacheNote !== null;

  const best = results ? pickBestMatch(results) : null;
  const others = results?.filter(r => r !== best) ?? [];

  let status = 'Modell wird geladen…';
  if (isGenerating) {
    status = 'Suchbegriff wird bestimmt…';
  } else if (isSearching) {
    status = 'Preise werden abgefragt…';
  } else if (isReady) {
    status = 'Modell bereit.';
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Preise vergleichen</Text>
      <Text style={styles.status}>{status}</Text>

      <Text style={styles.label}>Produkt beschreiben:</Text>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="z.B. kabellose Sony Kopfhörer xm5"
        placeholderTextColor={colors.placeholder}
        multiline
      />

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <Button
            title="Preis suchen"
            onPress={handleSuchen}
            disabled={text.trim().length === 0 || isGenerating || isSearching}
          />
        </View>
        <View style={styles.buttonWrapper}>
          <Button
            title="Zurücksetzen"
            onPress={handleZuruecksetzen}
            disabled={!hasSomethingToClear || isGenerating || isSearching}
          />
        </View>
      </View>

      {searchTerm !== null && (
        <>
          <Text style={styles.label}>Gesuchter Begriff (editierbar):</Text>
          <TextInput
            style={styles.input}
            value={searchTerm}
            onChangeText={setSearchTerm}
            placeholderTextColor={colors.placeholder}
          />
          <View style={styles.buttonRow}>
            <View style={styles.buttonWrapper}>
              <Button
                title="Erneut suchen"
                onPress={() => runSearch(searchTerm)}
                disabled={searchTerm.trim().length === 0 || isSearching}
              />
            </View>
          </View>
        </>
      )}

      {error !== null && <Text style={styles.errorText}>{error}</Text>}

      {cacheNote !== null && (
        <View style={[styles.warningBox, { borderColor: CAUTION_COLOR }]}>
          <Text style={[styles.warningText, { color: CAUTION_COLOR }]}>
            {cacheNote}
          </Text>
        </View>
      )}

      {results !== null && results.length === 0 && (
        <Text style={styles.status}>
          Keine Treffer auf toppreise.ch für „{searchTerm}“.
        </Text>
      )}

      {best !== null && (
        <>
          <Text style={styles.label}>Günstigstes Angebot:</Text>
          {!best.matchedAllTokens && (
            <Text style={styles.needsInputHint}>
              Unsicherer Treffer — der Produktname enthält nicht alle
              Suchbegriffe. Bitte prüfen.
            </Text>
          )}
          <View
            style={[
              styles.priceCard,
              !best.matchedAllTokens && styles.lowConfidenceBorder,
            ]}
          >
            <Text style={styles.priceHero}>
              {best.currency} {best.price.toFixed(2)}
            </Text>
            <Text style={styles.lineItemDescription}>{best.productName}</Text>
            <Text style={styles.lineItemMeta}>
              {best.offerCount !== null
                ? `günstigstes von ${best.offerCount} Angeboten`
                : 'günstigstes Angebot'}
              {best.priceInclShipping !== null &&
                ` · inkl. Versand ${
                  best.currency
                } ${best.priceInclShipping.toFixed(2)}`}
            </Text>
            <Text style={styles.link} onPress={() => Linking.openURL(best.url)}>
              Auf toppreise.ch öffnen
            </Text>
          </View>

          {others.length > 0 && (
            <>
              <Text style={styles.label}>Weitere Treffer:</Text>
              {others.slice(0, 6).map(result => (
                <View key={result.productId} style={styles.lineItemRow}>
                  <Text style={styles.lineItemDescription}>
                    {result.currency} {result.price.toFixed(2)}
                  </Text>
                  <Text style={styles.lineItemMeta}>{result.productName}</Text>
                </View>
              ))}
            </>
          )}

          <Text style={styles.sourceNote}>
            Preise von toppreise.ch, abgerufen am{' '}
            {formatDateDMY(best.timestamp.slice(0, 10))}. Die Preise stammen
            direkt von der Website — nicht von der KI. Die KI hat nur den
            Suchbegriff formuliert.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

function LlmTestScreen({ model }: { model: UseModelResult }) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const { isReady, isGenerating, downloadProgress, error, generate, reset } =
    model;
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [response, setResponse] = useState<string | null>(null);

  const runTest = async () => {
    setResponse(null);
    try {
      // Jeder Testlauf ist ein unabhängiger Einzel-Prompt (kein Chat) — ohne
      // Reset würde er an die Historie vorheriger Läufe/Screens anhängen.
      reset();
      const result = await generate(prompt);
      console.log('[litert-lm] Antwort:', result);
      setResponse(result);
    } catch (e) {
      console.error('[litert-lm] Fehler bei der Inferenz:', e);
    }
  };

  const clear = () => {
    setPrompt('');
    setResponse(null);
  };

  let status = 'Modell wird geladen…';
  if (error) status = `Fehler beim Laden: ${error}`;
  else if (isReady) status = 'Modell bereit.';
  else if (downloadProgress > 0) status = 'Lade Modell…';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>LiteRT-LM Test — Gemma 4 E2B-it</Text>
      <Text style={styles.status}>{status}</Text>
      {!isReady && downloadProgress > 0 && <DownloadProgressBar progress={downloadProgress} />}

      <Text style={styles.label}>Prompt:</Text>
      <TextInput
        style={styles.input}
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder="Prompt eingeben…"
        placeholderTextColor={colors.placeholder}
      />

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <Button
            title={isGenerating ? 'Läuft…' : 'Test ausführen'}
            onPress={runTest}
            disabled={!isReady || isGenerating || prompt.trim().length === 0}
          />
        </View>
        <View style={styles.buttonWrapper}>
          <Button
            title="Zurücksetzen"
            onPress={clear}
            disabled={
              isGenerating || (prompt.length === 0 && response === null)
            }
          />
        </View>
      </View>

      <Text style={styles.label}>Antwort:</Text>
      <Text style={styles.response}>{response ?? '—'}</Text>
    </ScrollView>
  );
}

// Theme-Farben für Dark Mode — vorher wurde `isDarkMode` nur für die
// StatusBar-Icons genutzt, alle Text-/Rahmenfarben waren fest auf helle
// Werte codiert (z.B. dunkelgraue Schrift ohne gesetzten Hintergrund),
// dadurch auf einem dunklen System-Theme kaum lesbar (bestätigt auf echtem
// Android-Gerät). `getStyles()` wird jetzt in jeder Screen-Komponente über
// `useThemeColors()` neu berechnet, sobald sich `useColorScheme()` ändert.
function useThemeColors() {
  const isDarkMode = useColorScheme() === 'dark';
  return useMemo(
    () => ({
      isDarkMode,
      background: isDarkMode ? '#121212' : '#fff',
      text: isDarkMode ? '#f2f2f2' : '#111',
      textMuted: isDarkMode ? '#aaaaaa' : '#666',
      textSubtle: isDarkMode ? '#bbbbbb' : '#555',
      chipText: isDarkMode ? '#e5e5e5' : '#333',
      border: isDarkMode ? '#555' : '#ccc',
      borderSubtle: isDarkMode ? '#333' : '#eee',
      inputBackground: isDarkMode ? '#1e1e1e' : '#fff',
      previewBackground: isDarkMode ? '#1e1e1e' : '#f2f2f2',
      placeholder: isDarkMode ? '#888' : '#999',
    }),
    [isDarkMode],
  );
}

function getStyles(colors: ReturnType<typeof useThemeColors>) {
  return StyleSheet.create({
    appContainer: {
      flex: 1,
      backgroundColor: colors.background,
    },
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    // Vollflächiger Platzhalter, solange die DB öffnet bzw. wenn sie ausfällt.
    dbGate: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    // Schreibfehler nach dem Start: die App bleibt benutzbar, der Hinweis
    // sitzt aber über allen Screens, damit er nicht übersehen wird.
    dbBanner: {
      fontSize: 13,
      color: '#fff',
      backgroundColor: DANGER_COLOR,
      paddingHorizontal: 20,
      paddingVertical: 8,
    },
    tabBar: {
      // flexGrow: 0 — sonst füllt die horizontale ScrollView die ganze Höhe.
      flexGrow: 0,
      flexShrink: 0,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderSubtle,
    },
    tabBarContent: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingBottom: 12,
    },
    tabButton: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 16,
      marginRight: 8,
    },
    tabButtonActive: {
      backgroundColor: '#2563eb',
    },
    tabText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textSubtle,
    },
    tabTextActive: {
      color: '#fff',
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      marginBottom: 8,
      color: colors.text,
    },
    status: {
      fontSize: 14,
      color: colors.textMuted,
      marginBottom: 16,
    },
    receiptPreview: {
      width: '100%',
      height: 260,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 16,
      backgroundColor: colors.previewBackground,
    },
    progressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: -8,
      marginBottom: 16,
    },
    progressTrack: {
      flex: 1,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.borderSubtle,
      overflow: 'hidden',
    },
    progressLabel: {
      fontSize: 12,
      color: colors.textMuted,
      marginLeft: 8,
      minWidth: 34,
      textAlign: 'right',
    },
    progressFill: {
      height: '100%',
      borderRadius: 4,
      backgroundColor: '#2563eb',
    },
    buttonRow: {
      flexDirection: 'row',
      marginTop: 16,
      marginBottom: 24,
    },
    buttonWrapper: {
      marginRight: 12,
    },
    label: {
      fontSize: 13,
      fontWeight: '600',
      marginTop: 12,
      color: colors.text,
    },
    input: {
      fontSize: 14,
      marginTop: 4,
      minHeight: 44,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      padding: 8,
      textAlignVertical: 'top',
      color: colors.text,
      backgroundColor: colors.inputBackground,
    },
    response: {
      fontSize: 14,
      marginTop: 4,
      color: colors.text,
    },
    errorText: {
      fontSize: 13,
      color: DANGER_COLOR,
      marginTop: 8,
    },
    lowConfidenceBorder: {
      borderColor: CAUTION_COLOR,
      borderWidth: 2,
    },
    needsInputBorder: {
      borderColor: DANGER_COLOR,
      borderWidth: 2,
    },
    needsInputHint: {
      fontSize: 12,
      color: DANGER_COLOR,
      marginTop: 4,
    },
    warningBox: {
      borderWidth: 2,
      borderRadius: 6,
      padding: 10,
      marginTop: 8,
    },
    warningText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.text,
    },
    lineItemRow: {
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      borderRadius: 6,
      padding: 8,
      marginTop: 4,
    },
    priceCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: 12,
      marginTop: 8,
    },
    priceHero: {
      fontSize: 28,
      fontWeight: '700',
      color: colors.text,
      marginBottom: 4,
    },
    link: {
      fontSize: 13,
      color: colors.isDarkMode ? '#60a5fa' : '#2563eb',
      fontWeight: '600',
      marginTop: 8,
    },
    sourceNote: {
      fontSize: 11,
      color: colors.textMuted,
      marginTop: 16,
      lineHeight: 15,
    },
    lineItemDescription: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text,
    },
    lineItemMeta: {
      fontSize: 12,
      color: colors.textMuted,
      marginTop: 2,
    },
    segmentRow: {
      flexDirection: 'row',
      marginTop: 4,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      overflow: 'hidden',
    },
    segmentButton: {
      flex: 1,
      paddingVertical: 10,
      alignItems: 'center',
    },
    segmentButtonActive: {
      backgroundColor: '#2563eb',
    },
    segmentText: {
      fontSize: 14,
      color: colors.chipText,
    },
    segmentTextActive: {
      color: '#fff',
      fontWeight: '600',
    },
    chipContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 4,
      padding: 4,
      borderWidth: 1,
      borderColor: 'transparent',
      borderRadius: 6,
    },
    chip: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      marginRight: 8,
      marginBottom: 8,
    },
    chipSelected: {
      backgroundColor: '#2563eb',
      borderColor: '#2563eb',
    },
    chipText: {
      fontSize: 13,
      color: colors.chipText,
    },
    chipTextSelected: {
      color: '#fff',
      fontWeight: '600',
    },
  });
}

export default App;
