/**
 * BudgetPilot — On-Device-LLM-Test (react-native-litert-lm) + Ausgabenerfassung.
 *
 * Lädt Gemma3-1B-IT lokal (.litertlm) und stellt zwei Screens bereit:
 * - "LLM-Test": freier Prompt ans Modell, fürs Golden-Set-Testen.
 * - "Ausgabe erfassen": Freitext → KI-Extraktion → Entwurf zum Bestätigen,
 *   bevor irgendwas gespeichert wird.
 *
 * Absichtlich ohne echte Persistenz — siehe models/README.md.
 *
 * @format
 */

import { useState } from 'react';
import {
  Button,
  Pressable,
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
import { useModel, type UseModelResult } from 'react-native-litert-lm';
import { ALLOWED_CATEGORIES, type Category, type Cadence, type LineItem } from './budget';
import { computeBudget } from './budgetEngine';

// Absoluter Pfad auf diesem Mac — der iOS-Simulator liest direkt vom
// Host-Dateisystem. Datei manuell dorthin legen, siehe models/README.md.
// Für ein echtes Gerät braucht es stattdessen einen In-App-Download in das
// App-Sandbox-Verzeichnis (nicht Teil dieses minimalen Tests).
const MODEL_PATH =
  '/Users/eakerman/development/typescript/budgetpilot/models/gemma3-1b-it-int4.litertlm';

const DEFAULT_PROMPT =
  'Fasse diese Ausgaben zusammen: Kopfhörer 150.-, Lebensmittel 320.-, Kino 40.-';

const DANGER_COLOR = '#dc2626';
const CAUTION_COLOR = '#f5a623';

type Draft = {
  description: string;
  amount: number | null;
  currency: string;
  cadence: Cadence;
  category: Category | null; // null = Modell lieferte "needs_input", muss ausgefüllt werden
  confidence: number | null;
  reason: string;
};

const LOW_CONFIDENCE_THRESHOLD = 0.7;

function buildExtractionPrompt(userText: string): string {
  return `Du bist ein Extraktions-Assistent für die Budget-App BudgetPilot. Lies die folgende Freitext-Beschreibung einer Ausgabe und antworte AUSSCHLIESSLICH mit einem einzelnen JSON-Objekt — keine Erklärung, kein Markdown, kein Codeblock.

Das JSON-Objekt muss genau diese Felder enthalten:
- "description": string — kurze Beschreibung der Ausgabe
- "amount": Zahl — der Betrag, oder null falls nicht erkennbar
- "currency": string — z.B. "CHF" oder "EUR"
- "cadence": entweder "monthly" (wiederkehrend/monatlich) oder "one_time" (einmalig)
- "category": genau eine dieser 7 Kategorien: Wohnen, Lebensmittel, Mobilität, Freizeit, Gesundheit, Abos, Sonstiges — oder "needs_input", falls keine sicher zugeordnet werden kann
- "confidence": Zahl zwischen 0 und 1 — wie sicher du bei dieser Extraktion insgesamt bist
- "reason": kurze Begründung auf Deutsch

Beispiel:
Text: "Miete 1200 CHF monatlich"
Antwort: {"description":"Miete","amount":1200,"currency":"CHF","cadence":"monthly","category":"Wohnen","confidence":0.95,"reason":"Eindeutige monatliche Mietzahlung."}

Text: "${userText}"
Antwort:`;
}

function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Keine JSON-Antwort im Modell-Output gefunden.');
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function parseAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  const n = parseFloat(String(raw).replace(',', '.').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeCadence(raw: unknown): Cadence {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (v === 'monthly' || v.includes('monat')) {
    return 'monthly';
  }
  if (
    v === 'one_time' ||
    v.includes('einmal') ||
    v.includes('one-time') ||
    v.includes('onetime')
  ) {
    return 'one_time';
  }
  // Unbekannter Wert (z.B. "yearly"): konservativ als Einmalzahlung werten,
  // statt fälschlich etwas als wiederkehrend einzuplanen.
  return 'one_time';
}

function normalizeCategory(raw: unknown): Category | null {
  if (raw === 'needs_input') {
    return null;
  }
  return (ALLOWED_CATEGORIES as readonly string[]).includes(raw as string)
    ? (raw as Category)
    : 'Sonstiges';
}

function buildDraftFromRaw(raw: any): Draft {
  const confidence =
    typeof raw?.confidence === 'number' && Number.isFinite(raw.confidence)
      ? raw.confidence
      : null;
  return {
    description: typeof raw?.description === 'string' ? raw.description : '',
    amount: parseAmount(raw?.amount),
    currency:
      typeof raw?.currency === 'string' && raw.currency.trim()
        ? raw.currency.trim()
        : 'CHF',
    cadence: normalizeCadence(raw?.cadence),
    category: normalizeCategory(raw?.category),
    confidence,
    reason: typeof raw?.reason === 'string' ? raw.reason : '',
  };
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type Screen = 'expense' | 'budget' | 'llmTest';

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const model = useModel(MODEL_PATH, { backend: 'cpu', multimodal: false });
  const [screen, setScreen] = useState<Screen>('expense');
  const [income, setIncome] = useState<number | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);

  const addItem = (item: LineItem) => setItems(prev => [...prev, item]);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <View style={styles.appContainer}>
        <ScreenTabs screen={screen} onChange={setScreen} />
        {screen === 'expense' && <ExpenseFlow model={model} onConfirmItem={addItem} />}
        {screen === 'budget' && (
          <BudgetScreen income={income} onChangeIncome={setIncome} items={items} />
        )}
        {screen === 'llmTest' && <LlmTestScreen model={model} />}
      </View>
    </SafeAreaProvider>
  );
}

