/**
 * Fortschrittsbalken für den Modell-Download.
 *
 * @format
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { useThemeColors } from '../theme';
import { getStyles } from '../styles';

const PROGRESS_SAMPLE_INTERVAL_MS = 1000;

// Der native Download-Callback feuert viel häufiger als jede Änderung
// sichtbar gemacht werden sollte — ungefiltert durchgereicht flackert die
// Prozentzahl mehrmals pro Sekunde. Hier wird nur der jeweils aktuellste
// Wert alle 250ms übernommen, statt bei jedem einzelnen Event neu zu rendern.
function useSampledProgress(value: number, intervalMs: number): number {
  const latestRef = useRef(value);
  latestRef.current = value;
  const [sampled, setSampled] = useState(value);

  useEffect(() => {
    const id = setInterval(() => setSampled(latestRef.current), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return sampled;
}

export function DownloadProgressBar({ progress }: { progress: number }) {
  // `progress` ist ein Bruch (0–1), keine fertige Prozentzahl.
  const sampled = useSampledProgress(progress, PROGRESS_SAMPLE_INTERVAL_MS);
  const percent = Math.min(100, Math.max(0, Math.round(sampled * 100)));
  const animatedWidth = useRef(new Animated.Value(percent)).current;
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);

  useEffect(() => {
    Animated.timing(animatedWidth, {
      toValue: percent,
      duration: PROGRESS_SAMPLE_INTERVAL_MS,
      useNativeDriver: false, // 'width' unterstützt keinen Native Driver
    }).start();
  }, [percent, animatedWidth]);

  return (
    <View style={styles.progressRow}>
      <View style={styles.progressTrack}>
        <Animated.View
          style={[
            styles.progressFill,
            {
              width: animatedWidth.interpolate({
                inputRange: [0, 100],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      </View>
      <Text style={styles.progressLabel}>{percent}%</Text>
    </View>
  );
}
