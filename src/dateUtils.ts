/**
 * Reine Datums-Helfer — Kaufdatum-Freitext (TT.MM.JJJJ) und Monats-
 * Navigation für den Budget-Tab. Kein Datums-Picker, um keine weitere
 * native Dependency einzuführen (siehe CLAUDE.md Datenmodell).
 *
 * @format
 */

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatDateDMY(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

// "2026-09" + 1 -> "2026-10", "2026-01" - 1 -> "2025-12". Der Tag spielt für
// Monats-Arithmetik keine Rolle — day 1 verhindert, dass z.B. der 31. Januar
// beim +1-Monat auf den 3. März überläuft (JS-Date normalisiert überzählige
// Tage automatisch in den Folgemonat statt zu clampen).
export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split('-').map(Number);
  const shifted = new Date(year, mon - 1 + delta, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`;
}

export function formatMonthLabel(month: string): string {
  const [year, mon] = month.split('-').map(Number);
  const date = new Date(year, mon - 1, 1);
  return date.toLocaleDateString('de-CH', { month: 'long', year: 'numeric' });
}

// Kurze Monatsnamen ("Jan", "Feb", …) fürs 12er-Raster im Monats-Popup —
// über toLocaleDateString statt hartcodierter Liste, damit es zur selben
// de-CH-Lokalisierung wie formatMonthLabel() passt.
export const MONTH_SHORT_NAMES = Array.from({ length: 12 }, (_, i) =>
  new Date(2000, i, 1).toLocaleDateString('de-CH', { month: 'short' }),
);

// Robust: akzeptiert "TT.MM.JJJJ", füllt einstellige Tag/Monat-Angaben auf.
// Gibt null zurück statt zu werfen, wenn der Text nicht als Datum lesbar ist.
export function parseDateDMY(text: string): string | null {
  const match = text.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) {
    return null;
  }
  const [, day, month, year] = match;
  const dayNum = Number(day);
  const monthNum = Number(month);
  if (dayNum < 1 || dayNum > 31 || monthNum < 1 || monthNum > 12) {
    return null;
  }
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// Sucht ein "TT.MM.JJJJ"-Datum irgendwo im Freitext (z.B. "Miete 15.09.2025")
// statt es beim Extrahieren still zu verwerfen und immer das heutige Datum
// vorzuschlagen. Bewusst per Regex statt übers LLM erkannt — deterministisch,
// kein Hallucinationsrisiko, kein zusätzlicher Modell-Aufruf nötig.
export function findDateInText(text: string): string | null {
  const match = text.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
  return match ? parseDateDMY(match[1]) : null;
}