function ScreenTabs({
  screen,
  onChange,
}: {
  screen: Screen;
  onChange: (s: Screen) => void;
}) {
  const insets = useSafeAreaInsets();
  const tabs: { key: Screen; label: string }[] = [
    { key: 'expense', label: 'Ausgabe erfassen' },
    { key: 'budget', label: 'Budget' },
    { key: 'llmTest', label: 'LLM-Test' },
  ];
  return (
    <View style={[styles.tabBar, { paddingTop: insets.top + 12 }]}>
      {tabs.map(tab => (
        <Pressable
          key={tab.key}
          style={[styles.tabButton, screen === tab.key && styles.tabButtonActive]}
          onPress={() => onChange(tab.key)}>
          <Text style={[styles.tabText, screen === tab.key && styles.tabTextActive]}>
            {tab.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function ExpenseFlow({
  model,
  onConfirmItem,
}: {
  model: UseModelResult;
  onConfirmItem: (item: LineItem) => void;
}) {
  const { isReady, isGenerating, generate } = model;
  const [step, setStep] = useState<'entry' | 'draft'>('entry');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleWeiter = async () => {
    setError(null);
    try {
      const result = await generate(buildExtractionPrompt(text));
      console.log('[extraction] Antwort:', result);
      const raw = extractJsonObject(result);
      setDraft(buildDraftFromRaw(raw));
      setStep('draft');
    } catch (e) {
      console.error('[extraction] Fehler:', e);
      setError(
        'Die Antwort des Modells konnte nicht ausgewertet werden. Bitte erneut versuchen.',
      );
    }
  };

  const handleVerwerfen = () => {
    setDraft(null);
    setStep('entry');
  };

  const handleBestaetigen = (finalDraft: Draft) => {
    const item: LineItem = {
      id: createId(),
      description: finalDraft.description,
      amount: finalDraft.amount,
      currency: finalDraft.currency,
      cadence: finalDraft.cadence,
      category: finalDraft.category,
      source: 'free_text',
      confidence: finalDraft.confidence,
      notes: finalDraft.reason,
    };
    console.log('[expense] Bestätigt:', item);
    onConfirmItem(item);
    setDraft(null);
    setText('');
    setStep('entry');
  };

  if (step === 'draft' && draft) {
    return <DraftScreen draft={draft} onConfirm={handleBestaetigen} onDiscard={handleVerwerfen} />;
  }

  return (
    <EntryScreen
      text={text}
      onChangeText={setText}
      onWeiter={handleWeiter}
      isReady={isReady}
      isGenerating={isGenerating}
      error={error}
    />
  );
}

function EntryScreen({
  text,
  onChangeText,
  onWeiter,
  isReady,
  isGenerating,
  error,
}: {
  text: string;
  onChangeText: (t: string) => void;
  onWeiter: () => void;
  isReady: boolean;
  isGenerating: boolean;
  error: string | null;
}) {
  const insets = useSafeAreaInsets();

  let status = 'Modell wird geladen…';
  if (isReady) {
    status = 'Modell bereit.';
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}>
      <Text style={styles.title}>Ausgabe erfassen</Text>
      <Text style={styles.status}>{status}</Text>

      <Text style={styles.label}>Ausgabe als Freitext:</Text>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={onChangeText}
        multiline
        placeholder="z.B. Miete 1200 CHF monatlich"
      />

      {error && <Text style={styles.errorText}>{error}</Text>}

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <Button
            title={isGenerating ? 'Analysiere…' : 'Weiter'}
            onPress={onWeiter}
            disabled={!isReady || isGenerating || text.trim().length === 0}
          />
        </View>
      </View>
    </ScrollView>
  );
}

function DraftScreen({
  draft,
  onConfirm,
  onDiscard,
}: {
  draft: Draft;
  onConfirm: (d: Draft) => void;
  onDiscard: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [description, setDescription] = useState(draft.description);
  const [amountText, setAmountText] = useState(
    draft.amount === null ? '' : String(draft.amount),
  );
  const [currency, setCurrency] = useState(draft.currency);
  const [cadence, setCadence] = useState<Cadence>(draft.cadence);
  const [category, setCategory] = useState<Category | null>(draft.category);

  const lowConfidence =
    draft.confidence !== null && draft.confidence < LOW_CONFIDENCE_THRESHOLD;

  const parsedAmount = parseAmount(amountText);
  // An der aktuellen Eingabe statt am ursprünglichen KI-Wert festmachen, damit
  // der Hinweis verschwindet, sobald der Nutzer das Feld ausgefüllt hat.
  const amountNeedsInput = parsedAmount === null;
  const categoryNeedsInput = category === null;

  const canConfirm =
    description.trim().length > 0 && parsedAmount !== null && category !== null;

  const fieldStyle = (needsInput: boolean) => [
    styles.input,
    lowConfidence && styles.lowConfidenceBorder,
    needsInput && styles.needsInputBorder,
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}>
      <Text style={styles.title}>Entwurf bestätigen</Text>
      {draft.confidence !== null && (
        <Text style={styles.status}>
          Vertrauen der KI-Extraktion: {Math.round(draft.confidence * 100)}%
        </Text>
      )}

      <Text style={styles.label}>Beschreibung</Text>
      <TextInput
        style={fieldStyle(false)}
        value={description}
        onChangeText={setDescription}
        placeholder="Beschreibung"
      />

      <Text style={styles.label}>Betrag</Text>
      <TextInput
        style={fieldStyle(amountNeedsInput)}
        value={amountText}
        onChangeText={setAmountText}
        keyboardType="numeric"
        placeholder={amountNeedsInput ? 'Betrag eingeben' : undefined}
      />
      {amountNeedsInput && (
        <Text style={styles.needsInputHint}>Bitte Betrag ausfüllen.</Text>
      )}

      <Text style={styles.label}>Währung</Text>
      <TextInput
        style={styles.input}
        value={currency}
        onChangeText={setCurrency}
        placeholder="CHF"
      />

      <Text style={styles.label}>Häufigkeit</Text>
      <View style={[styles.segmentRow, lowConfidence && styles.lowConfidenceBorder]}>
        <Pressable
          style={[
            styles.segmentButton,
            cadence === 'monthly' && styles.segmentButtonActive,
          ]}
          onPress={() => setCadence('monthly')}>
          <Text
            style={[
              styles.segmentText,
              cadence === 'monthly' && styles.segmentTextActive,
            ]}>
            monatlich
          </Text>
        </Pressable>
        <Pressable
          style={[
            styles.segmentButton,
            cadence === 'one_time' && styles.segmentButtonActive,
          ]}
          onPress={() => setCadence('one_time')}>
          <Text
            style={[
              styles.segmentText,
              cadence === 'one_time' && styles.segmentTextActive,
            ]}>
            einmalig
          </Text>
        </Pressable>
      </View>

      <Text style={styles.label}>Kategorie</Text>
      <View
        style={[
          styles.chipContainer,
          lowConfidence && styles.lowConfidenceBorder,
          categoryNeedsInput && styles.needsInputBorder,
        ]}>
        {ALLOWED_CATEGORIES.map(c => (
          <Pressable
            key={c}
            style={[styles.chip, category === c && styles.chipSelected]}
            onPress={() => setCategory(c)}>
            <Text
              style={[styles.chipText, category === c && styles.chipTextSelected]}>
              {c}
            </Text>
          </Pressable>
        ))}
      </View>
      {categoryNeedsInput && (
        <Text style={styles.needsInputHint}>Bitte Kategorie auswählen.</Text>
      )}

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <Button
            title="Bestätigen"
            disabled={!canConfirm}
            onPress={() =>
              onConfirm({
                description: description.trim(),
                amount: parsedAmount,
                currency: currency.trim() || 'CHF',
                cadence,
                category,
                confidence: draft.confidence,
                reason: draft.reason,
              })
            }
          />
        </View>
        <View style={styles.buttonWrapper}>
          <Button title="Verwerfen" onPress={onDiscard} color="#999" />
        </View>
      </View>
    </ScrollView>
  );
}

function BudgetScreen({
  income,
  onChangeIncome,
  items,
}: {
  income: number | null;
  onChangeIncome: (income: number | null) => void;
  items: LineItem[];
}) {
  const insets = useSafeAreaInsets();
  const [incomeText, setIncomeText] = useState(income === null ? '' : String(income));

  const handleIncomeChange = (t: string) => {
    setIncomeText(t);
    onChangeIncome(parseAmount(t));
  };

  // Fixkosten vs. geplante Käufe sind keine getrennt geführten Listen,
  // sondern nur eine Sicht auf `items`, abgeleitet aus `cadence`.
  const fixedCosts = items.filter(item => item.cadence === 'monthly');
  const plannedPurchases = items.filter(item => item.cadence === 'one_time');
  const summary = computeBudget(income, items);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}>
      <Text style={styles.title}>Budget</Text>

      <Text style={styles.label}>Monatliches Einkommen</Text>
      <TextInput
        style={styles.input}
        value={incomeText}
        onChangeText={handleIncomeChange}
        keyboardType="numeric"
        placeholder="z.B. 4500"
      />

      <Text style={styles.label}>Fixkosten (monatlich)</Text>
      {fixedCosts.length === 0 ? (
        <Text style={styles.status}>Noch keine erfasst.</Text>
      ) : (
        fixedCosts.map(item => <LineItemRow key={item.id} item={item} />)
      )}

      <Text style={styles.label}>Geplante Käufe (einmalig)</Text>
      {plannedPurchases.length === 0 ? (
        <Text style={styles.status}>Noch keine erfasst.</Text>
      ) : (
        plannedPurchases.map(item => <LineItemRow key={item.id} item={item} />)
      )}

      <Text style={styles.label}>Zusammenfassung</Text>
      <Text style={styles.status}>
        Fixkosten gesamt: {summary.totalFixedCosts.toFixed(2)} CHF{'\n'}
        Geplante Käufe gesamt: {summary.totalPlannedPurchases.toFixed(2)} CHF{'\n'}
        Ausgaben gesamt: {summary.totalSpent.toFixed(2)} CHF{'\n'}
        Restbudget:{' '}
        {summary.restbudget === null ? '—' : `${summary.restbudget.toFixed(2)} CHF`}
        {summary.restbudgetPercent !== null &&
          ` (${summary.restbudgetPercent.toFixed(1)}%)`}
      </Text>

      {summary.warnings.map((warning, index) => {
        const isOverBudget = warning.startsWith('Budget überschritten');
        return (
          <View
            key={index}
            style={[
              styles.warningBox,
              { borderColor: isOverBudget ? DANGER_COLOR : CAUTION_COLOR },
            ]}>
            <Text
              style={[
                styles.warningText,
                { color: isOverBudget ? DANGER_COLOR : CAUTION_COLOR },
              ]}>
              {warning}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

function LineItemRow({ item }: { item: LineItem }) {
  return (
    <View style={styles.lineItemRow}>
      <Text style={styles.lineItemDescription}>{item.description}</Text>
      <Text style={styles.lineItemMeta}>
        {item.amount !== null ? `${item.amount.toFixed(2)} ${item.currency}` : '—'} ·{' '}
        {item.category ?? 'Sonstiges'}
      </Text>
    </View>
  );
}

function LlmTestScreen({ model }: { model: UseModelResult }) {
  const insets = useSafeAreaInsets();
  const { isReady, isGenerating, downloadProgress, error, generate } = model;
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
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
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
  appContainer: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
  },
  tabButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    marginRight: 8,
  },
  tabButtonActive: {
    backgroundColor: '#2563eb',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555',
  },
  tabTextActive: {
    color: '#fff',
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
    minHeight: 44,
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
  errorText: {
    fontSize: 13,
    color: DANGER_COLOR,
    marginTop: 8,
  },
  lowConfidenceBorder: {
    borderColor: CAUTION_COLOR,
    borderWidth: 2,
  },
  needsInputBorder: {
    borderColor: DANGER_COLOR,
    borderWidth: 2,
  },
  needsInputHint: {
    fontSize: 12,
    color: DANGER_COLOR,
    marginTop: 4,
  },
  warningBox: {
    borderWidth: 2,
    borderRadius: 6,
    padding: 10,
    marginTop: 8,
  },
  warningText: {
    fontSize: 13,
    fontWeight: '600',
  },
  lineItemRow: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 6,
    padding: 8,
    marginTop: 4,
  },
  lineItemDescription: {
    fontSize: 14,
    fontWeight: '600',
  },
  lineItemMeta: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  segmentRow: {
    flexDirection: 'row',
    marginTop: 4,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    overflow: 'hidden',
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
  },
  segmentButtonActive: {
    backgroundColor: '#2563eb',
  },
  segmentText: {
    fontSize: 14,
    color: '#333',
  },
  segmentTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  chipContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 4,
    padding: 4,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: 6,
  },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ccc',
    marginRight: 8,
    marginBottom: 8,
  },
  chipSelected: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  chipText: {
    fontSize: 13,
    color: '#333',
  },
  chipTextSelected: {
    color: '#fff',
    fontWeight: '600',
  },
});

export default App;
