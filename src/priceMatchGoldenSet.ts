/**
 * Golden Set für `pickBestMatch()` (toppreise.ts) — der zweite, rein
 * deterministische Schritt im Preise-Flow ("Wunschliste": Suchbegriff →
 * bester Treffer, siehe App.tsx-Kommentar "Preise": Freitext → Suchbegriff
 * (KI) → Preisabruf toppreise.ch). Ergänzt src/goldenSet.ts, das den ersten,
 * modellbasierten Schritt (Freitext-Extraktion) misst — dieser Teil hier
 * läuft ohne Modell/Netzwerk, direkt in Jest (wie budgetEngine.test.ts).
 *
 * Anders als src/goldenSet.ts sind hier absichtlich NICHT alle Fälle als
 * "sollte aktuell bestehen" gedacht: die `-generic`/`no-real-match-*`-Fälle
 * dokumentieren einen real beim manuellen Testen gefundenen Bug (siehe
 * CLAUDE.md) — `pickBestMatch` nimmt den ersten Treffer, dessen Produktname
 * alle Such-Tokens als Teilstring enthält, ohne Produktkategorie oder
 * Relevanz zu berücksichtigen. Bei generischen Einzelwort-Suchen wie
 * "Butter" landet dadurch z.B. ein PC-Gehäuse mit der Farboption "Butter
 * Caramel" vor echter Butter. Diese Datei hält das reproduzierbar fest,
 * statt es nur als Einzelbeobachtung zu dokumentieren — siehe
 * src/__tests__/priceMatchGoldenSet.test.ts für die Auswertung.
 *
 * @format
 */

import { tokenize, pickBestMatch, type PriceResult } from './toppreise';

export type PriceMatchCandidate = { productName: string; price: number };

export type PriceMatchGoldenCase = {
  id: string;
  query: string;
  /** Kandidaten in der Reihenfolge, wie toppreise.ch sie im HTML liefern würde. */
  candidates: PriceMatchCandidate[];
  /** Produktname, der ausgewählt werden sollte — null, falls kein Kandidat ein sinnvoller Treffer ist. */
  expectedProductName: string | null;
};

