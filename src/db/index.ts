/**
 * Öffnet die lokale SQLite-Datenbank (op-sqlite, JSI — kein Bridge-Overhead,
 * wichtig weil Gemma-Inferenz und DB-Zugriffe sich dieselbe CPU teilen).
 *
 * Einmal beim App-Start aufrufen (siehe App.tsx) und das Ergebnis
 * weiterverwenden — `open()` pro Query wäre unnötig teuer und würde die
 * PRAGMA-Einstellungen unten jedes Mal neu brauchen.
 *
 * Die Datei liegt im App-Sandbox-Verzeichnis, also lokal auf dem Gerät und
 * ohne Netzwerk — dieselbe Privacy-by-Design-Zusage wie bei der Inferenz.
 *
 * @format
 */

import { open } from '@op-engineering/op-sqlite';
import { migrate } from './schema';
import type { SqlDatabase } from './sql';

const DATABASE_NAME = 'budgetpilot.sqlite';

let database: SqlDatabase | null = null;

/**
 * Idempotent: gibt bei mehrfachem Aufruf (Fast Refresh, doppelt gemounteter
 * Effect im StrictMode) dieselbe Verbindung zurück.
 */
export async function initDatabase(): Promise<SqlDatabase> {
  if (database) {
    return database;
  }

  const db = open({ name: DATABASE_NAME });

  // MUSS pro Verbindung gesetzt werden — SQLite hat Fremdschlüssel aus
  // Kompatibilitätsgründen standardmässig AUS. Ohne das hier macht
  // `ON DELETE CASCADE` in schema.ts stillschweigend nichts.
  await db.execute('PRAGMA foreign_keys = ON');
  // WAL: Lesen blockiert nicht mehr gegen Schreiben. Relevant, sobald ein
  // Screen liest, während eine Extraktion noch speichert.
  await db.execute('PRAGMA journal_mode = WAL');

  const version = await migrate(db);
  console.log(`[db] ${DATABASE_NAME} bereit, Schema-Version ${version}.`);

  database = db;
  return db;
}

/** Nur nach erfolgreichem initDatabase() aufrufen. */
export function getDatabase(): SqlDatabase {
  if (!database) {
    throw new Error('initDatabase() wurde noch nicht aufgerufen.');
  }
  return database;
}

export * from './mapping';
export * from './repository';
export * from './types';
export type { SqlDatabase, SqlExecutor } from './sql';
