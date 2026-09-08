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

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
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
  GOLDEN_SET,
  compareToExpected,
  type GoldenSetCase,
  type GoldenSetComparison,
} from './goldenSet';
import {
  addLineItems,
  deleteLineItem,
  getMonth,
  incomeToCents,
  incomeToChf,
  initDatabase,
  kindFromCadence,
  listLineItems,
  monthOfDate,
  parseChf,
  setIncomeCents,
  toNewLineItem,
  toUiLineItem,
  updateLineItem,
  type LineItemPatch,
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
// Zeitfenster für "Rückgängig" nach Löschen/Neue-Quittung-Bestätigen — siehe
// App()s triggerUndo(). Dateibasierte Nebenwirkungen (Foto löschen/ersetzen)
// werden bis zum Ablauf aufgeschoben, damit ein Rückgängig-Machen wirklich
// alles wiederherstellen kann.
const UNDO_WINDOW_MS = 10000;

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

// Aufräum-Hilfsfunktionen für Beleg-Fotos in RNFS.DocumentDirectoryPath —
// dieser Ordner wird von Android/iOS NICHT automatisch bereinigt (bewusst,
// siehe CLAUDE.md Lessons Learned zum CachesDirectoryPath-Bug).
//
// Zwei getrennte Namensräume mit unterschiedlicher Lebensdauer:
// - "beleg-scan-…": ein frisch gescanntes/hochgeladenes Foto, bevor der
//   Entwurf bestätigt wurde — reiner Zwischenstand, wird beim Bestätigen zum
//   stabilen Dateinamen befördert (siehe processBelegUri/handleBestaetigen)
//   oder beim Verwerfen gelöscht. Nur DIESER Namensraum wird von den
//   Aufräum-Funktionen unten angefasst.
// - "beleg-item-<id>.jpg": das dauerhafte Beleg-Foto eines bereits
//   bestätigten Postens (LineItem.photoFilename) — bleibt erhalten, bis eine
//   neue Quittung gescannt wird (ersetzt die Datei unter demselben Namen)
//   oder der Posten gelöscht wird. Absichtlich ausserhalb der
//   Aufräum-Funktionen, sonst würde z.B. das 24h-Sicherheitsnetz irgendwann
//   echte, noch verknüpfte Beleg-Fotos löschen.
const BELEG_TEMP_PREFIX = 'beleg-scan-';

function stableBelegFilename(itemId: string): string {
  return `beleg-item-${itemId}.jpg`;
}

async function listTempBelegFiles() {
  try {
    const entries = await RNFS.readDir(RNFS.DocumentDirectoryPath);
    return entries.filter(entry => entry.isFile() && entry.name.startsWith(BELEG_TEMP_PREFIX));
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

// Vor jedem neuen Scan alle bisherigen Zwischenstände löschen: pro Zeitpunkt
// ist immer nur ein Entwurf aktiv (siehe CLAUDE.md Status, "bewusst ohne
// Persistenz"), eine übrig gebliebene ältere Temp-Datei kann also nur von
// einem vorherigen Absturz/Fast-Refresh-Reload stammen.
async function cleanupTempBelegFiles(): Promise<void> {
  const files = await listTempBelegFiles();
  await Promise.all(files.map(file => deleteBelegFile(file.path)));
}

// Sicherheitsnetz beim App-Start (siehe App()): fängt Temp-Datei-Leichen ab,
// falls das Löschen beim Verwerfen/Bestätigen mal durch einen Absturz
// übersprungen wurde. Betrifft NICHT die dauerhaften Beleg-Fotos bestätigter
// Posten (siehe Kommentar oben) — die haben kein Alterslimit.
async function cleanupOldTempBelegFiles(maxAgeMs: number): Promise<void> {
  const files = await listTempBelegFiles();
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

type Screen = 'expense' | 'budget' | 'calendar' | 'price' | 'llmTest' | 'settings';

// Testweiser Dark-Mode-Umschalter (Settings-Tab) — überschreibt das
// System-Theme, ohne useColorScheme() selbst zu verändern (nicht möglich).
// Der State lebt in App() (Quelle der Wahrheit, siehe dort), Nachfahren
// lesen ihn per Context statt per Prop-Drilling durch jede Screen-Komponente
// — useThemeColors() wird bereits unabhängig von jeder Komponente aufgerufen.
// Bewusst nicht persistiert: reiner Test-/Debug-Schalter für diesen PoC, kein
// echtes Nutzer-Setting.
const DarkModeOverrideContext = createContext<{
  isDarkMode: boolean;
  setIsDarkMode: (value: boolean) => void;
} | null>(null);

// Ein offenes "Rückgängig"-Banner — siehe App()s triggerUndo(). `key` sorgt
// für einen sauberen Remount von UndoSnackbar (frischer Timer/Animation) bei
// jedem neuen Aufruf, auch wenn kurz hintereinander zwei Undo-fähige
// Aktionen passieren.
type UndoState = {
  key: number;
  message: string;
  onUndo: () => void;
  onExpire: () => void;
};

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
  const [income, setIncome] = useState<number | null>(null);
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

  // Sicherheitsnetz: fängt liegen gebliebene Scan-Zwischenstände ab, falls
  // das Löschen beim Verwerfen/Bestätigen mal durch einen Absturz oder
  // Fast-Refresh-Reload übersprungen wurde (siehe cleanupOldTempBelegFiles).
  // Betrifft nicht die dauerhaften Beleg-Fotos bestätigter Posten.
  useEffect(() => {
    cleanupOldTempBelegFiles(24 * 60 * 60 * 1000);
  }, []);

  const darkModeOverrideValue = useMemo(
    () => ({ isDarkMode: darkModeOverride, setIsDarkMode: setDarkModeOverride }),
    [darkModeOverride],
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
              income={income}
              onChangeIncome={changeIncome}
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

// Ersetzt die native RN-<Button>, die sich visuell nicht anpassen lässt
// (kein Padding/Radius/Schatten, sieht auf jeder Plattform nach
// Standard-OS-Steuerelement statt nach eigener App aus) — reines Styling,
// identische Props/Verhalten (title/onPress/disabled) wie vorher.
function AppButton({
  title,
  onPress,
  disabled,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const variantStyle =
    variant === 'primary'
      ? styles.appButtonPrimary
      : variant === 'danger'
        ? styles.appButtonDanger
        : styles.appButtonSecondary;
  const textStyle =
    variant === 'primary'
      ? styles.appButtonPrimaryText
      : variant === 'danger'
        ? styles.appButtonDangerText
        : styles.appButtonSecondaryText;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.appButtonBase,
        variantStyle,
        disabled ? styles.appButtonDisabled : pressed && styles.appButtonPressed,
      ]}
    >
      <Text style={[styles.appButtonText, textStyle]}>{title}</Text>
    </Pressable>
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
    { key: 'settings', label: 'Einstellungen' },
  ];

  // Schmaler, farbiger Scroll-Indikator unter der Tab-Leiste (eigenes,
  // schlichteres Pendant zu showsHorizontalScrollIndicator — der native
  // Indikator ist zu unauffällig/grau und blendet meist gleich wieder aus).
  // Signalisiert neuen Nutzern, dass hier mehr als die sichtbaren Tabs
  // liegen und wandert proportional zur Scroll-Position mit.
  const scrollX = useRef(new Animated.Value(0)).current;
  const [contentWidth, setContentWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const showScrollThumb = contentWidth > viewportWidth && viewportWidth > 0;
  const thumbWidth = showScrollThumb
    ? Math.max(28, (viewportWidth / contentWidth) * viewportWidth)
    : 0;
  const maxScrollX = Math.max(contentWidth - viewportWidth, 1);
  const maxThumbTravel = Math.max(viewportWidth - thumbWidth, 0);
  const thumbTranslate = scrollX.interpolate({
    inputRange: [0, maxScrollX],
    outputRange: [0, maxThumbTravel],
    extrapolate: 'clamp',
  });

  // Horizontal scrollbar: ab 5 Tabs passen die Labels nicht mehr auf ein
  // iPhone — vorher wurde "LLM-Test" am rechten Rand abgeschnitten.
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        onLayout={e => setViewportWidth(e.nativeEvent.layout.width)}
        onContentSizeChange={w => setContentWidth(w)}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: false },
        )}
        scrollEventThrottle={16}
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
      {showScrollThumb && (
        <View style={styles.tabScrollTrack}>
          <Animated.View
            style={[
              styles.tabScrollThumb,
              { width: thumbWidth, transform: [{ translateX: thumbTranslate }] },
            ]}
          />
        </View>
      )}
    </View>
  );
}