export const PRICE_MATCH_GOLDEN_SET: PriceMatchGoldenCase[] = [
  // --- Eindeutige Suchen, sollten mit dem aktuellen pickBestMatch funktionieren ---
  {
    id: 'sony-headphones',
    query: 'Sony WH-1000XM5',
    candidates: [
      { productName: 'SONY WH-1000XM5 , Black', price: 187.35 },
      { productName: 'SONY WH-1000XM4, Black', price: 149.0 },
      { productName: 'Bose QuietComfort 45', price: 219.0 },
    ],
    expectedProductName: 'SONY WH-1000XM5 , Black',
  },
  {
    // Genau das Beispiel aus dem Kommentar in pickBestMatch() — hält fest,
    // dass die dort beschriebene historische Falle (globales Minimum über
    // alle Treffer statt des passendsten Produkts) mit der aktuellen
    // matchedAllTokens-Logik nicht mehr zuschlägt.
    id: 'nespresso-vertuo',
    query: 'Nespresso Vertuo',
    candidates: [
      { productName: 'Fruchtpresse Vertuo Elektrisch', price: 45.75 },
      { productName: 'DeLonghi Nespresso Vertuo Next, Grey', price: 159.0 },
    ],
    expectedProductName: 'DeLonghi Nespresso Vertuo Next, Grey',
  },
  {
    id: 'bosch-waschmaschine',
    query: 'Bosch Waschmaschine',
    candidates: [
      { productName: 'Bosch WGG254Z0CH Waschmaschine', price: 799.0 },
      { productName: 'Siemens Waschmaschine WM14', price: 849.0 },
    ],
    expectedProductName: 'Bosch WGG254Z0CH Waschmaschine',
  },
  {
    id: 'iphone-16-pro',
    query: 'iPhone 16 Pro',
    candidates: [
      { productName: 'Apple iPhone 16 Pro 128GB, Titan Schwarz', price: 1099.0 },
      { productName: 'Apple iPhone 16 128GB, Schwarz', price: 899.0 },
      { productName: 'Samsung Galaxy S24', price: 799.0 },
    ],
    expectedProductName: 'Apple iPhone 16 Pro 128GB, Titan Schwarz',
  },
  {
    id: 'cube-fahrrad',
    query: 'Cube Fahrrad',
    candidates: [
      { productName: 'Cube Aim Fahrrad, Grey', price: 549.0 },
      { productName: 'Trek Rucksack 20L', price: 59.0 },
    ],
    expectedProductName: 'Cube Aim Fahrrad, Grey',
  },
  {
    id: 'dyson-staubsauger',
    query: 'Dyson Staubsauger',
    candidates: [
      { productName: 'Dyson V15 Detect Staubsauger', price: 649.0 },
      { productName: 'Rowenta Staubsauger X-Force', price: 229.0 },
    ],
    expectedProductName: 'Dyson V15 Detect Staubsauger',
  },
  {
    id: 'kaffeemaschine-delonghi',
    query: 'DeLonghi Kaffeemaschine',
    candidates: [
      { productName: 'DeLonghi Magnifica S Kaffeemaschine', price: 399.0 },
      { productName: 'Philips Kaffeemaschine 1200W', price: 129.0 },
    ],
    expectedProductName: 'DeLonghi Magnifica S Kaffeemaschine',
  },
  {
    id: 'playstation-5',
    query: 'PlayStation 5',
    candidates: [
      { productName: 'Sony PlayStation 5 Slim, 1TB', price: 499.0 },
      { productName: 'Sony PlayStation 4, 500GB', price: 199.0 },
      { productName: 'Xbox Series X', price: 459.0 },
    ],
    expectedProductName: 'Sony PlayStation 5 Slim, 1TB',
  },
  {
    id: 'samsung-fernseher',
    query: 'Samsung Fernseher 55 Zoll',
    candidates: [
      { productName: 'Samsung QLED Fernseher 55 Zoll', price: 899.0 },
      { productName: 'LG OLED Fernseher 55 Zoll', price: 1099.0 },
    ],
    expectedProductName: 'Samsung QLED Fernseher 55 Zoll',
  },

  // --- Generische Einzelwort-Suchen: bekannter, noch offener Bug ---
  {
    // Der real beim manuellen Testen gefundene Fall (siehe CLAUDE.md).
    id: 'butter-generic',
    query: 'Butter',
    candidates: [
      { productName: 'THERMALTAKE View 390 Air Window, Butter Caramel', price: 125.9 },
      { productName: 'VAUDE Wash Bag L, Peanut Butter', price: 35.77 },
      { productName: 'Lätta Butter Streichfett 250g', price: 3.9 },
      { productName: "L'Occitane Shea Butter Foot Cream 30ml", price: 10.0 },
    ],
    expectedProductName: 'Lätta Butter Streichfett 250g',
  },
  {
    id: 'milch-generic',
    query: 'Milch',
    candidates: [
      { productName: 'Lindt Excellence Zartbitter mit Milch 100g', price: 2.9 },
      { productName: 'Emmi Vollmilch 1L', price: 1.6 },
    ],
    expectedProductName: 'Emmi Vollmilch 1L',
  },
  {
    id: 'apfel-generic',
    query: 'Apfel',
    candidates: [
      { productName: 'Ladekabel USB-C 2m, Apfelgrün', price: 9.9 },
      { productName: 'Frischer Apfel im Sack 2kg', price: 4.5 },
    ],
    expectedProductName: 'Frischer Apfel im Sack 2kg',
  },

  // --- Keine passenden Kandidaten: pickBestMatch sollte kein Fallback-Rateergebnis liefern ---
  {
    id: 'no-real-match-fallback-1',
    query: 'Nintendo Switch 2',
    candidates: [
      { productName: 'Sony PlayStation 5 Slim', price: 499.0 },
      { productName: 'Logitech Maus MX Master', price: 89.0 },
    ],
    expectedProductName: null,
  },
  {
    id: 'no-real-match-fallback-2',
    query: 'Kopfhörer Bluetooth',
    candidates: [
      { productName: 'Ladekabel USB-C 2m', price: 9.9 },
      { productName: 'HDMI Kabel 3m', price: 14.9 },
    ],
    expectedProductName: null,
  },
];

export type PriceMatchResult = {
  case: PriceMatchGoldenCase;
  pickedProductName: string | null;
  correct: boolean;
};

/** Baut die Kandidaten eines Falls zu `PriceResult[]` — mit derselben `matchedAllTokens`-Logik wie `parseToppreiseHtml`, damit `pickBestMatch` unverändert getestet wird. */
function toPriceResults(testCase: PriceMatchGoldenCase): PriceResult[] {
  const tokens = tokenize(testCase.query);
  return testCase.candidates.map((candidate, index) => {
    const haystack = candidate.productName.toLowerCase();
    return {
      query: testCase.query,
      productId: String(index),
      productName: candidate.productName,
      price: candidate.price,
      priceInclShipping: null,
      currency: 'CHF',
      offerCount: null,
      url: `https://www.toppreise.ch/price-comparison/fixture-${index}`,
      matchedAllTokens: tokens.length > 0 && tokens.every(token => haystack.includes(token)),
      timestamp: '2026-01-01T00:00:00.000Z',
    };
  });
}

export function evaluatePriceMatchGoldenSet(): PriceMatchResult[] {
  return PRICE_MATCH_GOLDEN_SET.map(testCase => {
    const picked = pickBestMatch(toPriceResults(testCase));
    const pickedProductName = picked?.productName ?? null;
    return {
      case: testCase,
      pickedProductName,
      correct: pickedProductName === testCase.expectedProductName,
    };
  });
}
