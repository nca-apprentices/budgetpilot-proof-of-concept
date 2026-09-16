/**
 * App-weite UI-Typen, die von mehreren Screens/Komponenten gemeinsam
 * gebraucht werden (nicht Teil des Datenmodells, siehe budget.ts/db/types.ts
 * dafür).
 *
 * @format
 */

export type Screen = 'expense' | 'budget' | 'calendar' | 'price' | 'llmTest' | 'settings';

// Ein offenes "Rückgängig"-Banner — siehe App()s triggerUndo(). `key` sorgt
// für einen sauberen Remount von UndoSnackbar (frischer Timer/Animation) bei
// jedem neuen Aufruf, auch wenn kurz hintereinander zwei Undo-fähige
// Aktionen passieren.
export type UndoState = {
  key: number;
  message: string;
  onUndo: () => void;
  onExpire: () => void;
};
