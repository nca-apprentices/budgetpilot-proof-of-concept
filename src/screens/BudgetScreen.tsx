/**
 * Einkommen, bestätigte Posten (Fixkosten/geplante Käufe) und Restbudget für
 * einen ausgewählten Monat, plus PDF-Export.
 *
 * @format
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { UseModelResult } from 'react-native-litert-lm';
import type { LineItem } from '../budget';
import { computeBudget } from '../budgetEngine';
import { buildBudgetReportPdf, savePdfAndShare } from '../pdfExport';
import { monthOfDate } from '../db';
import { buildSummaryPrompt, parseAmount } from '../prompts';
import {
  MONTH_SHORT_NAMES,
  formatMonthLabel,
  shiftMonth,
  todayIso,
} from '../dateUtils';
import { CAUTION_COLOR, DANGER_COLOR, useThemeColors } from '../theme';
import { getStyles } from '../styles';
import { AppButton } from '../components/AppButton';
import { LineItemRow } from '../components/LineItemRow';

export function BudgetScreen({
  model,
  getIncomeForMonth,
  setIncomeForMonth,
  items,
  onEditItem,
}: {
  model: UseModelResult;
  getIncomeForMonth: (month: string) => Promise<number | null>;
  setIncomeForMonth: (month: string, income: number | null) => void;
  items: LineItem[];
  onEditItem: (item: LineItem) => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);

  // Vorher zeigte dieser Screen ALLE Posten aus ALLEN Monaten gleichzeitig
  // (Bug-Report: eine im Juli erfasste Miete zählte auch im September mit) —
  // jetzt gilt immer genau ein ausgewählter Monat, per Pfeilen navigierbar.
  const [selectedMonth, setSelectedMonth] = useState(() =>
    monthOfDate(todayIso()),
  );
  const [income, setIncome] = useState<number | null>(null);
  const [incomeText, setIncomeText] = useState('');
  const [isLoadingIncome, setIsLoadingIncome] = useState(true);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Popup zum direkten Springen zu einem Monat/Jahr (statt nur einzeln über
  // die Pfeile zu blättern) — eigenes Jahr im Picker, damit man im Popup erst
  // durch Jahre blättern kann, ohne dass sich der sichtbare Monat im
  // Hintergrund schon mitverändert; erst ein Antippen einer Monatskachel
  // übernimmt die Auswahl wirklich.
  const [isMonthPickerOpen, setIsMonthPickerOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(() =>
    Number(selectedMonth.slice(0, 4)),
  );
  const selectedYear = Number(selectedMonth.slice(0, 4));
  const selectedMonthIndex = Number(selectedMonth.slice(5, 7)) - 1;

  const openMonthPicker = () => {
    setPickerYear(selectedYear);
    setIsMonthPickerOpen(true);
  };

  // Einkommen ist pro Monat in der DB gespeichert — bei jedem Monatswechsel
  // neu laden, statt es wie die Posten komplett im Speicher zu halten (es
  // gibt potenziell beliebig viele Monate, aber nur einer ist je sichtbar).
  useEffect(() => {
    let cancelled = false;
    setIsLoadingIncome(true);
    getIncomeForMonth(selectedMonth)
      .then(value => {
        if (cancelled) {
          return;
        }
        setIncome(value);
        setIncomeText(value === null ? '' : String(value));
        setIsLoadingIncome(false);
      })
      .catch(e => {
        console.error('[db] Einkommen für Monat nicht geladen:', e);
        if (!cancelled) {
          setIsLoadingIncome(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMonth, getIncomeForMonth]);

  const handleIncomeChange = (t: string) => {
    setIncomeText(t);
    const parsed = parseAmount(t);
    setIncome(parsed);
    setIncomeForMonth(selectedMonth, parsed);
  };

  // Fixkosten vs. geplante Käufe sind keine getrennt geführten Listen,
  // sondern nur eine Sicht auf die Posten DIESES Monats, abgeleitet aus
  // `cadence`. `date` statt `monthId` ist hier bewusst die Filterquelle —
  // `items` kommt als UI-Modell (budget.ts) ohne monthId, aber date und
  // monthId folgen ohnehin immer demselben Monat (siehe insertLineItem).
  const monthItems = useMemo(
    () => items.filter(item => monthOfDate(item.date) === selectedMonth),
    [items, selectedMonth],
  );
  const fixedCosts = monthItems.filter(item => item.cadence === 'monthly');
  const plannedPurchases = monthItems.filter(
    item => item.cadence === 'one_time',
  );
  const summary = computeBudget(income, monthItems);

  const handleExportPdf = async () => {
    setExportError(null);
    setIsExporting(true);
    let aiSummaryText: string | null = null;
    // KI-Zusammenfassung ist ein optionales Extra — schlägt sie fehl, wird
    // trotzdem ein PDF mit den (verlässlichen) strukturierten Daten exportiert.
    if (model.isReady) {
      try {
        model.reset();
        const raw = await model.generate(
          buildSummaryPrompt(income, monthItems, summary),
        );
        aiSummaryText = raw.trim() || null;
      } catch (e) {
        console.error('[pdf-summary] Fehler:', e);
      }
    }
    try {
      const bytes = await buildBudgetReportPdf({
        income,
        items: monthItems,
        summary,
        aiSummaryText,
      });
      // Erstellungs-Zeitstempel lesbar statt als rohe Date.now()-Millisekunden
      // (verwirrte beim Testen — "sollte doch dem Tag entsprechen") — Uhrzeit
      // dranhängen, damit zwei Exporte am selben Tag sich nicht überschreiben.
      const exportedAt = new Date();
      const exportedAtLabel = `${todayIso()}-${String(exportedAt.getHours()).padStart(2, '0')}${String(exportedAt.getMinutes()).padStart(2, '0')}`;
      await savePdfAndShare(
        bytes,
        `budgetpilot-bericht-${selectedMonth}-erstellt-${exportedAtLabel}.pdf`,
      );
    } catch (e) {
      console.error('[pdf-export] Fehler:', e);
      setExportError('PDF-Export fehlgeschlagen. Bitte erneut versuchen.');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>Budget</Text>

      <View style={styles.monthSelectorRow}>
        <Pressable
          style={styles.monthArrowButton}
          onPress={() => setSelectedMonth(prev => shiftMonth(prev, -1))}
        >
          <Text style={styles.monthArrowText}>‹</Text>
        </Pressable>
        <Pressable onPress={openMonthPicker} style={styles.monthLabelButton}>
          <Text style={styles.monthLabel}>{formatMonthLabel(selectedMonth)}</Text>
        </Pressable>
        <Pressable
          style={styles.monthArrowButton}
          onPress={() => setSelectedMonth(prev => shiftMonth(prev, 1))}
        >
          <Text style={styles.monthArrowText}>›</Text>
        </Pressable>
      </View>

      <Modal
        visible={isMonthPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsMonthPickerOpen(false)}
      >
        <Pressable
          style={styles.monthPickerBackdrop}
          onPress={() => setIsMonthPickerOpen(false)}
        >
          {/* onPress hier fängt Taps auf der Karte ab, damit sie nicht bis
              zum Backdrop durchreichen und das Popup versehentlich schliessen. */}
          <Pressable style={styles.monthPickerCard} onPress={() => {}}>
            <View style={styles.monthSelectorRow}>
              <Pressable
                style={styles.monthArrowButton}
                onPress={() => setPickerYear(y => y - 1)}
              >
                <Text style={styles.monthArrowText}>‹</Text>
              </Pressable>
              <Text style={styles.monthLabel}>{pickerYear}</Text>
              <Pressable
                style={styles.monthArrowButton}
                onPress={() => setPickerYear(y => y + 1)}
              >
                <Text style={styles.monthArrowText}>›</Text>
              </Pressable>
            </View>
            <View style={styles.monthGrid}>
              {MONTH_SHORT_NAMES.map((name, index) => {
                const monthStr = `${pickerYear}-${String(index + 1).padStart(2, '0')}`;
                const isActive =
                  pickerYear === selectedYear && index === selectedMonthIndex;
                return (
                  <Pressable
                    key={monthStr}
                    style={[
                      styles.monthGridCell,
                      isActive && styles.monthGridCellActive,
                    ]}
                    onPress={() => {
                      setSelectedMonth(monthStr);
                      setIsMonthPickerOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.monthGridCellText,
                        isActive && styles.monthGridCellTextActive,
                      ]}
                    >
                      {name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <Text style={styles.label}>
        Monatliches Einkommen{isLoadingIncome ? ' (lädt…)' : ''}
      </Text>
      <TextInput
        style={styles.input}
        value={incomeText}
        onChangeText={handleIncomeChange}
        keyboardType="numeric"
        placeholder="z.B. 4500"
        placeholderTextColor={colors.placeholder}
      />

      <Text style={styles.label}>Fixkosten (monatlich)</Text>
      {fixedCosts.length === 0 ? (
        <Text style={styles.status}>Noch keine erfasst.</Text>
      ) : (
        fixedCosts.map(item => (
          <LineItemRow key={item.id} item={item} onPress={() => onEditItem(item)} />
        ))
      )}

      <Text style={styles.label}>Geplante Käufe (einmalig)</Text>
      {plannedPurchases.length === 0 ? (
        <Text style={styles.status}>Noch keine erfasst.</Text>
      ) : (
        plannedPurchases.map(item => (
          <LineItemRow key={item.id} item={item} onPress={() => onEditItem(item)} />
        ))
      )}

      <Text style={styles.label}>Zusammenfassung</Text>
      <Text style={styles.status}>
        Fixkosten gesamt: {summary.totalFixedCosts.toFixed(2)} CHF{'\n'}
        Geplante Käufe gesamt: {summary.totalPlannedPurchases.toFixed(2)} CHF
        {'\n'}
        Ausgaben gesamt: {summary.totalSpent.toFixed(2)} CHF{'\n'}
        Restbudget:{' '}
        {summary.restbudget === null
          ? '—'
          : `${summary.restbudget.toFixed(2)} CHF`}
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
              {
                borderLeftColor: isOverBudget ? DANGER_COLOR : CAUTION_COLOR,
                backgroundColor: isOverBudget
                  ? 'rgba(220,38,38,0.08)'
                  : 'rgba(245,158,11,0.08)',
              },
            ]}
          >
            <Text
              style={[
                styles.warningText,
                { color: isOverBudget ? DANGER_COLOR : CAUTION_COLOR },
              ]}
            >
              {warning}
            </Text>
          </View>
        );
      })}

      {exportError && <Text style={styles.errorText}>{exportError}</Text>}

      <View style={styles.buttonRow}>
        <View style={styles.buttonWrapper}>
          <AppButton
            title={isExporting ? 'Exportiere…' : 'Als PDF exportieren'}
            onPress={handleExportPdf}
            disabled={isExporting}
          />
        </View>
      </View>
    </ScrollView>
  );
}
