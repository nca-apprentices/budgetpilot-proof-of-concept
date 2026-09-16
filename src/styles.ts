/**
 * Zentrales StyleSheet — als Fabrikfunktion statt statischer Konstante,
 * damit jede Screen-Komponente sie über `useThemeColors()` neu berechnen
 * kann, sobald sich das Theme (System oder Dark-Mode-Override) ändert.
 *
 * @format
 */

import { StyleSheet } from 'react-native';
import { CAUTION_COLOR, DANGER_COLOR, type useThemeColors } from './theme';

export function getStyles(colors: ReturnType<typeof useThemeColors>) {
  // Der Undo-Banner invertiert seinen Hintergrund bewusst gegenüber dem
  // Theme (siehe undoBanner unten) — der Akzent darauf braucht deshalb
  // ebenfalls die umgekehrte Variante, sonst zu wenig Kontrast auf einem im
  // Dark Mode plötzlich hellen Banner.
  const undoAccent = colors.isDarkMode ? '#2563eb' : '#60a5fa';

  return StyleSheet.create({
    appContainer: {
      flex: 1,
      backgroundColor: colors.background,
    },
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    // Vollflächiger Platzhalter, solange die DB öffnet bzw. wenn sie ausfällt.
    dbGate: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    // Schreibfehler nach dem Start: die App bleibt benutzbar, der Hinweis
    // sitzt aber über allen Screens, damit er nicht übersehen wird.
    dbBanner: {
      fontSize: 13,
      fontWeight: '500',
      color: '#fff',
      backgroundColor: DANGER_COLOR,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    tabBar: {
      // flexGrow: 0 — sonst füllt die horizontale ScrollView die ganze Höhe.
      flexGrow: 0,
      flexShrink: 0,
      backgroundColor: colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderSubtle,
    },
    tabBarContent: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingBottom: 14,
    },
    tabButton: {
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 20,
      marginRight: 8,
    },
    tabButtonActive: {
      backgroundColor: colors.accent,
      shadowColor: colors.shadow,
      shadowOpacity: 0.25,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
      elevation: 3,
    },
    tabText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textMuted,
    },
    tabTextActive: {
      color: '#fff',
    },
    tabScrollTrack: {
      height: 3,
      backgroundColor: colors.borderSubtle,
    },
    tabScrollThumb: {
      height: 3,
      borderRadius: 1.5,
      backgroundColor: colors.accent,
    },
    title: {
      fontSize: 20,
      fontWeight: '800',
      letterSpacing: -0.3,
      marginBottom: 6,
      color: colors.text,
    },
    status: {
      fontSize: 14,
      lineHeight: 20,
      color: colors.textMuted,
      marginBottom: 18,
    },
    receiptPreview: {
      width: '100%',
      height: 260,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.borderSubtle,
      marginBottom: 18,
      backgroundColor: colors.previewBackground,
      shadowColor: colors.shadow,
      shadowOpacity: 0.08,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
    progressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: -8,
      marginBottom: 16,
    },
    progressTrack: {
      flex: 1,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.borderSubtle,
      overflow: 'hidden',
    },
    progressLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textMuted,
      marginLeft: 8,
      minWidth: 34,
      textAlign: 'right',
    },
    progressFill: {
      height: '100%',
      borderRadius: 4,
      backgroundColor: colors.accent,
    },
    undoBanner: {
      position: 'absolute',
      left: 16,
      right: 16,
      borderRadius: 14,
      overflow: 'hidden',
      backgroundColor: colors.text,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 5,
    },
    undoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 14,
      paddingHorizontal: 18,
    },
    undoText: {
      flex: 1,
      fontSize: 14,
      color: colors.background,
      marginRight: 12,
    },
    undoAction: {
      fontSize: 14,
      fontWeight: '700',
      color: undoAccent,
    },
    undoTrack: {
      height: 3,
      backgroundColor: 'rgba(255,255,255,0.25)',
    },
    undoFill: {
      height: '100%',
      backgroundColor: undoAccent,
    },
    buttonRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 22,
      marginBottom: 8,
    },
    buttonWrapper: {
      marginRight: 10,
      marginBottom: 10,
    },
    // Basis-Look der AppButton-Komponente (ersetzt die native <Button>).
    appButtonBase: {
      paddingVertical: 12,
      paddingHorizontal: 20,
      borderRadius: 12,
      minHeight: 46,
      alignItems: 'center',
      justifyContent: 'center',
    },
    appButtonPrimary: {
      backgroundColor: colors.accent,
      shadowColor: colors.shadow,
      shadowOpacity: 0.22,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 3,
    },
    appButtonSecondary: {
      backgroundColor: colors.accentSoft,
    },
    appButtonDanger: {
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderColor: DANGER_COLOR,
    },
    appButtonDisabled: {
      opacity: 0.4,
      shadowOpacity: 0,
      elevation: 0,
    },
    appButtonPressed: {
      opacity: 0.82,
    },
    appButtonText: {
      fontSize: 15,
      fontWeight: '700',
    },
    appButtonPrimaryText: {
      color: '#ffffff',
    },
    appButtonSecondaryText: {
      color: colors.accent,
    },
    appButtonDangerText: {
      color: DANGER_COLOR,
    },
    label: {
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: 18,
      marginBottom: 2,
      color: colors.textMuted,
    },
    monthSelectorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 4,
    },
    monthArrowButton: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 12,
      backgroundColor: colors.surface,
    },
    monthArrowText: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.accent,
    },
    monthLabel: {
      flex: 1,
      textAlign: 'center',
      fontSize: 17,
      fontWeight: '700',
      color: colors.text,
    },
    monthLabelButton: {
      flex: 1,
    },
    monthPickerBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 24,
    },
    monthPickerCard: {
      width: '100%',
      maxWidth: 360,
      backgroundColor: colors.surfaceRaised,
      borderRadius: 20,
      padding: 20,
      shadowColor: colors.shadow,
      shadowOpacity: 0.3,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 8 },
      elevation: 8,
    },
    monthGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      marginTop: 16,
    },
    monthGridCell: {
      width: '30%',
      paddingVertical: 14,
      borderRadius: 12,
      alignItems: 'center',
      marginBottom: 10,
      backgroundColor: colors.surface,
    },
    monthGridCellActive: {
      backgroundColor: colors.accent,
    },
    monthGridCellText: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.text,
    },
    monthGridCellTextActive: {
      color: '#ffffff',
    },
    manualEditBadge: {
      fontSize: 11,
      fontWeight: '500',
      textTransform: 'none',
      letterSpacing: 0,
      fontStyle: 'italic',
      color: colors.textMuted,
    },
    input: {
      fontSize: 15,
      marginTop: 4,
      minHeight: 46,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      padding: 12,
      textAlignVertical: 'top',
      color: colors.text,
      backgroundColor: colors.inputBackground,
    },
    response: {
      fontSize: 13,
      lineHeight: 19,
      marginTop: 6,
      color: colors.text,
    },
    errorText: {
      fontSize: 13,
      fontWeight: '500',
      color: DANGER_COLOR,
      marginTop: 8,
    },
    lowConfidenceBorder: {
      borderColor: CAUTION_COLOR,
      borderWidth: 1.5,
    },
    needsInputBorder: {
      borderColor: DANGER_COLOR,
      borderWidth: 1.5,
    },
    needsInputHint: {
      fontSize: 12,
      fontWeight: '500',
      color: DANGER_COLOR,
      marginTop: 4,
    },
    warningBox: {
      borderRadius: 10,
      borderLeftWidth: 4,
      paddingVertical: 12,
      paddingHorizontal: 14,
      marginTop: 10,
    },
    warningText: {
      fontSize: 13,
      fontWeight: '600',
      lineHeight: 18,
    },
    lineItemRow: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      marginTop: 8,
      shadowColor: colors.shadow,
      shadowOpacity: 0.05,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    },
    priceCard: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 18,
      marginTop: 10,
      shadowColor: colors.shadow,
      shadowOpacity: 0.08,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
    priceHero: {
      fontSize: 30,
      fontWeight: '800',
      letterSpacing: -0.5,
      color: colors.text,
      marginBottom: 4,
    },
    link: {
      fontSize: 13,
      color: colors.accent,
      fontWeight: '600',
      marginTop: 10,
    },
    sourceNote: {
      fontSize: 11,
      color: colors.textMuted,
      marginTop: 16,
      lineHeight: 15,
    },
    lineItemDescription: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.text,
    },
    lineItemMeta: {
      fontSize: 13,
      color: colors.textMuted,
      marginTop: 3,
    },
    segmentRow: {
      flexDirection: 'row',
      marginTop: 6,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    segmentButton: {
      flex: 1,
      paddingVertical: 11,
      alignItems: 'center',
    },
    segmentButtonActive: {
      backgroundColor: colors.accent,
    },
    segmentText: {
      fontSize: 14,
      fontWeight: '500',
      color: colors.chipText,
    },
    segmentTextActive: {
      color: '#fff',
      fontWeight: '700',
    },
    chipContainer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginTop: 6,
      padding: 6,
      borderWidth: 1,
      borderColor: 'transparent',
      borderRadius: 14,
      backgroundColor: colors.surface,
    },
    chip: {
      paddingVertical: 7,
      paddingHorizontal: 14,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
      marginRight: 8,
      marginBottom: 8,
    },
    chipSelected: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    chipText: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.chipText,
    },
    chipTextSelected: {
      color: '#fff',
      fontWeight: '700',
    },
  });
}
