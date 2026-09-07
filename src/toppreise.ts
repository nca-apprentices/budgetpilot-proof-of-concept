/**
 * Preisabfrage bei toppreise.ch.
 *
 * WICHTIG — Rollenverteilung: Das LLM ist hier NICHT beteiligt. Gemma kann
 * weder ins Netz noch Tools aufrufen, und erfindet nachweislich Zahlen (siehe
 * CLAUDE.md Lessons Learned 8). Das Modell normalisiert nur den Suchbegriff
 * (siehe buildProductQueryPrompt in App.tsx); alles ab hier ist deterministisch.
 *
 * toppreise.ch hat keine öffentliche API — die einzige dokumentierte
 * Schnittstelle ist ein CSV-Produktfeed FÜR Shops, nicht für Abfragen. Wir
 * parsen deshalb die servergerenderte Suchseite. Kein DOM-Parser, nur Regex:
 * bewusst keine weitere Library in die Hermes-Runtime (vgl. Lessons Learned 6).
 *
 * @format
 */

import RNFS from 'react-native-fs';

const BASE_URL = 'https://www.toppreise.ch';
const REQUEST_TIMEOUT_MS = 15000;
const CACHE_FILE = 'toppreise-cache.json';

// Ohne plausiblen User-Agent liefert die Seite teilweise abweichendes Markup.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export type PriceResult = {
  query: string;
  productId: string;
  productName: string;
  /** Günstigstes Angebot ohne Versand — toppreise zeigt pro Produkt bereits das Minimum über alle Shops. */
  price: number;
  /** Günstigstes Angebot inkl. Versand, falls die Seite es ausweist. */
  priceInclShipping: number | null;
  currency: string;
  /** Anzahl Shops hinter diesem Preis ("18 Angebote ab CHF …"). */
  offerCount: number | null;
  url: string;
  /** Enthält der Produktname alle Suchbegriffe? Wenn nicht, ist der Treffer unsicher. */
  matchedAllTokens: boolean;
  timestamp: string;
};

export type SearchOutcome = {
  results: PriceResult[];
  /** true, wenn die Daten aus dem Cache stammen (offline oder Netzfehler). */
  fromCache: boolean;
  /** Alter des Cache-Eintrags in Stunden — nur gesetzt, wenn fromCache. */
  cacheAgeHours: number | null;
};

function decodeEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** "1'299.95" → 1299.95. Schweizer Tausender-Apostroph, Punkt als Dezimaltrenner. */
function parseSwissPrice(text: string): number | null {
  const normalized = text.replace(/['’\s]/g, '');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9äöüéèàç]+/i)
    .filter(token => token.length > 0);
}

/**
 * Parst die Suchergebnis-Seite. Rein und ohne Netzwerk — dadurch gegen ein
 * gespeichertes HTML-Fixture testbar (src/__tests__/toppreise.test.ts).
 */
export function parseToppreiseHtml(html: string, query: string): PriceResult[] {
  const timestamp = new Date().toISOString();
  const tokens = tokenize(query);
  const results: PriceResult[] = [];

  // Jeder Treffer ist ein Plugin_Product-Block.
  const chunks = html.split(/<div id="Plugin_Product_\d+"/).slice(1);

  for (const chunk of chunks) {
    const link = chunk.match(/data-link="([^"]+)"/);
    const productId = chunk.match(/data-entity-id="(\d+)"/);
    if (!link || !productId) {
      continue;
    }

    // Der fette Anker auf die Produktseite trägt den Namen; <em> markiert
    // darin die Teile, die toppreise gegen die Suchanfrage gematcht hat.
    const titleHtml =
      chunk.match(
        /<a[^>]+href="\/price-comparison\/[^"]*"[^>]*class="bold"[^>]*>([\s\S]*?)<\/a>/,
      )?.[1] ?? chunk.match(/<img[^>]+alt="([^"]+)"/)?.[1];
    if (!titleHtml) {
      continue;
    }
    const productName = stripTags(titleHtml);

    const priceIn = (cssClass: string): number | null => {
      const match = chunk.match(
        new RegExp(
          `priceContainer ${cssClass}\\s*"[\\s\\S]{0,400}?Plugin_Price\\s*">\\s*([\\d'.,\\s]+?)\\s*<`,
        ),
      );
      return match ? parseSwissPrice(match[1]) : null;
    };

    const price = priceIn('productPrice');
    if (price === null) {
      continue; // Produkt ohne Preis (z.B. nicht lieferbar) — überspringen.
    }

    const offerCount = chunk.match(
      />\s*(\d+)\s+(?:Angebote?|offers?)\s+(?:ab|from)\s*</i,
    )?.[1];

    const haystack = productName.toLowerCase();

    results.push({
      query,
      productId: productId[1],
      productName,
      price,
      priceInclShipping: priceIn('shippingPrice'),
      currency: 'CHF',
      offerCount: offerCount ? Number(offerCount) : null,
      url: BASE_URL + decodeEntities(link[1]),
      matchedAllTokens:
        tokens.length > 0 && tokens.every(token => haystack.includes(token)),
      timestamp,
    });
  }

  return results;
}

