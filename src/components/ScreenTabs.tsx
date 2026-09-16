/**
 * Horizontal scrollbare Tab-Leiste mit eigenem, dauerhaft sichtbarem
 * Scroll-Positions-Indikator (der native `showsHorizontalScrollIndicator`
 * blendet zu schnell aus, siehe CLAUDE.md Lessons Learned).
 *
 * @format
 */

import { useMemo, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Screen } from '../types';
import { useThemeColors } from '../theme';
import { getStyles } from '../styles';

export function ScreenTabs({
  screen,
  onChange,
}: {
  screen: Screen;
  onChange: (s: Screen) => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const tabs: { key: Screen; label: string }[] = [
    { key: 'expense', label: 'Ausgabe erfassen' },
    { key: 'budget', label: 'Budget' },
    { key: 'calendar', label: 'Kalender' },
    { key: 'price', label: 'Preise' },
    { key: 'llmTest', label: 'LLM-Test' },
    { key: 'settings', label: 'Einstellungen' },
  ];

  // Schmaler, farbiger Scroll-Indikator unter der Tab-Leiste (eigenes,
  // schlichteres Pendant zu showsHorizontalScrollIndicator — der native
  // Indikator ist zu unauffällig/grau und blendet meist gleich wieder aus).
  // Signalisiert neuen Nutzern, dass hier mehr als die sichtbaren Tabs
  // liegen und wandert proportional zur Scroll-Position mit.
  const scrollX = useRef(new Animated.Value(0)).current;
  const [contentWidth, setContentWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const showScrollThumb = contentWidth > viewportWidth && viewportWidth > 0;
  const thumbWidth = showScrollThumb
    ? Math.max(28, (viewportWidth / contentWidth) * viewportWidth)
    : 0;
  const maxScrollX = Math.max(contentWidth - viewportWidth, 1);
  const maxThumbTravel = Math.max(viewportWidth - thumbWidth, 0);
  const thumbTranslate = scrollX.interpolate({
    inputRange: [0, maxScrollX],
    outputRange: [0, maxThumbTravel],
    extrapolate: 'clamp',
  });

  // Horizontal scrollbar: ab 5 Tabs passen die Labels nicht mehr auf ein
  // iPhone — vorher wurde "LLM-Test" am rechten Rand abgeschnitten.
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        onLayout={e => setViewportWidth(e.nativeEvent.layout.width)}
        onContentSizeChange={w => setContentWidth(w)}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { x: scrollX } } }],
          { useNativeDriver: false },
        )}
        scrollEventThrottle={16}
        style={[styles.tabBar, { paddingTop: insets.top + 12 }]}
        contentContainerStyle={styles.tabBarContent}
      >
        {tabs.map(tab => (
          <Pressable
            key={tab.key}
            style={[
              styles.tabButton,
              screen === tab.key && styles.tabButtonActive,
            ]}
            onPress={() => onChange(tab.key)}
          >
            <Text
              style={[styles.tabText, screen === tab.key && styles.tabTextActive]}
            >
              {tab.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {showScrollThumb && (
        <View style={styles.tabScrollTrack}>
          <Animated.View
            style={[
              styles.tabScrollThumb,
              { width: thumbWidth, transform: [{ translateX: thumbTranslate }] },
            ]}
          />
        </View>
      )}
    </View>
  );
}
