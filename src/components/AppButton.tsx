/**
 * Ersetzt React Natives eingebautes `<Button>` (lässt sich nicht stylen —
 * kein Padding/Radius/Schatten) durch einen Pressable mit Press-Feedback und
 * drei Varianten.
 *
 * @format
 */

import { useMemo } from 'react';
import { Pressable, Text } from 'react-native';
import { useThemeColors } from '../theme';
import { getStyles } from '../styles';

export function AppButton({
  title,
  onPress,
  disabled,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => getStyles(colors), [colors]);
  const variantStyle =
    variant === 'primary'
      ? styles.appButtonPrimary
      : variant === 'danger'
        ? styles.appButtonDanger
        : styles.appButtonSecondary;
  const textStyle =
    variant === 'primary'
      ? styles.appButtonPrimaryText
      : variant === 'danger'
        ? styles.appButtonDangerText
        : styles.appButtonSecondaryText;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.appButtonBase,
        variantStyle,
        disabled ? styles.appButtonDisabled : pressed && styles.appButtonPressed,
      ]}
    >
      <Text style={[styles.appButtonText, textStyle]}>{title}</Text>
    </Pressable>
  );
}
