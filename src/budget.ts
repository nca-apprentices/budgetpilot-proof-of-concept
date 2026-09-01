/**
 * Domänenmodell für BudgetPilot — bewusst ohne React/State, nur Typen.
 * Siehe CLAUDE.md, Abschnitt "Datenmodell".
 */

export const ALLOWED_CATEGORIES = [
  'Wohnen',
  'Lebensmittel',
  'Mobilität',
  'Freizeit',
  'Gesundheit',
  'Abos',
  'Sonstiges',
] as const;

export type Category = (typeof ALLOWED_CATEGORIES)[number];

// Identitätsfarbe pro Kategorie — aktuell nur vom PDF-Export (pdfExport.ts)
// für die Kategorie-Chips genutzt, hier zentral definiert statt dort
// dupliziert, falls später z.B. auch die Kategorie-Chips im DraftScreen
// eingefärbt werden sollen.
export const CATEGORY_COLORS: Record<Category, string> = {
  Wohnen: '#5b7fa6',
  Lebensmittel: '#7a9d54',
  Mobilität: '#c98a3a',
  Freizeit: '#b0568f',
  Gesundheit: '#4f9d8f',
  Abos: '#8a7fc9',
  Sonstiges: '#8a8578',
};

export type Cadence = 'monthly' | 'one_time';

// 'manual' und 'toppreise' sind noch nicht angebunden, aber schon Teil des
// Enums, damit LineItem.source nicht erneut angepasst werden muss, sobald
// diese Eingabewege dazukommen. 'photo' ist bereits aktiv (Beleg-Kamera-Pfad).
export type Source = 'free_text' | 'photo' | 'manual' | 'toppreise';

export type LineItem = {
  id: string;
  description: string;
  amount: number | null;
  currency: string;
  cadence: Cadence;
  category: Category | null;
  source: Source;
  confidence: number | null;
  notes: string;
  // ISO-Datum (YYYY-MM-DD) — vom Nutzer im Entwurf-Screen frei editierbar,
  // nicht vom Modell extrahiert (die KI liefert kein Datum).
  date: string;
};
