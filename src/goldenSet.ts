/**
 * Golden Set für die Freitext-Extraktion — siehe CLAUDE.md, Abschnitt
 * "Testplan". Bisher gab es nur Einzel-Stichproben (n=2/n=3 bei Fotos); diese
 * Datei ist der erste Schritt zu einer systematischen Messung.
 *
 * Ursprünglich mit 20 statt der geplanten 30 Fällen gestartet (jeder Fall
 * braucht einen echten On-Device-Modellaufruf, Sekunden bis über eine Minute
 * auf CPU, siehe Lessons Learned) — inzwischen auf die vollen 30 erweitert,
 * die zusätzlichen 10 bewusst mit anderen Formulierungsmustern als die
 * ersten 20 (unterschiedliche Wortstellung, Verben, CHF/EUR-Mix), um nicht
 * nur eine einzige Satzstruktur zu testen. Die Liste bleibt beliebig
 * erweiterbar, ohne den Batch-Runner (LLM-Test-Screen) anzufassen.
 *
 * Bewusst weiterhin nur eindeutige Fälle (kein needs_input) — mehrdeutige
 * Fälle (fehlender Betrag, Kategorie nicht klar zuordenbar) lassen sich
 * später separat ergänzen.
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

  // --- Erweiterung auf 30 Fälle: bewusst andere Formulierungsmuster als
  // oben (Wortstellung, Verben, CHF/EUR-Mix), damit das Set nicht nur eine
  // einzige Satzstruktur abdeckt.
  {
    id: 'internet-abo',
    input: 'Internetabo Swisscom, 65 CHF pro Monat',
    expected: { amount: 65, currency: 'CHF', cadence: 'monthly', category: 'Abos' },
  },
  {
    id: 'apotheke-rezept',
    input: 'Rezeptgebühr in der Apotheke bezahlt, 8.50 CHF',
    expected: { amount: 8.5, currency: 'CHF', cadence: 'one_time', category: 'Gesundheit' },
  },
  {
    id: 'velo-service',
    input: 'Velo-Service beim Velohändler, 95 CHF',
    expected: { amount: 95, currency: 'CHF', cadence: 'one_time', category: 'Mobilität' },
  },
  {
    id: 'kleider-kauf',
    input: 'Neue Winterjacke gekauft für 149.90 CHF',
    expected: { amount: 149.9, currency: 'CHF', cadence: 'one_time', category: 'Sonstiges' },
  },
  {
    id: 'strom-monatlich',
    input: 'Stromrechnung, jeden Monat 85 CHF',
    expected: { amount: 85, currency: 'CHF', cadence: 'monthly', category: 'Wohnen' },
  },
  {
    id: 'restaurant-abend',
    input: 'Abendessen im Restaurant mit Freunden, 68 CHF',
    expected: { amount: 68, currency: 'CHF', cadence: 'one_time', category: 'Freizeit' },
  },
  {
    id: 'zugticket-eur',
    input: 'Zugticket in Deutschland gekauft, 59 EUR',
    expected: { amount: 59, currency: 'EUR', cadence: 'one_time', category: 'Mobilität' },
  },
  {
    id: 'brille-kauf',
    input: 'Neue Brille beim Optiker, 320 CHF',
    expected: { amount: 320, currency: 'CHF', cadence: 'one_time', category: 'Gesundheit' },
  },
  {
    id: 'geburtstagsessen',
    input: 'Essen gehen zum Geburtstag, letzten Samstag 95 CHF',
    expected: { amount: 95, currency: 'CHF', cadence: 'one_time', category: 'Freizeit' },
  },
  {
    id: 'cloud-abo',
    input: 'iCloud Speicher Abo, 2.99 CHF im Monat',
    expected: { amount: 2.99, currency: 'CHF', cadence: 'monthly', category: 'Abos' },
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
