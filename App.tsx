/**
 * BudgetPilot — minimaler On-Device-LLM-Test (react-native-litert-lm).
 *
 * Lädt Gemma3-1B-IT lokal (.litertlm) und schickt einen festen Prompt ans
 * Modell. Absichtlich ohne UI/Features darüber hinaus — siehe models/README.md.
 *
 * @format
 */

import { useState } from 'react';
import {
  Button,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { useModel } from 'react-native-litert-lm';

// Absoluter Pfad auf diesem Mac — der iOS-Simulator liest direkt vom
// Host-Dateisystem. Datei manuell dorthin legen, siehe models/README.md.
// Für ein echtes Gerät braucht es stattdessen einen In-App-Download in das
// App-Sandbox-Verzeichnis (nicht Teil dieses minimalen Tests).
const MODEL_PATH =
  '/Users/eakerman/development/typescript/budgetpilot/models/gemma3-1b-it-int4.litertlm';

const TEST_PROMPT =
  'Fasse diese Ausgaben zusammen: Kopfhörer 150.-, Lebensmittel 320.-, Kino 40.-';

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <LlmTestScreen />
    </SafeAreaProvider>
  );
}

function LlmTestScreen() {
  const safeAreaInsets = useSafeAreaInsets();
  const { isReady, isGenerating, downloadProgress, error, generate } =
    // multimodal: false is required — the library's filename-sniffing
    // heuristic sees "gemma3" in the path and would otherwise assume this
    // is the multimodal Gemma 3n, requesting a vision backend this
    // text-only model doesn't have (breaks conversation-context creation).
    useModel(MODEL_PATH, { backend: 'cpu', multimodal: false });
  const [response, setResponse] = useState<string | null>(null);

  const runTest = async () => {
    setResponse(null);
    try {
      const result = await generate(TEST_PROMPT);
      console.log('[litert-lm] Antwort:', result);
      setResponse(result);
    } catch (e) {
      console.error('[litert-lm] Fehler bei der Inferenz:', e);
    }
  };

  let status = 'Modell wird geladen…';
  if (error) status = `Fehler beim Laden: ${error}`;
  else if (isReady) status = 'Modell bereit.';
  else if (downloadProgress > 0) status = `Lade Modell… ${downloadProgress}%`;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: safeAreaInsets.top + 24,
        paddingBottom: safeAreaInsets.bottom + 24,
        paddingHorizontal: 20,
      }}>
      <Text style={styles.title}>LiteRT-LM Test — Gemma3-1B-IT</Text>
      <Text style={styles.status}>{status}</Text>

      <View style={styles.buttonWrapper}>
        <Button
          title={isGenerating ? 'Läuft…' : 'Test ausführen'}
          onPress={runTest}
          disabled={!isReady || isGenerating}
        />
      </View>

      <Text style={styles.label}>Prompt:</Text>
      <Text style={styles.prompt}>{TEST_PROMPT}</Text>

      <Text style={styles.label}>Antwort:</Text>
      <Text style={styles.response}>{response ?? '—'}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  status: {
    fontSize: 14,
    color: '#666',
    marginBottom: 16,
  },
  buttonWrapper: {
    marginBottom: 24,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
  },
  prompt: {
    fontSize: 14,
    marginTop: 4,
  },
  response: {
    fontSize: 14,
    marginTop: 4,
  },
});

export default App;
