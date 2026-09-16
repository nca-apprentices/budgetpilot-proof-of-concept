/**
 * Produktsuche mit Preisvergleich.
 *
 * Ablauf: Freitext → Gemma normalisiert ihn zu einem Suchbegriff → toppreise.ch
 * wird abgefragt und geparst → günstigstes Angebot des passendsten Produkts.
 * Der Suchbegriff bleibt editierbar, weil das Modell ihn manchmal danebenlegt.
 *
 * @format
 */

import { useMemo, useState } from 'react';
import { Linking, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UseModelResult } from 'react-native-litert-lm';
import { pickBestMatch, searchToppreise, type PriceResult } from '../toppreise';
import { buildProductQueryPrompt, cleanProductQuery } from '../prompts';
import { formatDateDMY } from '../dateUtils';
import { CAUTION_COLOR, useThemeColors } from '../theme';
import { getStyles } from '../styles';
import { AppButton } from '../components/AppButton';

export function PriceSearchScreen({ model }: { model: UseModelResult }) {
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
      <Text style={styles.status}>
        Benötigt eine Internetverbindung, um Preise von toppreise.ch
        abzurufen — ohne Verbindung stehen nur zuvor gespeicherte
        (zwischengespeicherte) Ergebnisse zur Verfügung.
      </Text>

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
