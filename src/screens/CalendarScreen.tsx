/**
 * Monatskalender mit Punkt-Markierung an Tagen mit bereits erfassten Posten.
 * Antippen eines Tages öffnet "Ausgabe erfassen" mit dem Datum vorausgefüllt.
 *
 * @format
 */

import { useMemo } from 'react';
import { ScrollView, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Calendar, type DateData } from 'react-native-calendars';
import type { LineItem } from '../budget';
import { useThemeColors } from '../theme';
import { getStyles } from '../styles';

export function CalendarScreen({
  items,
  onSelectDate,
}: {
  items: LineItem[];
  onSelectDate: (isoDate: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);

  // Tage mit mindestens einem erfassten Posten bekommen einen Punkt —
  // reine Anzeige, keine Auswahl-Logik.
  const markedDates = useMemo(() => {
    const marks: Record<string, { marked: true; dotColor: string }> = {};
    for (const item of items) {
      if (item.date) {
        marks[item.date] = { marked: true, dotColor: colors.accent };
      }
    }
    return marks;
  }, [items, colors.accent]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>Kalender</Text>
      <Text style={styles.status}>
        Auf ein Datum tippen, um dort eine Ausgabe zu erfassen.
      </Text>
      <Calendar
        markedDates={markedDates}
        onDayPress={(day: DateData) => onSelectDate(day.dateString)}
        theme={{
          todayTextColor: colors.accent,
          arrowColor: colors.accent,
          dotColor: colors.accent,
          calendarBackground: colors.surface,
          dayTextColor: colors.text,
          monthTextColor: colors.text,
          textSectionTitleColor: colors.textMuted,
          textDisabledColor: colors.borderSubtle,
        }}
      />
    </ScrollView>
  );
}
