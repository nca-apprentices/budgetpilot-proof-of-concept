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
  TextInput,
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

const DEFAULT_PROMPT =
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
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [response, setResponse] = useState<string | null>(null);

  const runTest = async () => {
    setResponse(null);
    try {
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

      <Text style={styles.label}>Prompt:</Text>
      <TextInput
        style={styles.input}
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder="Prompt eingeben…"
      />

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <Button
            title={isGenerating ? 'Läuft…' : 'Test ausführen'}
            onPress={runTest}
            disabled={!isReady || isGenerating || prompt.trim().length === 0}
          />
        </View>
        <View style={styles.buttonWrapper}>
          <Button
            title="Zurücksetzen"
            onPress={clear}
            disabled={isGenerating || (prompt.length === 0 && response === null)}
          />
        </View>
      </View>

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
  buttonRow: {
    flexDirection: 'row',
    marginTop: 16,
    marginBottom: 24,
  },
  buttonWrapper: {
    marginRight: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
  },
  input: {
    fontSize: 14,
    marginTop: 4,
    minHeight: 60,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    padding: 8,
    textAlignVertical: 'top',
  },
  response: {
    fontSize: 14,
    marginTop: 4,
  },
});

export default App;