/**
 * Bester Treffer für die Anfrage.
 *
 * ACHTUNG: NICHT das Minimum über alle Treffer nehmen. Die Suche liefert auch
 * lose verwandte Produkte — das globale Minimum für "Nespresso Vertuo" war in
 * einem Test ein Entsafter für CHF 45.75. Richtig ist: erst das passendste
 * Produkt bestimmen, dessen Preis IST bereits das Minimum über alle Shops.
 */
export function pickBestMatch(results: PriceResult[]): PriceResult | null {
  if (results.length === 0) {
    return null;
  }
  // Treffer, die alle Suchbegriffe enthalten, gewinnen; darin gilt die
  // Relevanz-Reihenfolge von toppreise (Reihenfolge im HTML).
  return results.find(result => result.matchedAllTokens) ?? results[0];
}

type CacheEntry = { results: PriceResult[]; savedAt: string };
type CacheFile = Record<string, CacheEntry>;

function cacheKey(query: string): string {
  return tokenize(query).join(' ');
}

async function readCache(): Promise<CacheFile> {
  try {
    const path = `${RNFS.DocumentDirectoryPath}/${CACHE_FILE}`;
    if (!(await RNFS.exists(path))) {
      return {};
    }
    return JSON.parse(await RNFS.readFile(path, 'utf8')) as CacheFile;
  } catch (e) {
    console.warn('[toppreise] Cache nicht lesbar:', e);
    return {};
  }
}

async function writeCache(query: string, results: PriceResult[]): Promise<void> {
  try {
    const cache = await readCache();
    cache[cacheKey(query)] = { results, savedAt: new Date().toISOString() };
    await RNFS.writeFile(
      `${RNFS.DocumentDirectoryPath}/${CACHE_FILE}`,
      JSON.stringify(cache),
      'utf8',
    );
  } catch (e) {
    // Cache ist nur Komfort — ein Schreibfehler darf die Suche nicht killen.
    console.warn('[toppreise] Cache nicht schreibbar:', e);
  }
}

async function fetchSearchHtml(query: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${BASE_URL}/browse?q=${encodeURIComponent(query)}`,
      {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'de-CH,de;q=0.9',
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`toppreise.ch antwortete mit HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sucht ein Produkt und liefert die Treffer inkl. günstigstem Preis.
 * Fällt bei Netzwerkfehlern (Flugmodus!) auf den Cache zurück.
 */
export async function searchToppreise(query: string): Promise<SearchOutcome> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { results: [], fromCache: false, cacheAgeHours: null };
  }

  try {
    const html = await fetchSearchHtml(trimmed);
    const results = parseToppreiseHtml(html, trimmed);

    // Ein 200er ohne einen einzigen geparsten Treffer heisst fast sicher:
    // toppreise hat das Markup geändert. Das darf nicht als "nichts gefunden"
    // durchgehen — sonst bemerkt niemand, dass der Parser tot ist.
    if (results.length === 0 && html.includes('Plugin_Product_')) {
      throw new Error(
        'Antwort erhalten, aber kein Treffer lesbar — vermutlich hat toppreise.ch das Seiten-Markup geändert.',
      );
    }

    if (results.length > 0) {
      await writeCache(trimmed, results);
    }
    return { results, fromCache: false, cacheAgeHours: null };
  } catch (networkError) {
    const cached = (await readCache())[cacheKey(trimmed)];
    if (!cached) {
      throw networkError;
    }
    const ageMs = Date.now() - new Date(cached.savedAt).getTime();
    return {
      results: cached.results,
      fromCache: true,
      cacheAgeHours: Math.max(0, Math.round(ageMs / 3600000)),
    };
  }
}
