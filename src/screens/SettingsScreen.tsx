/**
 * Testweiser Dark-Mode-Umschalter, damit sich die Styling-Arbeit (siehe
 * CLAUDE.md Lessons Learned zum Dark Mode) ohne Umweg über die
 * Simulator-/System-Einstellungen prüfen lässt. Bewusst nur dieser eine
 * Schalter — kein allgemeiner "Settings"-Screen mit weiteren Optionen, dafür
 * gibt es aktuell keinen Bedarf.
 *
 * @format
 */

import { useContext, useMemo } from 'react';
import { ScrollView, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DarkModeOverrideContext, useThemeColors } from '../theme';
import { getStyles } from '../styles';

export function SettingsScreen() {
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const override = useContext(DarkModeOverrideContext);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{
        paddingTop: 20,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 20,
      }}
    >
      <Text style={styles.title}>Einstellungen</Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: 12,
        }}
      >
        <Text style={styles.label}>Dark Mode</Text>
        <Switch
          value={override?.isDarkMode ?? false}
          onValueChange={value => override?.setIsDarkMode(value)}
        />
      </View>
    </ScrollView>
  );
}
