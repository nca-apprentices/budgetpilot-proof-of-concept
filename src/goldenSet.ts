/**
 * Golden Set für die Freitext-Extraktion — siehe CLAUDE.md, Abschnitt
 * "Testplan". Bisher gab es nur Einzel-Stichproben (n=2/n=3 bei Fotos); diese
 * Datei ist der erste Schritt zu einer systematischen Messung.
 *
 * Bewusst klein gestartet (20 statt der ursprünglich geplanten 30) — jeder
 * Fall braucht einen echten On-Device-Modellaufruf (Sekunden bis über eine
 * Minute auf CPU, siehe Lessons Learned), ein Voll-Set wäre für einen ersten
 * Durchlauf zu langsam. Die Liste ist beliebig erweiterbar.
 *
 * Bewusst nur eindeutige Fälle in dieser ersten Version (kein needs_input) —
 * mehrdeutige Fälle (fehlender Betrag, Kategorie nicht klar zuordenbar)
 * lassen sich später separat ergänzen, sobald diese Basis läuft.
 *
 * @format
 */

import type { Cadence, Category } from './budget';

export type GoldenSetExpectation = {
  amount: number;
  currency: string;
  cadence: Cadence;
  category: Category;
};

export type GoldenSetCase = {
  id: string;
  input: string;
  expected: GoldenSetExpectation;
};

export const GOLDEN_SET: GoldenSetCase[] = [
  {
    id: 'miete',
    input: 'Miete 1200 CHF monatlich',
    expected: { amount: 1200, currency: 'CHF', cadence: 'monthly', category: 'Wohnen' },
  },
  {
    id: 'nebenkosten',
    input: 'Nebenkosten für die Wohnung 150 CHF monatlich',
    expected: { amount: 150, currency: 'CHF', cadence: 'monthly', category: 'Wohnen' },
  },
  {
    id: 'hausratversicherung',
    input: 'Hausratversicherung 15 CHF monatlich',
    expected: { amount: 15, currency: 'CHF', cadence: 'monthly', category: 'Wohnen' },
  },
  {
    id: 'coop-einkauf',
    input: 'Coop Einkauf 64.30 CHF',
    expected: { amount: 64.3, currency: 'CHF', cadence: 'one_time', category: 'Lebensmittel' },
  },
  {
    id: 'migros-einkauf',
    input: 'Migros 45 CHF',
    expected: { amount: 45, currency: 'CHF', cadence: 'one_time', category: 'Lebensmittel' },
  },
  {
    id: 'denner-einkauf',
    input: 'Wocheneinkauf im Denner 38.90',
    expected: { amount: 38.9, currency: 'CHF', cadence: 'one_time', category: 'Lebensmittel' },
  },
  {
    id: 'oev-abo',
    input: 'Monatliches ÖV-Abo 79 CHF',
    expected: { amount: 79, currency: 'CHF', cadence: 'monthly', category: 'Mobilität' },
  },
  {
    id: 'tanken',
    input: 'Tanken 65 CHF',
    expected: { amount: 65, currency: 'CHF', cadence: 'one_time', category: 'Mobilität' },
  },
  {
    id: 'zugticket',
    input: 'Zugticket Zürich Bern 25 CHF',
    expected: { amount: 25, currency: 'CHF', cadence: 'one_time', category: 'Mobilität' },
  },
  {
    id: 'kino',
    input: 'Kinotickets 32 CHF',
    expected: { amount: 32, currency: 'CHF', cadence: 'one_time', category: 'Freizeit' },
  },
  {
    id: 'konzert',
    input: 'Konzertticket 85 CHF',
    expected: { amount: 85, currency: 'CHF', cadence: 'one_time', category: 'Freizeit' },
  },
  {
    id: 'museum',
    input: 'Museumseintritt 18 CHF',
    expected: { amount: 18, currency: 'CHF', cadence: 'one_time', category: 'Freizeit' },
  },
  {
    id: 'krankenkasse',
    input: 'Krankenkasse Prämie 320 CHF monatlich',
    expected: { amount: 320, currency: 'CHF', cadence: 'monthly', category: 'Gesundheit' },
  },
  {
    id: 'zahnarzt',
    input: 'Zahnarzt Rechnung 240 CHF',
    expected: { amount: 240, currency: 'CHF', cadence: 'one_time', category: 'Gesundheit' },
  },
  {
    id: 'netflix',
    input: 'Netflix Abo 19.90 CHF monatlich',
    expected: { amount: 19.9, currency: 'CHF', cadence: 'monthly', category: 'Abos' },
  },
  {
    id: 'spotify',
    input: 'Spotify Premium 12.95 CHF monatlich',
    expected: { amount: 12.95, currency: 'CHF', cadence: 'monthly', category: 'Abos' },
  },
  {
    id: 'zeitungsabo',
    input: 'Zeitungsabo NZZ 42 CHF monatlich',
    expected: { amount: 42, currency: 'CHF', cadence: 'monthly', category: 'Abos' },
  },
  {
    id: 'geschenk',
    input: 'Geschenk für Geburtstag 50 CHF',
    expected: { amount: 50, currency: 'CHF', cadence: 'one_time', category: 'Sonstiges' },
  },
  {
    id: 'spende',
    input: 'Spende 20 CHF',
    expected: { amount: 20, currency: 'CHF', cadence: 'one_time', category: 'Sonstiges' },
  },
  {
    id: 'ladekabel',
    input: 'Neues Handy-Ladekabel gekauft 25 CHF',
    expected: { amount: 25, currency: 'CHF', cadence: 'one_time', category: 'Sonstiges' },
  },
];

export type GoldenSetComparison = {
  amountCorrect: boolean;
  categoryCorrect: boolean;
  cadenceCorrect: boolean;
  allCorrect: boolean;
};

// Gleitkomma-Toleranz für den Betragsvergleich (Rappen-Rundung).
const AMOUNT_EPSILON = 0.01;

/**
 * Reine Vergleichsfunktion, unabhängig vom Modell-Aufruf testbar — nimmt
 * absichtlich nur die drei Felder entgegen, die das Golden Set bewertet
 * (nicht den ganzen Draft, der z.B. auch `description`/`reason` enthält, für
 * die es keine sinnvolle "richtige" Antwort gibt).
 */
export function compareToExpected(
  expected: GoldenSetExpectation,
  actual: { amount: number | null; cadence: Cadence; category: Category | null },
): GoldenSetComparison {
  const amountCorrect =
    actual.amount !== null && Math.abs(actual.amount - expected.amount) < AMOUNT_EPSILON;
  const categoryCorrect = actual.category === expected.category;
  const cadenceCorrect = actual.cadence === expected.cadence;
  return {
    amountCorrect,
    categoryCorrect,
    cadenceCorrect,
    allCorrect: amountCorrect && categoryCorrect && cadenceCorrect,
  };
}
