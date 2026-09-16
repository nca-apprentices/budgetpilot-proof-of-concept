/**
 * Freier Prompt ans Modell (Debug/Latenz-Check) plus Golden-Set-Batch-Runner
 * (siehe CLAUDE.md Lessons Learned #30).
 *
 * @format
 */

import { useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UseModelResult } from 'react-native-litert-lm';
import {
  GOLDEN_SET,
  compareToExpected,
  type GoldenSetCase,
  type GoldenSetComparison,
} from '../goldenSet';
import {
  DEFAULT_PROMPT,
  buildDraftFromRaw,
  buildExtractionPrompt,
  extractJsonObject,
  type Draft,
} from '../prompts';
import { useThemeColors } from '../theme';
import { getStyles } from '../styles';
import { AppButton } from '../components/AppButton';
import { DownloadProgressBar } from '../components/DownloadProgressBar';

type GoldenRunResult = {
  case: GoldenSetCase;
  actual: Draft | null;
  comparison: GoldenSetComparison;
  // Zeit für reset() + generate() dieses einen Falls, in Millisekunden —
  // bisher gab es dafür nur ein Gefühl ("dauert teils über eine Minute auf
  // CPU"), keine echte Zahl (siehe CLAUDE.md Testplan). Auch bei einem
  // fehlgeschlagenen Fall gemessen (der Modellaufruf selbst lief ja noch,
  // nur das Parsen danach ist gescheitert) statt die Messung zu verwerfen.
  durationMs: number;
};

const FAILED_COMPARISON: GoldenSetComparison = {
  amountCorrect: false,
  categoryCorrect: false,
  cadenceCorrect: false,
  allCorrect: false,
};

