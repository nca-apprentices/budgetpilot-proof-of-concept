/**
 * @format
 */

import { PRICE_MATCH_GOLDEN_SET, evaluatePriceMatchGoldenSet } from '../priceMatchGoldenSet';

// react-native-fs wird nur vom toppreise-Cache benutzt, den pickBestMatch
// nicht anfasst (siehe auch toppreise.test.ts).
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
}));

const KNOWN_GOOD_IDS = [
  'sony-headphones',
  'nespresso-vertuo',
  'bosch-waschmaschine',
  'iphone-16-pro',
  'cube-fahrrad',
  'dyson-staubsauger',
  'kaffeemaschine-delonghi',
  'playstation-5',
  'samsung-fernseher',
];

const KNOWN_BAD_IDS = [
  'butter-generic',
  'milch-generic',
  'apfel-generic',
  'no-real-match-fallback-1',
  'no-real-match-fallback-2',
];

describe('PRICE_MATCH_GOLDEN_SET', () => {
  it('has unique ids', () => {
    const ids = PRICE_MATCH_GOLDEN_SET.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('accounts for every case in exactly one of the known-good/known-bad lists', () => {
    const ids = PRICE_MATCH_GOLDEN_SET.map(c => c.id).sort();
    const accountedFor = [...KNOWN_GOOD_IDS, ...KNOWN_BAD_IDS].sort();
    expect(ids).toEqual(accountedFor);
  });
});

describe('evaluatePriceMatchGoldenSet', () => {
  const results = evaluatePriceMatchGoldenSet();

  it('logs a summary for manual inspection', () => {
    const correct = results.filter(r => r.correct).length;
    console.log(`[price-match-golden-set] ${correct}/${results.length} korrekt`);
    for (const result of results) {
      if (!result.correct) {
        console.log(
          `  ✗ ${result.case.id} ("${result.case.query}"): erwartet "${result.case.expectedProductName ?? '(kein Treffer)'}", erhalten "${result.pickedProductName ?? '(kein Treffer)'}"`,
        );
      }
    }
    expect(results).toHaveLength(PRICE_MATCH_GOLDEN_SET.length);
  });

  it('picks the correct match for unambiguous queries (regression guard)', () => {
    const regressed = results.filter(
      r => KNOWN_GOOD_IDS.includes(r.case.id) && !r.correct,
    );
    expect(regressed).toEqual([]);
  });

  it('documents the known relevance gap for generic single-word queries and the no-match fallback — NOT yet fixed, see CLAUDE.md', () => {
    // Bewusst keine einzelnen `expect(...).toBe(...)` pro Fall: dieser Test
    // hält den AKTUELLEN (bekanntermassen unzureichenden) Zustand fest,
    // statt ihn stillschweigend grün zu schalten. Sollte pickBestMatch()
    // irgendwann Produktkategorien/Relevanz berücksichtigen, wird dieser
    // Test fehlschlagen — das ist dann das Signal, die Liste zu aktualisieren
    // (die entsprechenden Fälle nach KNOWN_GOOD_IDS verschieben).
    const stillFailing = results.filter(
      r => KNOWN_BAD_IDS.includes(r.case.id) && !r.correct,
    );
    expect(stillFailing.map(r => r.case.id).sort()).toEqual([...KNOWN_BAD_IDS].sort());
  });
});
