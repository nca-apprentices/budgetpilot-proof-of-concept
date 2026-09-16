/**
 * Kompakte Zeile für einen bestätigten Posten (Budget-Tab) — antippbar zum
 * Bearbeiten.
 *
 * @format
 */

import { useMemo } from 'react';
import { Pressable, Text } from 'react-native';
import type { LineItem } from '../budget';
import { useThemeColors } from '../theme';
import { getStyles } from '../styles';

export function LineItemRow({ item, onPress }: { item: LineItem; onPress: () => void }) {
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  return (
    <Pressable style={styles.lineItemRow} onPress={onPress}>
      <Text style={styles.lineItemDescription}>{item.description}</Text>
      <Text style={styles.lineItemMeta}>
        {item.amount !== null
          ? `${item.amount.toFixed(2)} ${item.currency}`
          : '—'}{' '}
        · {item.category ?? 'Sonstiges'}
      </Text>
    </Pressable>
  );
}
