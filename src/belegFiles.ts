/**
 * Aufräum-Hilfsfunktionen für Beleg-Fotos in RNFS.DocumentDirectoryPath —
 * dieser Ordner wird von Android/iOS NICHT automatisch bereinigt (bewusst,
 * siehe CLAUDE.md Lessons Learned zum CachesDirectoryPath-Bug).
 *
 * Zwei getrennte Namensräume mit unterschiedlicher Lebensdauer:
 * - "beleg-scan-…": ein frisch gescanntes/hochgeladenes Foto, bevor der
 *   Entwurf bestätigt wurde — reiner Zwischenstand, wird beim Bestätigen zum
 *   stabilen Dateinamen befördert (siehe processBelegUri/handleBestaetigen)
 *   oder beim Verwerfen gelöscht. Nur DIESER Namensraum wird von den
 *   Aufräum-Funktionen unten angefasst.
 * - "beleg-item-<id>.jpg": das dauerhafte Beleg-Foto eines bereits
 *   bestätigten Postens (LineItem.photoFilename) — bleibt erhalten, bis eine
 *   neue Quittung gescannt wird (ersetzt die Datei unter demselben Namen)
 *   oder der Posten gelöscht wird. Absichtlich ausserhalb der
 *   Aufräum-Funktionen, sonst würde z.B. das 24h-Sicherheitsnetz irgendwann
 *   echte, noch verknüpfte Beleg-Fotos löschen.
 *
 * @format
 */

import RNFS from 'react-native-fs';

export const BELEG_TEMP_PREFIX = 'beleg-scan-';

export function stableBelegFilename(itemId: string): string {
  return `beleg-item-${itemId}.jpg`;
}

async function listTempBelegFiles() {
  try {
    const entries = await RNFS.readDir(RNFS.DocumentDirectoryPath);
    return entries.filter(entry => entry.isFile() && entry.name.startsWith(BELEG_TEMP_PREFIX));
  } catch (e) {
    console.error('[beleg-cleanup] Verzeichnis konnte nicht gelesen werden:', e);
    return [];
  }
}

// Löschen darf den eigentlichen Foto-Erfassungs-Flow nie blockieren oder zum
// Absturz bringen — die Datei könnte bereits gelöscht sein oder nie
// existiert haben, das ist unkritisch.
export async function deleteBelegFile(path: string): Promise<void> {
  try {
    await RNFS.unlink(path);
  } catch {
    // Absichtlich ignoriert, siehe Kommentar oben.
  }
}

// Vor jedem neuen Scan alle bisherigen Zwischenstände löschen: pro Zeitpunkt
// ist immer nur ein Entwurf aktiv (siehe CLAUDE.md Status, "bewusst ohne
// Persistenz"), eine übrig gebliebene ältere Temp-Datei kann also nur von
// einem vorherigen Absturz/Fast-Refresh-Reload stammen.
export async function cleanupTempBelegFiles(): Promise<void> {
  const files = await listTempBelegFiles();
  await Promise.all(files.map(file => deleteBelegFile(file.path)));
}

// Sicherheitsnetz beim App-Start (siehe App()): fängt Temp-Datei-Leichen ab,
// falls das Löschen beim Verwerfen/Bestätigen mal durch einen Absturz
// übersprungen wurde. Betrifft NICHT die dauerhaften Beleg-Fotos bestätigter
// Posten (siehe Kommentar oben) — die haben kein Alterslimit.
export async function cleanupOldTempBelegFiles(maxAgeMs: number): Promise<void> {
  const files = await listTempBelegFiles();
  const cutoff = Date.now() - maxAgeMs;
  const stale = files.filter(file => file.mtime !== undefined && file.mtime.getTime() < cutoff);
  await Promise.all(stale.map(file => deleteBelegFile(file.path)));
}
