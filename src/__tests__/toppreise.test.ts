/**
 * Tests für den toppreise.ch-Parser.
 *
 * Das Fixture ist echtes, gekürztes HTML einer Suche nach "Sony WH-1000XM5"
 * (4 Treffer-Blöcke). Wenn diese Tests brechen, hat toppreise.ch vermutlich
 * das Markup geändert — dann muss der Parser nachgezogen werden.
 *
 * @format
 */

import {
  parseToppreiseHtml,
  pickBestMatch,
  tokenize,
  type PriceResult,
} from '../toppreise';
import { TOPPREISE_SEARCH_HTML } from '../__fixtures__/toppreiseSearchHtml';

// react-native-fs wird nur vom Cache benutzt, den diese Tests nicht anfassen.
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp',
  exists: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
}));

const html = TOPPREISE_SEARCH_HTML;

describe('parseToppreiseHtml', () => {
  const results = parseToppreiseHtml(html, 'Sony WH-1000XM5');

  it('findet alle Produkt-Blöcke', () => {
    expect(results).toHaveLength(4);
  });

  it('liest Name, Preis und Angebotszahl des ersten Treffers', () => {
    expect(results[0]).toMatchObject({
      productId: '692648',
      productName: 'SONY WH-1000XM5 , Black',
      price: 187.35,
      currency: 'CHF',
      offerCount: 18,
    });
  });

  it('baut absolute Produkt-URLs', () => {
    expect(results[0].url).toBe(
      'https://www.toppreise.ch/price-comparison/Headphones/SONY-WH-1000XM5-Black-p692648?selsort=rd',
    );
  });

  it('liefert für jeden Treffer einen positiven Preis', () => {
    for (const result of results) {
      expect(result.price).toBeGreaterThan(0);
    }
  });

  it('markiert Treffer, die alle Suchbegriffe enthalten', () => {
    expect(results[0].matchedAllTokens).toBe(true);
    // "SONY ULT Wear" enthält kein "wh" und kein "1000xm5".
    const ult = results.find(r => r.productName.includes('ULT Wear'));
    expect(ult?.matchedAllTokens).toBe(false);
  });

  it('gibt bei fremdem Markup eine leere Liste zurück statt zu werfen', () => {
    expect(parseToppreiseHtml('<html><body>nix</body></html>', 'x')).toEqual([]);
  });
});

describe('pickBestMatch', () => {
  const build = (over: Partial<PriceResult>): PriceResult => ({
    query: 'q',
    productId: '1',
    productName: 'Produkt',
    price: 100,
    priceInclShipping: null,
    currency: 'CHF',
    offerCount: null,
    url: 'https://example.test',
    matchedAllTokens: false,
    timestamp: '2026-09-02T00:00:00.000Z',
    ...over,
  });

  it('gibt null zurück, wenn es keine Treffer gibt', () => {
    expect(pickBestMatch([])).toBeNull();
  });

  it('bevorzugt den ersten Treffer, der alle Suchbegriffe enthält', () => {
    const best = pickBestMatch([
      build({ productId: 'a', matchedAllTokens: false, price: 10 }),
      build({ productId: 'b', matchedAllTokens: true, price: 500 }),
    ]);
    expect(best?.productId).toBe('b');
  });

  it('nimmt NICHT einfach den billigsten Treffer', () => {
    // Regression: das globale Minimum ist oft ein unverwandtes Produkt.
    const best = pickBestMatch([
      build({ productId: 'passend', matchedAllTokens: true, price: 187.35 }),
      build({ productId: 'billig-aber-falsch', price: 45.75 }),
    ]);
    expect(best?.productId).toBe('passend');
  });

  it('fällt auf den relevantesten Treffer zurück, wenn keiner exakt passt', () => {
    const best = pickBestMatch([
      build({ productId: 'erster', price: 900 }),
      build({ productId: 'zweiter', price: 100 }),
    ]);
    expect(best?.productId).toBe('erster');
  });
});

describe('tokenize', () => {
  it('zerlegt in kleingeschriebene Tokens', () => {
    expect(tokenize('Sony WH-1000XM5')).toEqual(['sony', 'wh', '1000xm5']);
  });

  it('verkraftet Umlaute und leere Eingaben', () => {
    expect(tokenize('Kopfhörer')).toEqual(['kopfhörer']);
    expect(tokenize('   ')).toEqual([]);
  });
});
