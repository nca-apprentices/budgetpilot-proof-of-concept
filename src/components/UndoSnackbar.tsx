/**
 * Banner unten am Bildschirmrand mit Countdown-Balken (siehe
 * UNDO_WINDOW_MS in App.tsx) — Antippen ruft onPress (App()s
 * handleUndoPress) auf. Bewusst mit invertierten Theme-Farben (colors.text
 * als Hintergrund, colors.background als Textfarbe) statt eigener
 * Farb-Tokens — funktioniert dadurch automatisch in Hell- wie Dunkelmodus
 * ohne weitere Fallunterscheidung.
 *
 * @format
 */

import { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../theme';
import { getStyles } from '../styles';

export function UndoSnackbar({
  message,
  durationMs,
  onPress,
}: {
  message: string;
  durationMs: number;
  onPress: () => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const animatedWidth = useRef(new Animated.Value(100)).current;

  useEffect(() => {
    Animated.timing(animatedWidth, {
      toValue: 0,
      duration: durationMs,
      useNativeDriver: false, // 'width' unterstützt keinen Native Driver
    }).start();
  }, [animatedWidth, durationMs]);

  return (
    <View style={[styles.undoBanner, { bottom: insets.bottom + 12 }]}>
      <Pressable style={styles.undoRow} onPress={onPress}>
        <Text style={styles.undoText} numberOfLines={1}>
          {message}
        </Text>
        <Text style={styles.undoAction}>Rückgängig</Text>
      </Pressable>
      <View style={styles.undoTrack}>
        <Animated.View
          style={[
            styles.undoFill,
            {
              width: animatedWidth.interpolate({
                inputRange: [0, 100],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      </View>
    </View>
  );
}
