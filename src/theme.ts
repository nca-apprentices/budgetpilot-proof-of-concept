/**
 * Farb-Theme (Light/Dark) inkl. Dark-Mode-Override aus dem Settings-Tab.
 *
 * @format
 */

import { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import RNFS from 'react-native-fs';

export const DANGER_COLOR = '#dc2626';
export const CAUTION_COLOR = '#f5a623';

// Dark-Mode-Umschalter (Settings-Tab) — überschreibt das System-Theme, ohne
// useColorScheme() selbst zu verändern (nicht möglich). Der State lebt in
// App() (Quelle der Wahrheit, siehe dort), Nachfahren lesen ihn per Context
// statt per Prop-Drilling durch jede Screen-Komponente — useThemeColors()
// wird bereits unabhängig von jeder Komponente aufgerufen.
export const DarkModeOverrideContext = createContext<{
  isDarkMode: boolean;
  setIsDarkMode: (value: boolean) => void;
} | null>(null);

// Persistiert die getroffene Wahl über einen App-Neustart hinweg (vorher
// fiel der Schalter nach jedem Neustart auf das System-Theme zurück —
// Nutzer-Feedback). Bewusst als eigene Textdatei statt in der SQLite-DB:
// eine einzelne globale Einstellung passt nicht ins monatsbezogene
// Budget-Schema, und dasselbe RNFS-Datei-Muster wird schon für den
// toppreise.ch-Cache verwendet (siehe toppreise.ts). Kein Wert auf der
// Platte heisst "noch nie manuell gesetzt", dann bleibt das System-Theme
// der Standard (siehe App()).
const DARK_MODE_PREFERENCE_FILE = 'dark-mode-preference.txt';

export async function readPersistedDarkMode(): Promise<boolean | null> {
  try {
    const path = `${RNFS.DocumentDirectoryPath}/${DARK_MODE_PREFERENCE_FILE}`;
    if (!(await RNFS.exists(path))) {
      return null;
    }
    return (await RNFS.readFile(path, 'utf8')).trim() === 'true';
  } catch (e) {
    console.warn('[settings] Dark-Mode-Einstellung nicht lesbar:', e);
    return null;
  }
}

export function writePersistedDarkMode(value: boolean): void {
  RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/${DARK_MODE_PREFERENCE_FILE}`,
    String(value),
    'utf8',
  ).catch(e => {
    console.warn('[settings] Dark-Mode-Einstellung nicht speicherbar:', e);
  });
}

// Theme-Farben für Dark Mode — vorher wurde `isDarkMode` nur für die
// StatusBar-Icons genutzt, alle Text-/Rahmenfarben waren fest auf helle
// Werte codiert (z.B. dunkelgraue Schrift ohne gesetzten Hintergrund),
// dadurch auf einem dunklen System-Theme kaum lesbar (bestätigt auf echtem
// Android-Gerät). `getStyles()` wird jetzt in jeder Screen-Komponente über
// `useThemeColors()` neu berechnet, sobald sich `useColorScheme()` ändert.
export function computeThemeColors(isDarkMode: boolean) {
  return {
    isDarkMode,
    // Canvas leicht vom Karten-Hintergrund (surface) abgesetzt, statt
    // beides gleich — dadurch wirken Karten/Inputs als eigene Ebene statt
    // nur als Rahmen auf derselben Fläche ("Material"-artige Optik).
    background: isDarkMode ? '#0f1115' : '#f4f5f7',
    surface: isDarkMode ? '#1b1e24' : '#ffffff',
    surfaceRaised: isDarkMode ? '#22262e' : '#ffffff',
    text: isDarkMode ? '#f2f3f5' : '#12151a',
    textMuted: isDarkMode ? '#9aa1ac' : '#6b7280',
    textSubtle: isDarkMode ? '#b7bdc7' : '#4b5563',
    chipText: isDarkMode ? '#e6e8eb' : '#374151',
    border: isDarkMode ? '#3a3f47' : '#dde1e6',
    borderSubtle: isDarkMode ? '#282c33' : '#eceef1',
    inputBackground: isDarkMode ? '#22262e' : '#ffffff',
    previewBackground: isDarkMode ? '#22262e' : '#f0f1f3',
    placeholder: isDarkMode ? '#767c87' : '#9aa1ac',
    shadow: isDarkMode ? '#000000' : '#1f2937',
    // Etwas heller im Dark Mode für genug Kontrast auf dunklem Grund —
    // einzige Stelle, an der der Akzent je nach Theme variiert, alle
    // anderen Verwendungen greifen einheitlich auf colors.accent zu statt
    // wie vorher '#2563eb' an >10 Stellen im Code zu wiederholen.
    accent: isDarkMode ? '#5b93f5' : '#2563eb',
    accentSoft: isDarkMode ? 'rgba(91,147,245,0.18)' : 'rgba(37,99,235,0.1)',
  };
}

// Respektiert den Dark-Mode-Override aus dem Settings-Tab (siehe
// DarkModeOverrideContext), fällt ohne Override (Kontext fehlt — sollte in
// der App nie vorkommen, App() setzt ihn immer) auf das System-Theme zurück.
export function useThemeColors() {
  const systemIsDarkMode = useColorScheme() === 'dark';
  const override = useContext(DarkModeOverrideContext);
  const isDarkMode = override ? override.isDarkMode : systemIsDarkMode;
  return useMemo(() => computeThemeColors(isDarkMode), [isDarkMode]);
}