function ExpenseFlow({
  model,
  items,
  onConfirmItem,
  onUpdateItem,
  onDeleteItem,
  triggerUndo,
  prefilledDate,
  onPrefilledDateConsumed,
  itemToEdit,
  onItemEditConsumed,
}: {
  model: UseModelResult;
  items: LineItem[];
  onConfirmItem: (item: LineItem) => void;
  onUpdateItem: (id: string, patch: Partial<LineItem>) => void;
  onDeleteItem: (item: LineItem) => void;
  triggerUndo: (
    message: string,
    handlers: { onUndo: () => void; onExpire: () => void },
  ) => void;
  prefilledDate: string | null;
  onPrefilledDateConsumed: () => void;
  itemToEdit: LineItem | null;
  onItemEditConsumed: () => void;
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
  // Pfad (nicht file://-URI) einer frisch gescannten, noch nicht bestätigten
  // Beleg-Kopie unter dem "beleg-scan-…"-Namen — null, solange draftPhotoUri
  // (falls gesetzt) nur das bereits gespeicherte Foto eines bearbeiteten
  // Postens zeigt. Entscheidet in handleVerwerfen, ob überhaupt eine
  // Temp-Datei zu löschen ist (das dauerhafte Foto eines Postens darf beim
  // blossen Verwerfen nie gelöscht werden, siehe dort), und in
  // handleBestaetigen, ob ein neues Foto zum stabilen Dateinamen befördert
  // werden muss.
  const [pendingPhotoTempPath, setPendingPhotoTempPath] = useState<string | null>(null);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Der komplette Original-Posten, solange der Entwurf-Screen ihn bearbeitet
  // statt einen neuen zu erfassen — liefert id/photoFilename/
  // manuallyEditedFields als Ausgangspunkt für handleBestaetigen. null bei
  // einer neuen Erfassung.
  const [editingItem, setEditingItem] = useState<LineItem | null>(null);
  // Erzwingt einen Remount von DraftScreen (siehe key={draftVersion} unten),
  // damit dessen lokaler State (TextInput-Werte) neu aus draft/initialDate
  // initialisiert wird — auch wenn man auf demselben Screen bleibt, z.B.
  // nach "Neue Quittung" während einer Bearbeitung.
  const [draftVersion, setDraftVersion] = useState(0);
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
      setDraftVersion(v => v + 1);
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
      // Alte Scan-Zwischenstände zuerst löschen (siehe cleanupTempBelegFiles)
      // — sonst sammeln sich in DocumentDirectoryPath unbegrenzt Dateien an,
      // da dieser Ordner (bewusst, anders als CachesDirectoryPath) nicht vom
      // OS automatisch bereinigt wird. Betrifft nur den "beleg-scan-…"-Namensraum,
      // nicht die dauerhaften Beleg-Fotos bereits bestätigter Posten.
      await cleanupTempBelegFiles();
      const tempPath = `${RNFS.DocumentDirectoryPath}/${BELEG_TEMP_PREFIX}${Date.now()}.jpg`;
      await RNFS.copyFile(uri.replace('file://', ''), tempPath);
      const tempUri = `file://${tempPath}`;

      const ocrText = await recognizeReceiptText(tempUri);
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
      // Beim erneuten Scannen während einer Bearbeitung (siehe "Neue
      // Quittung" in DraftScreen) bleibt das Kaufdatum des bearbeiteten
      // Postens erhalten, statt es auf heute/prefilledDate zurückzusetzen —
      // hier geht es nur darum, die falsche Quittung zu ersetzen, nicht um
      // ein neues Datum.
      if (editingItem) {
        // Neue Quittung = neue Baseline: eine vorher persistierte
        // "(manuell geändert)"-Markierung bezog sich auf die ALTE
        // KI-Extraktion und gilt gegenüber dieser neuen nicht mehr (siehe
        // persistedManuallyEditedFields in DraftScreen).
        setEditingItem({ ...editingItem, manuallyEditedFields: [] });
      } else {
        setDraftInitialDate(prefilledDate ?? todayIso());
        onPrefilledDateConsumed();
      }
      setDraftSource('photo');
      setDraftPhotoUri(tempUri);
      setPendingPhotoTempPath(tempPath);
      setDraftVersion(v => v + 1);
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
    // Nur eine frisch gescannte, noch nicht bestätigte Temp-Datei löschen —
    // das dauerhafte Beleg-Foto eines bearbeiteten Postens (falls
    // draftPhotoUri darauf zeigt) bleibt beim blossen Verwerfen unangetastet.
    if (pendingPhotoTempPath) {
      deleteBelegFile(pendingPhotoTempPath);
    }
    setDraft(null);
    setDraftPhotoUri(null);
    setPendingPhotoTempPath(null);
    setEditingItem(null);
    setStep('entry');
  };

  // Löscht den gerade bearbeiteten Posten unwiderruflich — nur im
  // Bearbeiten-Modus erreichbar (siehe DraftScreen), daher kein Check auf
  // editingItem !== null hier nötig, der Button existiert sonst nicht.
  const handleLoeschen = () => {
    if (!editingItem) {
      return;
    }
    Alert.alert(
      'Posten löschen',
      `"${editingItem.description}" wirklich unwiderruflich löschen?`,
      [
        { text: 'Abbrechen', style: 'cancel' },
        {
          text: 'Löschen',
          style: 'destructive',
          onPress: () => {
            // Ein evtl. frisch gescannter, noch nicht bestätigter
            // Zwischenstand gehört nicht zum gelöschten Posten und wird
            // separat aufgeräumt, statt verwaist liegen zu bleiben.
            if (pendingPhotoTempPath) {
              deleteBelegFile(pendingPhotoTempPath);
            }
            onDeleteItem(editingItem);
            setDraft(null);
            setDraftPhotoUri(null);
            setPendingPhotoTempPath(null);
            setEditingItem(null);
            setStep('entry');
          },
        },
      ],
    );
  };

  const handleBestaetigen = async (
    finalDraft: Draft,
    date: string,
    changedFieldsThisSession: string[],
  ) => {
    const id = editingItem?.id ?? createId();
    // Union statt Ersetzen: ein Feld, das in einer früheren Session schon
    // manuell geändert wurde, bleibt markiert, auch wenn es diesmal nicht
    // angefasst wurde.
    const manuallyEditedFields = Array.from(
      new Set([...(editingItem?.manuallyEditedFields ?? []), ...changedFieldsThisSession]),
    );

    // Frisch gescanntes Foto zum dauerhaften, postenspezifischen Dateinamen
    // befördern — ersetzt dabei ein evtl. vorhandenes altes Foto desselben
    // Postens (identischer Dateiname, siehe stableBelegFilename), da "Neue
    // Quittung" die alte Quittung ersetzen soll, nicht danebenlegen. Ein
    // vorhandenes altes Foto wird dabei bewusst nicht sofort gelöscht,
    // sondern nur beiseitegelegt (Endung ".undo") — erst wenn das
    // Undo-Fenster unten abläuft, wird es endgültig entfernt. So kann
    // "Rückgängig" das alte Foto wiederherstellen.
    let photoFilename = editingItem?.photoFilename ?? null;
    let restoreOldPhoto: (() => Promise<void>) | null = null;
    let discardOldPhotoBackup: (() => Promise<void>) | null = null;
    if (pendingPhotoTempPath) {
      const stableName = stableBelegFilename(id);
      const stablePath = `${RNFS.DocumentDirectoryPath}/${stableName}`;
      const backupPath = `${stablePath}.undo`;
      const hadOldPhoto = editingItem?.photoFilename != null;
      try {
        if (hadOldPhoto) {
          await deleteBelegFile(backupPath); // Rest eines abgelaufenen, älteren Undo-Fensters
          await RNFS.moveFile(stablePath, backupPath);
        } else {
          await deleteBelegFile(stablePath);
        }
        await RNFS.moveFile(pendingPhotoTempPath, stablePath);
        photoFilename = stableName;
        if (hadOldPhoto) {
          restoreOldPhoto = async () => {
            await deleteBelegFile(stablePath);
            await RNFS.moveFile(backupPath, stablePath);
          };
          discardOldPhotoBackup = async () => {
            await deleteBelegFile(backupPath);
          };
        } else {
          // Vorher gab es kein Foto — bei "Rückgängig" das gerade erst
          // abgelegte neue Foto wieder entfernen, statt es verwaist liegen
          // zu lassen (die DB zeigt nach dem Undo wieder photoFilename=null).
          restoreOldPhoto = async () => {
            await deleteBelegFile(stablePath);
          };
        }
      } catch (e) {
        console.error('[expense] Beleg-Foto konnte nicht übernommen werden:', e);
      }
    }

    if (editingItem) {
      const previousItem = editingItem;
      onUpdateItem(editingItem.id, {
        description: finalDraft.description,
        amount: finalDraft.amount,
        currency: finalDraft.currency,
        cadence: finalDraft.cadence,
        category: finalDraft.category,
        date,
        photoFilename,
        manuallyEditedFields,
      });
      // Undo nur anbieten, wenn wirklich neu gescannt wurde — eine reine
      // Text-/Betrags-Korrektur ohne "Neue Quittung" bekommt kein Banner.
      if (pendingPhotoTempPath) {
        triggerUndo('Neue Quittung übernommen', {
          onUndo: () => {
            onUpdateItem(previousItem.id, {
              description: previousItem.description,
              amount: previousItem.amount,
              currency: previousItem.currency,
              cadence: previousItem.cadence,
              category: previousItem.category,
              date: previousItem.date,
              photoFilename: previousItem.photoFilename,
              manuallyEditedFields: previousItem.manuallyEditedFields,
            });
            restoreOldPhoto?.();
          },
          onExpire: () => {
            discardOldPhotoBackup?.();
          },
        });
      }
    } else {
      const item: LineItem = {
        id,
        description: finalDraft.description,
        amount: finalDraft.amount,
        currency: finalDraft.currency,
        cadence: finalDraft.cadence,
        category: finalDraft.category,
        source: draftSource,
        confidence: finalDraft.confidence,
        notes: finalDraft.reason,
        date,
        photoFilename,
        manuallyEditedFields,
      };
      console.log('[expense] Bestätigt:', item);
      onConfirmItem(item);
    }
    setDraft(null);
    setDraftPhotoUri(null);
    setPendingPhotoTempPath(null);
    setEditingItem(null);
    setText('');
    setStep('entry');
  };

  // Öffnet einen bereits bestätigten Posten wieder im Entwurf-Screen — z.B.
  // wenn beim Foto-Erfassen die falsche Quittung ausgewählt wurde. Zeigt das
  // dauerhaft gespeicherte Beleg-Foto des Postens (falls vorhanden) direkt an
  // — ersetzt wird es erst, wenn im Entwurf-Screen "Neue Quittung" ausgeführt
  // wird (siehe processBelegUri/handleBestaetigen).
  const beginEditItem = (item: LineItem) => {
    setDraft({
      description: item.description,
      amount: item.amount,
      currency: item.currency,
      cadence: item.cadence,
      category: item.category,
      confidence: item.confidence,
      reason: item.notes,
    });
    setDraftInitialDate(item.date);
    setDraftSource(item.source);
    setDraftPhotoUri(
      item.photoFilename
        ? `file://${RNFS.DocumentDirectoryPath}/${item.photoFilename}`
        : null,
    );
    setPendingPhotoTempPath(null);
    setEditingItem(item);
    setDraftVersion(v => v + 1);
    setStep('draft');
  };

  // Kommt vom Budget-Tab (siehe itemToEdit/onItemEditConsumed in App()) —
  // der Kalender-Tag-Detail-Fall ruft beginEditItem direkt auf, da man dort
  // schon auf diesem Screen ist.
  useEffect(() => {
    if (itemToEdit) {
      beginEditItem(itemToEdit);
      onItemEditConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemToEdit]);

  if (step === 'draft' && draft) {
    return (
      <DraftScreen
        key={draftVersion}
        draft={draft}
        initialDate={draftInitialDate}
        photoUri={draftPhotoUri}
        isEditing={editingItem !== null}
        persistedManuallyEditedFields={editingItem?.manuallyEditedFields ?? []}
        isProcessingPhoto={isProcessingPhoto}
        onRescan={handleFoto}
        onConfirm={handleBestaetigen}
        onDiscard={handleVerwerfen}
        onDelete={handleLoeschen}
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
      onEditItem={beginEditItem}
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
  onEditItem,
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
  onEditItem: (item: LineItem) => void;
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
          <Text style={[styles.label, { textTransform: 'none', letterSpacing: 0 }]}>
            Bereits erfasst für {formatDateDMY(prefilledDate as string)} (antippen zum
            Bearbeiten):
          </Text>
          {existingItemsForDate.map(item => (
            <Pressable
              key={item.id}
              style={styles.lineItemRow}
              onPress={() => onEditItem(item)}
            >
              <Text style={styles.lineItemDescription}>{item.description}</Text>
              <Text style={styles.lineItemMeta}>
                {item.amount !== null
                  ? `${item.amount.toFixed(2)} ${item.currency}`
                  : '—'}{' '}
                · {item.category ?? 'Sonstiges'} ·{' '}
                {item.cadence === 'monthly' ? 'Fixkosten' : 'Einmalig'}
              </Text>
            </Pressable>
          ))}
        </>
      )}

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <AppButton
            title={isBusy ? 'Analysiere…' : 'Weiter'}
            onPress={onWeiter}
            disabled={!isReady || isBusy || text.trim().length === 0}
          />
        </View>
        <View style={styles.buttonWrapper}>
          <AppButton
            title={isBusy ? 'Analysiere…' : '📷 Beleg fotografieren'}
            onPress={onFoto}
            disabled={!isReady || isBusy}
            variant="secondary"
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
  isEditing,
  persistedManuallyEditedFields,
  isProcessingPhoto,
  onRescan,
  onConfirm,
  onDiscard,
  onDelete,
}: {
  draft: Draft;
  initialDate: string;
  photoUri: string | null;
  isEditing: boolean;
  persistedManuallyEditedFields: string[];
  isProcessingPhoto: boolean;
  onRescan: () => void;
  onConfirm: (d: Draft, date: string, changedFields: string[]) => void;
  onDiscard: () => void;
  onDelete: () => void;
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

  // Vergleich gegen die KI-Extraktion (draft/initialDate) dieser Session —
  // zeigt sofort "(manuell geändert)", sobald der User ein Feld anfasst,
  // statt erst nach dem Bestätigen. Vereinigt mit den aus einer früheren
  // Session schon persistierten Feldern (persistedManuallyEditedFields), da
  // ein nicht erneut angefasstes Feld seine Markierung behalten soll.
  const changedFieldsThisSession = useMemo(() => {
    const changed: string[] = [];
    if (description.trim() !== draft.description) {
      changed.push('description');
    }
    if (parsedAmount !== draft.amount) {
      changed.push('amount');
    }
    if ((currency.trim() || 'CHF') !== draft.currency) {
      changed.push('currency');
    }
    if (cadence !== draft.cadence) {
      changed.push('cadence');
    }
    if (category !== draft.category) {
      changed.push('category');
    }
    if (dateText !== formatDateDMY(initialDate)) {
      changed.push('date');
    }
    return changed;
  }, [description, parsedAmount, currency, cadence, category, dateText, draft, initialDate]);

  const effectiveManuallyEditedFields = useMemo(
    () =>
      Array.from(new Set([...persistedManuallyEditedFields, ...changedFieldsThisSession])),
    [persistedManuallyEditedFields, changedFieldsThisSession],
  );

  const fieldLabel = (text: string, field: string) => (
    <Text style={styles.label}>
      {text}
      {effectiveManuallyEditedFields.includes(field) && (
        <Text style={styles.manualEditBadge}> (manuell geändert)</Text>
      )}
    </Text>
  );

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>
        {isEditing ? 'Entwurf bearbeiten' : 'Entwurf bestätigen'}
      </Text>
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

      {isEditing && (
        <View style={styles.buttonRow}>
          <View style={styles.buttonWrapper}>
            <AppButton
              title={isProcessingPhoto ? 'Analysiere…' : '📷 Neue Quittung'}
              onPress={onRescan}
              disabled={isProcessingPhoto}
              variant="secondary"
            />
          </View>
        </View>
      )}

      {fieldLabel('Beschreibung', 'description')}
      <TextInput
        style={fieldStyle(false)}
        value={description}
        onChangeText={setDescription}
        placeholder="Beschreibung"
        placeholderTextColor={colors.placeholder}
      />

      {fieldLabel('Betrag', 'amount')}
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

      {fieldLabel('Währung', 'currency')}
      <TextInput
        style={styles.input}
        value={currency}
        onChangeText={setCurrency}
        placeholder="CHF"
        placeholderTextColor={colors.placeholder}
      />

      {fieldLabel('Häufigkeit', 'cadence')}
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

      {fieldLabel('Kategorie', 'category')}
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

      {fieldLabel('Kaufdatum', 'date')}
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
          <AppButton
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
                changedFieldsThisSession,
              )
            }
          />
        </View>
        <View style={styles.buttonWrapper}>
          <AppButton title="Verwerfen" onPress={onDiscard} variant="secondary" />
        </View>
        {isEditing && (
          <View style={styles.buttonWrapper}>
            <AppButton title="Löschen" onPress={onDelete} variant="danger" />
          </View>
        )}
      </View>
    </ScrollView>
  );
}