export function LlmTestScreen({ model }: { model: UseModelResult }) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const { isReady, isGenerating, downloadProgress, error, generate, reset } =
    model;
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [response, setResponse] = useState<string | null>(null);
  const [isRunningGoldenSet, setIsRunningGoldenSet] = useState(false);
  const [goldenSetProgress, setGoldenSetProgress] = useState(0);
  const [goldenResults, setGoldenResults] = useState<GoldenRunResult[] | null>(null);

  const runTest = async () => {
    setResponse(null);
    try {
      // Jeder Testlauf ist ein unabhängiger Einzel-Prompt (kein Chat) — ohne
      // Reset würde er an die Historie vorheriger Läufe/Screens anhängen.
      reset();
      const result = await generate(prompt);
      console.log('[litert-lm] Antwort:', result);
      setResponse(result);
    } catch (e) {
      console.error('[litert-lm] Fehler bei der Inferenz:', e);
    }
  };

  const clear = () => {
    setPrompt('');
    setResponse(null);
  };

  // Läuft alle GOLDEN_SET-Fälle nacheinander über denselben Extraktionspfad
  // wie der echte Freitext-Flow (buildExtractionPrompt), statt sie einzeln
  // von Hand einzutippen — siehe CLAUDE.md Testplan/Lessons Learned. Jeder
  // Fall bekommt ein eigenes try/catch, damit ein einzelner Parse-Fehler
  // nicht den ganzen Durchlauf abbricht und die restlichen Ergebnisse
  // verschluckt.
  const runGoldenSet = async () => {
    setIsRunningGoldenSet(true);
    setGoldenResults(null);
    const results: GoldenRunResult[] = [];
    for (let i = 0; i < GOLDEN_SET.length; i++) {
      const testCase = GOLDEN_SET[i];
      setGoldenSetProgress(i);
      const startedAt = Date.now();
      try {
        reset();
        const raw = await generate(buildExtractionPrompt(testCase.input));
        const actual = buildDraftFromRaw(extractJsonObject(raw));
        results.push({
          case: testCase,
          actual,
          comparison: compareToExpected(testCase.expected, actual),
          durationMs: Date.now() - startedAt,
        });
      } catch (e) {
        console.error(`[golden-set] Fall "${testCase.id}" fehlgeschlagen:`, e);
        results.push({
          case: testCase,
          actual: null,
          comparison: FAILED_COMPARISON,
          durationMs: Date.now() - startedAt,
        });
      }
    }
    setGoldenResults(results);
    setIsRunningGoldenSet(false);
  };

  const goldenSummary = useMemo(() => {
    if (!goldenResults) {
      return null;
    }
    const total = goldenResults.length;
    const count = (pick: (r: GoldenRunResult) => boolean) =>
      goldenResults.filter(pick).length;
    const durations = goldenResults.map(r => r.durationMs).sort((a, b) => a - b);
    const avgMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    return {
      total,
      allCorrect: count(r => r.comparison.allCorrect),
      amountCorrect: count(r => r.comparison.amountCorrect),
      categoryCorrect: count(r => r.comparison.categoryCorrect),
      cadenceCorrect: count(r => r.comparison.cadenceCorrect),
      avgMs,
      minMs: durations[0],
      maxMs: durations[durations.length - 1],
    };
  }, [goldenResults]);

  const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  let status = 'Modell wird geladen…';
  if (error) status = `Fehler beim Laden: ${error}`;
  else if (isReady) status = 'Modell bereit.';
  else if (downloadProgress > 0) status = 'Lade Modell…';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>LiteRT-LM Test — Gemma 4 E2B-it</Text>
      <Text style={styles.status}>{status}</Text>
      {!isReady && downloadProgress > 0 && <DownloadProgressBar progress={downloadProgress} />}

      <Text style={styles.label}>Prompt:</Text>
      <TextInput
        style={styles.input}
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder="Prompt eingeben…"
        placeholderTextColor={colors.placeholder}
      />

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <AppButton
            title={isGenerating ? 'Läuft…' : 'Test ausführen'}
            onPress={runTest}
            disabled={!isReady || isGenerating || isRunningGoldenSet || prompt.trim().length === 0}
          />
        </View>
        <View style={styles.buttonWrapper}>
          <AppButton
            title="Zurücksetzen"
            onPress={clear}
            disabled={
              isGenerating || isRunningGoldenSet || (prompt.length === 0 && response === null)
            }
            variant="secondary"
          />
        </View>
      </View>

      <Text style={styles.label}>Antwort:</Text>
      <Text style={styles.response}>{response ?? '—'}</Text>

      <Text style={styles.title}>Golden Set</Text>
      <Text style={styles.status}>
        {GOLDEN_SET.length} Testfälle mit erwarteten Werten (Betrag, Kategorie, Häufigkeit) —
        siehe src/goldenSet.ts.
      </Text>

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <AppButton
            title={
              isRunningGoldenSet
                ? `Läuft… (${goldenSetProgress + 1}/${GOLDEN_SET.length})`
                : 'Golden Set ausführen'
            }
            onPress={runGoldenSet}
            disabled={!isReady || isGenerating || isRunningGoldenSet}
          />
        </View>
      </View>

      {goldenSummary && (
        <>
          <Text style={styles.label}>
            {goldenSummary.allCorrect}/{goldenSummary.total} komplett korrekt
          </Text>
          <Text style={styles.status}>
            Betrag: {goldenSummary.amountCorrect}/{goldenSummary.total} · Kategorie:{' '}
            {goldenSummary.categoryCorrect}/{goldenSummary.total} · Häufigkeit:{' '}
            {goldenSummary.cadenceCorrect}/{goldenSummary.total}
          </Text>
          <Text style={styles.status}>
            Antwortzeit: Ø {formatSeconds(goldenSummary.avgMs)} · min {formatSeconds(goldenSummary.minMs)} ·
            max {formatSeconds(goldenSummary.maxMs)}
          </Text>
          {goldenResults!.map(result => (
            <View key={result.case.id} style={styles.lineItemRow}>
              <Text style={styles.lineItemDescription}>
                {result.comparison.allCorrect ? '✅' : '❌'} {result.case.input}
              </Text>
              <Text style={styles.lineItemMeta}>
                Erwartet: {result.case.expected.amount.toFixed(2)} {result.case.expected.currency} ·{' '}
                {result.case.expected.category} ·{' '}
                {result.case.expected.cadence === 'monthly' ? 'monatlich' : 'einmalig'}
              </Text>
              <Text style={styles.lineItemMeta}>
                Erhalten:{' '}
                {result.actual
                  ? `${result.actual.amount !== null ? result.actual.amount.toFixed(2) : '—'} ${result.actual.currency} · ${result.actual.category ?? 'needs_input'} · ${result.actual.cadence === 'monthly' ? 'monatlich' : 'einmalig'}`
                  : 'Fehler bei der Auswertung'}
              </Text>
              <Text style={styles.lineItemMeta}>{formatSeconds(result.durationMs)}</Text>
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}
