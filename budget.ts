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

export type Cadence = 'monthly' | 'one_time';

// 'manual' und 'toppreise' sind noch nicht angebunden, aber schon Teil des
// Enums, damit LineItem.source nicht erneut angepasst werden muss, sobald
// diese Eingabewege dazukommen.
export type Source = 'free_text' | 'manual' | 'toppreise';

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
};