function BudgetScreen({
  model,
  income,
  onChangeIncome,
  items,
  onEditItem,
}: {
  model: UseModelResult;
  income: number | null;
  onChangeIncome: (income: number | null) => void;
  items: LineItem[];
  onEditItem: (item: LineItem) => void;
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
        fixedCosts.map(item => (
          <LineItemRow key={item.id} item={item} onPress={() => onEditItem(item)} />
        ))
      )}

      <Text style={styles.label}>Geplante Käufe (einmalig)</Text>
      {plannedPurchases.length === 0 ? (
        <Text style={styles.status}>Noch keine erfasst.</Text>
      ) : (
        plannedPurchases.map(item => (
          <LineItemRow key={item.id} item={item} onPress={() => onEditItem(item)} />
        ))
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
              {
                borderLeftColor: isOverBudget ? DANGER_COLOR : CAUTION_COLOR,
                backgroundColor: isOverBudget
                  ? 'rgba(220,38,38,0.08)'
                  : 'rgba(245,158,11,0.08)',
              },
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
          <AppButton
            title={isExporting ? 'Exportiere…' : 'Als PDF exportieren'}
            onPress={handleExportPdf}
            disabled={isExporting}
          />
        </View>
      </View>
    </ScrollView>
  );
}

function LineItemRow({ item, onPress }: { item: LineItem; onPress: () => void }) {
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  return (
    <Pressable style={styles.lineItemRow} onPress={onPress}>
      <Text style={styles.lineItemDescription}>{item.description}</Text>
      <Text style={styles.lineItemMeta}>
        {item.amount !== null
          ? `${item.amount.toFixed(2)} ${item.currency}`
          : '—'}{' '}
        · {item.category ?? 'Sonstiges'}
      </Text>
    </Pressable>
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

// Banner unten am Bildschirmrand mit Countdown-Balken (7s, siehe
// UNDO_WINDOW_MS) — Antippen ruft onPress (App()s handleUndoPress) auf.
// Bewusst mit invertierten Theme-Farben (colors.text als Hintergrund,
// colors.background als Textfarbe) statt eigener Farb-Tokens — funktioniert
// dadurch automatisch in Hell- wie Dunkelmodus ohne weitere Fallunterscheidung.
function UndoSnackbar({
  message,
  durationMs,
  onPress,
}: {
  message: string;
  durationMs: number;
  onPress: () => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const animatedWidth = useRef(new Animated.Value(100)).current;

  useEffect(() => {
    Animated.timing(animatedWidth, {
      toValue: 0,
      duration: durationMs,
      useNativeDriver: false, // 'width' unterstützt keinen Native Driver
    }).start();
  }, [animatedWidth, durationMs]);

  return (
    <View style={[styles.undoBanner, { bottom: insets.bottom + 12 }]}>
      <Pressable style={styles.undoRow} onPress={onPress}>
        <Text style={styles.undoText} numberOfLines={1}>
          {message}
        </Text>
        <Text style={styles.undoAction}>Rückgängig</Text>
      </Pressable>
      <View style={styles.undoTrack}>
        <Animated.View
          style={[
            styles.undoFill,
            {
              width: animatedWidth.interpolate({
                inputRange: [0, 100],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      </View>
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
        marks[item.date] = { marked: true, dotColor: colors.accent };
      }
    }
    return marks;
  }, [items, colors.accent]);

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
          todayTextColor: colors.accent,
          arrowColor: colors.accent,
          dotColor: colors.accent,
          calendarBackground: colors.surface,
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
          <AppButton
            title="Preis suchen"
            onPress={handleSuchen}
            disabled={text.trim().length === 0 || isGenerating || isSearching}
          />
        </View>
        <View style={styles.buttonWrapper}>
          <AppButton
            title="Zurücksetzen"
            onPress={handleZuruecksetzen}
            disabled={!hasSomethingToClear || isGenerating || isSearching}
            variant="secondary"
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
              <AppButton
                title="Erneut suchen"
                onPress={() => runSearch(searchTerm)}
                disabled={searchTerm.trim().length === 0 || isSearching}
                variant="secondary"
              />
            </View>
          </View>
        </>
      )}

      {error !== null && <Text style={styles.errorText}>{error}</Text>}

      {cacheNote !== null && (
        <View
          style={[
            styles.warningBox,
            { borderLeftColor: CAUTION_COLOR, backgroundColor: 'rgba(245,158,11,0.08)' },
          ]}
        >
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

type GoldenRunResult = {
  case: GoldenSetCase;
  actual: Draft | null;
  comparison: GoldenSetComparison;
  // Zeit für reset() + generate() dieses einen Falls, in Millisekunden —
  // bisher gab es dafür nur ein Gefühl ("dauert teils über eine Minute auf
  // CPU"), keine echte Zahl (siehe CLAUDE.md Testplan). Auch bei einem
  // fehlgeschlagenen Fall gemessen (der Modellaufruf selbst lief ja noch,
  // nur das Parsen danach ist gescheitert) statt die Messung zu verwerfen.
  durationMs: number;
};

const FAILED_COMPARISON: GoldenSetComparison = {
  amountCorrect: false,
  categoryCorrect: false,
  cadenceCorrect: false,
  allCorrect: false,
};

function LlmTestScreen({ model }: { model: UseModelResult }) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const { isReady, isGenerating, downloadProgress, error, generate, reset } =
    model;
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [response, setResponse] = useState<string | null>(null);
  const [isRunningGoldenSet, setIsRunningGoldenSet] = useState(false);
  const [goldenSetProgress, setGoldenSetProgress] = useState(0);
  const [goldenResults, setGoldenResults] = useState<GoldenRunResult[] | null>(null);

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

  // Läuft alle GOLDEN_SET-Fälle nacheinander über denselben Extraktionspfad
  // wie der echte Freitext-Flow (buildExtractionPrompt), statt sie einzeln
  // von Hand einzutippen — siehe CLAUDE.md Testplan/Lessons Learned. Jeder
  // Fall bekommt ein eigenes try/catch, damit ein einzelner Parse-Fehler
  // nicht den ganzen Durchlauf abbricht und die restlichen Ergebnisse
  // verschluckt.
  const runGoldenSet = async () => {
    setIsRunningGoldenSet(true);
    setGoldenResults(null);
    const results: GoldenRunResult[] = [];
    for (let i = 0; i < GOLDEN_SET.length; i++) {
      const testCase = GOLDEN_SET[i];
      setGoldenSetProgress(i);
      const startedAt = Date.now();
      try {
        reset();
        const raw = await generate(buildExtractionPrompt(testCase.input));
        const actual = buildDraftFromRaw(extractJsonObject(raw));
        results.push({
          case: testCase,
          actual,
          comparison: compareToExpected(testCase.expected, actual),
          durationMs: Date.now() - startedAt,
        });
      } catch (e) {
        console.error(`[golden-set] Fall "${testCase.id}" fehlgeschlagen:`, e);
        results.push({
          case: testCase,
          actual: null,
          comparison: FAILED_COMPARISON,
          durationMs: Date.now() - startedAt,
        });
      }
    }
    setGoldenResults(results);
    setIsRunningGoldenSet(false);
  };

  const goldenSummary = useMemo(() => {
    if (!goldenResults) {
      return null;
    }
    const total = goldenResults.length;
    const count = (pick: (r: GoldenRunResult) => boolean) =>
      goldenResults.filter(pick).length;
    const durations = goldenResults.map(r => r.durationMs).sort((a, b) => a - b);
    const avgMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    return {
      total,
      allCorrect: count(r => r.comparison.allCorrect),
      amountCorrect: count(r => r.comparison.amountCorrect),
      categoryCorrect: count(r => r.comparison.categoryCorrect),
      cadenceCorrect: count(r => r.comparison.cadenceCorrect),
      avgMs,
      minMs: durations[0],
      maxMs: durations[durations.length - 1],
    };
  }, [goldenResults]);

  const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

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
          <AppButton
            title={isGenerating ? 'Läuft…' : 'Test ausführen'}
            onPress={runTest}
            disabled={!isReady || isGenerating || isRunningGoldenSet || prompt.trim().length === 0}
          />
        </View>
        <View style={styles.buttonWrapper}>
          <AppButton
            title="Zurücksetzen"
            onPress={clear}
            disabled={
              isGenerating || isRunningGoldenSet || (prompt.length === 0 && response === null)
            }
            variant="secondary"
          />
        </View>
      </View>

      <Text style={styles.label}>Antwort:</Text>
      <Text style={styles.response}>{response ?? '—'}</Text>

      <Text style={styles.title}>Golden Set</Text>
      <Text style={styles.status}>
        {GOLDEN_SET.length} Testfälle mit erwarteten Werten (Betrag, Kategorie, Häufigkeit) —
        siehe src/goldenSet.ts.
      </Text>

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <AppButton
            title={
              isRunningGoldenSet
                ? `Läuft… (${goldenSetProgress + 1}/${GOLDEN_SET.length})`
                : 'Golden Set ausführen'
            }
            onPress={runGoldenSet}
            disabled={!isReady || isGenerating || isRunningGoldenSet}
          />
        </View>
      </View>

      {goldenSummary && (
        <>
          <Text style={styles.label}>
            {goldenSummary.allCorrect}/{goldenSummary.total} komplett korrekt
          </Text>
          <Text style={styles.status}>
            Betrag: {goldenSummary.amountCorrect}/{goldenSummary.total} · Kategorie:{' '}
            {goldenSummary.categoryCorrect}/{goldenSummary.total} · Häufigkeit:{' '}
            {goldenSummary.cadenceCorrect}/{goldenSummary.total}
          </Text>
          <Text style={styles.status}>
            Antwortzeit: Ø {formatSeconds(goldenSummary.avgMs)} · min {formatSeconds(goldenSummary.minMs)} ·
            max {formatSeconds(goldenSummary.maxMs)}
          </Text>
          {goldenResults!.map(result => (
            <View key={result.case.id} style={styles.lineItemRow}>
              <Text style={styles.lineItemDescription}>
                {result.comparison.allCorrect ? '✅' : '❌'} {result.case.input}
              </Text>
              <Text style={styles.lineItemMeta}>
                Erwartet: {result.case.expected.amount.toFixed(2)} {result.case.expected.currency} ·{' '}
                {result.case.expected.category} ·{' '}
                {result.case.expected.cadence === 'monthly' ? 'monatlich' : 'einmalig'}
              </Text>
              <Text style={styles.lineItemMeta}>
                Erhalten:{' '}
                {result.actual
                  ? `${result.actual.amount !== null ? result.actual.amount.toFixed(2) : '—'} ${result.actual.currency} · ${result.actual.category ?? 'needs_input'} · ${result.actual.cadence === 'monthly' ? 'monatlich' : 'einmalig'}`
                  : 'Fehler bei der Auswertung'}
              </Text>
              <Text style={styles.lineItemMeta}>{formatSeconds(result.durationMs)}</Text>
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}

// Testweiser Dark-Mode-Umschalter, damit sich die Styling-Arbeit (siehe
// CLAUDE.md Lessons Learned zum Dark Mode) ohne Umweg über die
// Simulator-/System-Einstellungen prüfen lässt. Bewusst nur dieser eine
// Schalter — kein allgemeiner "Settings"-Screen mit weiteren Optionen, dafür
// gibt es aktuell keinen Bedarf.
function SettingsScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const override = useContext(DarkModeOverrideContext);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>Einstellungen</Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: 12,
        }}
      >
        <Text style={styles.label}>Dark Mode</Text>
        <Switch
          value={override?.isDarkMode ?? false}
          onValueChange={value => override?.setIsDarkMode(value)}
        />
      </View>
    </ScrollView>
  );
}

// Theme-Farben für Dark Mode — vorher wurde `isDarkMode` nur für die
// StatusBar-Icons genutzt, alle Text-/Rahmenfarben waren fest auf helle
// Werte codiert (z.B. dunkelgraue Schrift ohne gesetzten Hintergrund),
// dadurch auf einem dunklen System-Theme kaum lesbar (bestätigt auf echtem
// Android-Gerät). `getStyles()` wird jetzt in jeder Screen-Komponente über
// `useThemeColors()` neu berechnet, sobald sich `useColorScheme()` ändert.
function computeThemeColors(isDarkMode: boolean) {
  return {
    isDarkMode,
    // Canvas leicht vom Karten-Hintergrund (surface) abgesetzt, statt
    // beides gleich — dadurch wirken Karten/Inputs als eigene Ebene statt
    // nur als Rahmen auf derselben Fläche ("Material"-artige Optik).
    background: isDarkMode ? '#0f1115' : '#f4f5f7',
    surface: isDarkMode ? '#1b1e24' : '#ffffff',
    surfaceRaised: isDarkMode ? '#22262e' : '#ffffff',
    text: isDarkMode ? '#f2f3f5' : '#12151a',
    textMuted: isDarkMode ? '#9aa1ac' : '#6b7280',
    textSubtle: isDarkMode ? '#b7bdc7' : '#4b5563',
    chipText: isDarkMode ? '#e6e8eb' : '#374151',
    border: isDarkMode ? '#3a3f47' : '#dde1e6',
    borderSubtle: isDarkMode ? '#282c33' : '#eceef1',
    inputBackground: isDarkMode ? '#22262e' : '#ffffff',
    previewBackground: isDarkMode ? '#22262e' : '#f0f1f3',
    placeholder: isDarkMode ? '#767c87' : '#9aa1ac',
    shadow: isDarkMode ? '#000000' : '#1f2937',
    // Etwas heller im Dark Mode für genug Kontrast auf dunklem Grund —
    // einzige Stelle, an der der Akzent je nach Theme variiert, alle
    // anderen Verwendungen greifen einheitlich auf colors.accent zu statt
    // wie vorher '#2563eb' an >10 Stellen im Code zu wiederholen.
    accent: isDarkMode ? '#5b93f5' : '#2563eb',
    accentSoft: isDarkMode ? 'rgba(91,147,245,0.18)' : 'rgba(37,99,235,0.1)',
  };
}

// Respektiert den Dark-Mode-Override aus dem Settings-Tab (siehe
// DarkModeOverrideContext), fällt ohne Override (Kontext fehlt — sollte in
// der App nie vorkommen, App() setzt ihn immer) auf das System-Theme zurück.
function useThemeColors() {
  const systemIsDarkMode = useColorScheme() === 'dark';
  const override = useContext(DarkModeOverrideContext);
  const isDarkMode = override ? override.isDarkMode : systemIsDarkMode;
  return useMemo(() => computeThemeColors(isDarkMode), [isDarkMode]);
}

function getStyles(colors: ReturnType<typeof useThemeColors>) {
  // Der Undo-Banner invertiert seinen Hintergrund bewusst gegenüber dem
  // Theme (siehe undoBanner unten) — der Akzent darauf braucht deshalb
  // ebenfalls die umgekehrte Variante, sonst zu wenig Kontrast auf einem im
  // Dark Mode plötzlich hellen Banner.
  const undoAccent = colors.isDarkMode ? '#2563eb' : '#60a5fa';

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
      fontWeight: '500',
      color: '#fff',
      backgroundColor: DANGER_COLOR,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    tabBar: {
      // flexGrow: 0 — sonst füllt die horizontale ScrollView die ganze Höhe.
      flexGrow: 0,
      flexShrink: 0,
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderSubtle,
    },
    tabBarContent: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingBottom: 14,
    },
    tabButton: {
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 20,
      marginRight: 8,
    },
    tabButtonActive: {
      backgroundColor: colors.accent,
      shadowColor: colors.shadow,
      shadowOpacity: 0.25,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
      elevation: 3,
    },
    tabText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textMuted,
    },
    tabTextActive: {
      color: '#fff',
    },
    tabScrollTrack: {
      height: 3,
      backgroundColor: colors.borderSubtle,
    },
    tabScrollThumb: {
      height: 3,
      borderRadius: 1.5,
      backgroundColor: colors.accent,
    },
    title: {
      fontSize: 20,
      fontWeight: '800',
      letterSpacing: -0.3,
      marginBottom: 6,
      color: colors.text,
    },
    status: {
      fontSize: 14,
      lineHeight: 20,
      color: colors.textMuted,
      marginBottom: 18,
    },
    receiptPreview: {
      width: '100%',
      height: 260,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      marginBottom: 18,
      backgroundColor: colors.previewBackground,
      shadowColor: colors.shadow,
      shadowOpacity: 0.08,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
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
      fontWeight: '600',
      color: colors.textMuted,
      marginLeft: 8,
      minWidth: 34,
      textAlign: 'right',
    },
    progressFill: {
      height: '100%',
      borderRadius: 4,
      backgroundColor: colors.accent,
    },
    undoBanner: {
      position: 'absolute',
      left: 16,
      right: 16,
      borderRadius: 14,
      overflow: 'hidden',
      backgroundColor: colors.text,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 5,
    },
    undoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 14,
      paddingHorizontal: 18,
    },
    undoText: {
      flex: 1,
      fontSize: 14,
      color: colors.background,
      marginRight: 12,
    },
    undoAction: {
      fontSize: 14,
      fontWeight: '700',
      color: undoAccent,
    },
    undoTrack: {
      height: 3,
      backgroundColor: 'rgba(255,255,255,0.25)',
    },
    undoFill: {
      height: '100%',
      backgroundColor: undoAccent,
    },
    buttonRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 22,
      marginBottom: 8,
    },
    buttonWrapper: {
      marginRight: 10,
      marginBottom: 10,
    },
    // Basis-Look der AppButton-Komponente (ersetzt die native <Button>).
    appButtonBase: {
      paddingVertical: 12,
      paddingHorizontal: 20,
      borderRadius: 12,
      minHeight: 46,
      alignItems: 'center',
      justifyContent: 'center',
    },
    appButtonPrimary: {
      backgroundColor: colors.accent,
      shadowColor: colors.shadow,
      shadowOpacity: 0.22,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 3,
    },
    appButtonSecondary: {
      backgroundColor: colors.accentSoft,
    },
    appButtonDanger: {
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderColor: DANGER_COLOR,
    },
    appButtonDisabled: {
      opacity: 0.4,
      shadowOpacity: 0,
      elevation: 0,
    },
    appButtonPressed: {
      opacity: 0.82,
    },
    appButtonText: {
      fontSize: 15,
      fontWeight: '700',
    },
    appButtonPrimaryText: {
      color: '#ffffff',
    },
    appButtonSecondaryText: {
      color: colors.accent,
    },
    appButtonDangerText: {
      color: DANGER_COLOR,
    },
    label: {
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: 18,
      marginBottom: 2,
      color: colors.textMuted,
    },
    manualEditBadge: {
      fontSize: 11,
      fontWeight: '500',
      textTransform: 'none',
      letterSpacing: 0,
      fontStyle: 'italic',
      color: colors.textMuted,
    },
    input: {
      fontSize: 15,
      marginTop: 4,
      minHeight: 46,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      padding: 12,
      textAlignVertical: 'top',
      color: colors.text,
      backgroundColor: colors.inputBackground,
    },
    response: {
      fontSize: 13,
      lineHeight: 19,
      marginTop: 6,
      color: colors.text,
    },
    errorText: {
      fontSize: 13,
      fontWeight: '500',
      color: DANGER_COLOR,
      marginTop: 8,
    },
    lowConfidenceBorder: {
      borderColor: CAUTION_COLOR,
      borderWidth: 1.5,
    },
    needsInputBorder: {
      borderColor: DANGER_COLOR,
      borderWidth: 1.5,
    },
    needsInputHint: {
      fontSize: 12,
      fontWeight: '500',
      color: DANGER_COLOR,
      marginTop: 4,
    },
    warningBox: {
      borderRadius: 10,
      borderLeftWidth: 4,
      paddingVertical: 12,
      paddingHorizontal: 14,
      marginTop: 10,
    },
    warningText: {
      fontSize: 13,
      fontWeight: '600',
      lineHeight: 18,
    },
    lineItemRow: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      marginTop: 8,
      shadowColor: colors.shadow,
      shadowOpacity: 0.05,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    },
    priceCard: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 18,
      marginTop: 10,
      shadowColor: colors.shadow,
      shadowOpacity: 0.08,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
    priceHero: {
      fontSize: 30,
      fontWeight: '800',
      letterSpacing: -0.5,
      color: colors.text,
      marginBottom: 4,
    },
    link: {
      fontSize: 13,
      color: colors.accent,
      fontWeight: '600',
      marginTop: 10,
    },
    sourceNote: {
      fontSize: 11,
      color: colors.textMuted,
      marginTop: 16,
      lineHeight: 15,
    },
    lineItemDescription: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.text,
    },
    lineItemMeta: {
      fontSize: 13,
      color: colors.textMuted,
      marginTop: 3,
    },
    segmentRow: {
      flexDirection: 'row',
      marginTop: 6,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    segmentButton: {
      flex: 1,
      paddingVertical: 11,
      alignItems: 'center',
    },
    segmentButtonActive: {
      backgroundColor: colors.accent,
    },
    segmentText: {
      fontSize: 14,
      fontWeight: '500',
      color: colors.chipText,
    },
    segmentTextActive: {
      color: '#fff',
      fontWeight: '700',
    },
    chipContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 6,
      padding: 6,
      borderWidth: 1,
      borderColor: 'transparent',
      borderRadius: 14,
      backgroundColor: colors.surface,
    },
    chip: {
      paddingVertical: 7,
      paddingHorizontal: 14,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      marginRight: 8,
      marginBottom: 8,
    },
    chipSelected: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    chipText: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.chipText,
    },
    chipTextSelected: {
      color: '#fff',
      fontWeight: '700',
    },
  });
}

export default App;
