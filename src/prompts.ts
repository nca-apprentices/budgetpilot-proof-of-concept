/**
 * Prompt-Bausteine für alle KI-Aufrufe (Freitext-Extraktion, Foto-OCR-
 * Extraktion, PDF-Zusammenfassung, toppreise.ch-Suchbegriff) sowie die
 * deterministische Normalisierung/Validierung der Modell-Antworten.
 *
 * Bewusst als eigenes Modul, statt in App.tsx: reine Funktionen ohne
 * React-Abhängigkeit, unabhängig von den Screens testbar.
 *
 * @format
 */

import {
  ALLOWED_CATEGORIES,
  type Cadence,
  type Category,
  type LineItem,
} from './budget';
import type { computeBudget } from './budgetEngine';

export const DEFAULT_PROMPT =
  'Fasse diese Ausgaben zusammen: Kopfhörer 150.-, Lebensmittel 320.-, Kino 40.-';

export type Draft = {
  description: string;
  amount: number | null;
  currency: string;
  cadence: Cadence;
  category: Category | null; // null = Modell lieferte "needs_input", muss ausgefüllt werden
  confidence: number | null;
  reason: string;
};

export const LOW_CONFIDENCE_THRESHOLD = 0.7;

// Gemeinsames JSON-Schema für Freitext- UND Foto-Extraktion — eine Quelle
// der Wahrheit, damit beide Pfade garantiert dieselben Felder/Kategorien
// liefern und über dieselbe buildDraftFromRaw()-Normalisierung laufen.
function extractionSchemaInstructions(): string {
  return `Das JSON-Objekt muss genau diese Felder enthalten:
- "description": string — kurze Beschreibung der Ausgabe
- "amount": Zahl — der Betrag, oder null falls nicht erkennbar
- "currency": string — z.B. "CHF" oder "EUR". Ist im Text keine Währung genannt, verwende "CHF" als Standard (niemals den String "null" oder "unbekannt").
- "cadence": entweder "monthly" (wiederkehrend/monatlich) oder "one_time" (einmalig)
- "category": genau eine dieser 7 Kategorien: Wohnen, Lebensmittel, Mobilität, Freizeit, Gesundheit, Abos, Sonstiges — oder "needs_input", falls keine sicher zugeordnet werden kann
- "confidence": Zahl zwischen 0 und 1 — wie sicher du bei dieser Extraktion insgesamt bist
- "reason": kurze Begründung auf Deutsch`;
}

export function buildExtractionPrompt(userText: string): string {
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
export function buildReceiptOcrExtractionPrompt(ocrText: string): string {
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
export function findTotalAmountInOcrText(ocrText: string): number | null {
  const match = ocrText.match(/\bTOTAL\b\s*(?:CHF|EUR|USD|GBP)\s*(\d+[.,]\d{2})/i);
  return match ? parseAmount(match[1]) : null;
}

export function buildSummaryPrompt(
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
export function buildProductQueryPrompt(userText: string): string {
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
export function cleanProductQuery(raw: string): string {
  return (raw.split('\n').find(line => line.trim().length > 0) ?? '')
    .replace(/^["'`\s]+|["'`\s.]+$/g, '')
    .slice(0, 80)
    .trim();
}

export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Keine JSON-Antwort im Modell-Output gefunden.');
  }
  return JSON.parse(raw.slice(start, end + 1));
}

export function parseAmount(raw: unknown): number | null {
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

export function normalizeCadence(raw: unknown): Cadence {
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

// Absicherung gegen das Modell, das gelegentlich den wörtlichen String
// "null"/"undefined" statt des JSON-Literals liefert (siehe CLAUDE.md
// Lessons Learned zu unzuverlässigem JSON-Format) — ein solcher String ist
// laut typeof-Check "gültig", würde ohne diese Prüfung aber unverändert als
// Währung "null" im Entwurf-Screen landen.
const INVALID_CURRENCY_STRINGS = new Set(['null', 'undefined', 'n/a', 'unbekannt', '']);

function normalizeCurrency(raw: unknown): string {
  if (typeof raw !== 'string') {
    return 'CHF';
  }
  const trimmed = raw.trim();
  return INVALID_CURRENCY_STRINGS.has(trimmed.toLowerCase()) ? 'CHF' : trimmed;
}

export function normalizeCategory(raw: unknown): Category | null {
  if (raw === 'needs_input') {
    return null;
  }
  return (ALLOWED_CATEGORIES as readonly string[]).includes(raw as string)
    ? (raw as Category)
    : 'Sonstiges';
}

export function buildDraftFromRaw(raw: any): Draft {
  const confidence =
    typeof raw?.confidence === 'number' && Number.isFinite(raw.confidence)
      ? raw.confidence
      : null;
  return {
    description: typeof raw?.description === 'string' ? raw.description : '',
    amount: parseAmount(raw?.amount),
    currency: normalizeCurrency(raw?.currency),
    cadence: normalizeCadence(raw?.cadence),
    category: normalizeCategory(raw?.category),
    confidence,
    reason: typeof raw?.reason === 'string' ? raw.reason : '',
  };
}
