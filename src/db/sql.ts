/**
 * Minimaler SQL-Port.
 *
 * Warum eine eigene Schnittstelle statt direkt gegen `@op-engineering/op-sqlite`
 * zu programmieren: op-sqlite ist ein natives JSI-Modul und lässt sich in Jest
 * nicht laden. Die mitgelieferte Node-Fassade (`node/dist/index.js`) ist in
 * 18.1.4 defekt — sie importiert `"./database"` ohne `.js`-Endung, was Node im
 * ESM-Modus mit ERR_MODULE_NOT_FOUND ablehnt.
 *
 * Repository und Migrationen sprechen deshalb nur dieses Interface. In der App
 * wird op-sqlites `DB` übergeben (erfüllt es strukturell, siehe database.ts),
 * in den Tests ein Adapter auf Nodes eingebautes `node:sqlite`
 * (siehe __tests__/db.test.ts). Damit sind alle Queries ohne Simulator testbar
 * — genau der Nutzen, den die Node-Fassade haben sollte.
 *
 * @format
 */

/** Was an SQLite gebunden werden darf. Booleans werden als 0/1 gespeichert. */
export type SqlValue = string | number | null;

export type SqlRow = Record<string, unknown>;

export type SqlQueryResult = {
  rows: SqlRow[];
  rowsAffected: number;
};

/** Kann Statements ausführen — sowohl die DB selbst als auch eine Transaktion. */
export interface SqlExecutor {
  execute(sql: string, params?: SqlValue[]): Promise<SqlQueryResult>;
}

export interface SqlDatabase extends SqlExecutor {
  transaction(fn: (tx: SqlExecutor) => Promise<void>): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Lese-Helfer: SQLite-Spalten sind untypisiert (`unknown`), hier      */
/* einmal zentral in die erwarteten JS-Typen überführt.               */
/* ------------------------------------------------------------------ */

export function readText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function readNullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** SQLite kennt kein BOOLEAN — gespeichert wird 0/1. */
export function readBoolean(value: unknown): boolean {
  return value === 1 || value === true;
}

export function toSqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}
