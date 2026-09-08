/**
 * Schema + Migrationen.
 *
 * Versionierung über `PRAGMA user_version` (ein Integer, den SQLite selbst im
 * Datei-Header mitführt — kein eigenes Meta-Table nötig).
 *
 * REGEL: Eine ausgelieferte Migration wird NIE mehr geändert, nur angehängt.
 * Sonst laufen Geräte, die die alte Version schon angewendet haben, auf einem
 * anderen Schema als frisch installierte — und auf einem echten Gerät
 * (iPhone 12, Galaxy S21 FE) hilft dann nur noch Deinstallieren.
 *
 * Geldspalten sind INTEGER (Rappen), nie REAL — siehe types.ts.
 *
 * @format
 */

import type { SqlDatabase } from './sql';
import { readNumber } from './sql';

export type Migration = {
  version: number;
  /** Wird komplett in EINER Transaktion angewendet — alles oder nichts. */
  statements: string[];
};

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE budget_months (
         id           TEXT    PRIMARY KEY NOT NULL,
         month        TEXT    NOT NULL UNIQUE,
         income_cents INTEGER,
         currency     TEXT    NOT NULL DEFAULT 'CHF',
         created_at   TEXT    NOT NULL,
         updated_at   TEXT    NOT NULL,
         CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
       )`,

      `CREATE TABLE line_items (
         id           TEXT    PRIMARY KEY NOT NULL,
         month_id     TEXT    NOT NULL REFERENCES budget_months(id) ON DELETE CASCADE,
         kind         TEXT    NOT NULL CHECK (kind IN ('income_deduction','fixed_cost','planned_purchase','expense')),
         description  TEXT    NOT NULL,
         amount_cents INTEGER,
         currency     TEXT    NOT NULL DEFAULT 'CHF',
         cadence      TEXT    NOT NULL CHECK (cadence IN ('monthly','one_time')),
         category     TEXT,
         source       TEXT    NOT NULL CHECK (source IN ('free_text','manual','toppreise')),
         confidence   REAL,
         reason       TEXT,
         needs_input  INTEGER NOT NULL DEFAULT 0 CHECK (needs_input IN (0,1)),
         user_edited  INTEGER NOT NULL DEFAULT 0 CHECK (user_edited IN (0,1)),
         notes        TEXT,
         date         TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
         created_at   TEXT    NOT NULL,
         updated_at   TEXT    NOT NULL
       )`,

      // month_id: jede Budget-Ansicht filtert danach.
      `CREATE INDEX idx_line_items_month_id ON line_items(month_id)`,
      // date: der Kalender-Tab liest nach Datum gruppiert.
      `CREATE INDEX idx_line_items_date ON line_items(date)`,

      `CREATE TABLE price_results (
         id           TEXT    PRIMARY KEY NOT NULL,
         line_item_id TEXT    REFERENCES line_items(id) ON DELETE SET NULL,
         query        TEXT    NOT NULL,
         product_name TEXT    NOT NULL,
         price_cents  INTEGER NOT NULL,
         currency     TEXT    NOT NULL DEFAULT 'CHF',
         shop         TEXT,
         url          TEXT,
         fetched_at   TEXT    NOT NULL
       )`,

      `CREATE INDEX idx_price_results_query ON price_results(query)`,
    ],
  },
  {
    // Migration 1s CHECK-Constraint auf line_items.source erlaubt nur
    // 'free_text' | 'manual' | 'toppreise' — 'photo' fehlt (LineItem['source']
    // in budget.ts kennt es aber, siehe Kamera-Feature). Bestätigen eines per
    // Foto erfassten Belegs schlug dadurch mit einem CHECK-Constraint-Fehler
    // fehl. SQLite kann eine CHECK-Constraint nicht per ALTER TABLE ändern —
    // Standard-Workaround: Tabelle mit korrigierter Constraint neu anlegen,
    // Daten kopieren, alte Tabelle löschen, neue umbenennen. Bewusst in
    // dieser Reihenfolge (erst DROP der alten `line_items`, danach erst die
    // neue Tabelle daraufhin umbenennen) statt die alte Tabelle vorher
    // umzubenennen — sonst schreibt SQLite die FK-Referenz in
    // price_results.line_item_id automatisch auf den alten Zwischennamen um
    // und sie zeigt danach ins Leere.
    version: 2,
    statements: [
      `CREATE TABLE line_items_v2 (
         id           TEXT    PRIMARY KEY NOT NULL,
         month_id     TEXT    NOT NULL REFERENCES budget_months(id) ON DELETE CASCADE,
         kind         TEXT    NOT NULL CHECK (kind IN ('income_deduction','fixed_cost','planned_purchase','expense')),
         description  TEXT    NOT NULL,
         amount_cents INTEGER,
         currency     TEXT    NOT NULL DEFAULT 'CHF',
         cadence      TEXT    NOT NULL CHECK (cadence IN ('monthly','one_time')),
         category     TEXT,
         source       TEXT    NOT NULL CHECK (source IN ('free_text','photo','manual','toppreise')),
         confidence   REAL,
         reason       TEXT,
         needs_input  INTEGER NOT NULL DEFAULT 0 CHECK (needs_input IN (0,1)),
         user_edited  INTEGER NOT NULL DEFAULT 0 CHECK (user_edited IN (0,1)),
         notes        TEXT,
         date         TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
         created_at   TEXT    NOT NULL,
         updated_at   TEXT    NOT NULL
       )`,

      `INSERT INTO line_items_v2 (
         id, month_id, kind, description, amount_cents, currency, cadence,
         category, source, confidence, reason, needs_input, user_edited,
         notes, date, created_at, updated_at
       )
       SELECT
         id, month_id, kind, description, amount_cents, currency, cadence,
         category, source, confidence, reason, needs_input, user_edited,
         notes, date, created_at, updated_at
       FROM line_items`,

      `DROP TABLE line_items`,

      `ALTER TABLE line_items_v2 RENAME TO line_items`,

      `CREATE INDEX idx_line_items_month_id ON line_items(month_id)`,
      `CREATE INDEX idx_line_items_date ON line_items(date)`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

async function readUserVersion(db: SqlDatabase): Promise<number> {
  const result = await db.execute('PRAGMA user_version');
  return readNumber(result.rows[0]?.user_version, 0);
}

/**
 * Wendet alle noch fehlenden Migrationen an. Idempotent — mehrfacher Aufruf
 * (z. B. nach einem Fast-Refresh) ist ein No-op.
 *
 * `PRAGMA user_version = ?` akzeptiert keine Bind-Parameter, die Zahl muss in
 * den SQL-Text interpoliert werden. Sie kommt aus MIGRATIONS (Konstanten im
 * Code, keine Nutzereingabe), ist also kein Injection-Vektor.
 */
export async function migrate(db: SqlDatabase): Promise<number> {
  const current = await readUserVersion(db);

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    await db.transaction(async tx => {
      for (const statement of migration.statements) {
        await tx.execute(statement);
      }
      await tx.execute(`PRAGMA user_version = ${migration.version}`);
    });
    console.log(`[db] Migration ${migration.version} angewendet.`);
  }

  return readUserVersion(db);
}
