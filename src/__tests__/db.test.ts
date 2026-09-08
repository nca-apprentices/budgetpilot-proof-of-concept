/**
 * Tests der Persistenzschicht — laufen OHNE Simulator.
 *
 * op-sqlite selbst ist ein natives JSI-Modul und in Jest nicht ladbar; seine
 * Node-Fassade ist in 18.1.4 defekt (siehe src/db/sql.ts). Stattdessen wird
 * hier Nodes eingebautes `node:sqlite` hinter denselben SqlDatabase-Port
 * gehängt. Getestet wird damit echtes SQLite mit echtem SQL — nur die
 * Bindings unterscheiden sich von der App.
 *
 * WICHTIG: hier NIE `../db` (index.ts) importieren, das zieht op-sqlite nach.
 *
 * @format
 */

import { DatabaseSync } from 'node:sqlite';

import { computeBudget } from '../budgetEngine';
import type { LineItem } from '../budget';
import {
  addLineItems,
  computeTotals,
  deleteLineItem,
  getMonth,
  getOrCreateMonth,
  listItemsNeedingReview,
  listLineItems,
  listLineItemsForMonth,
  listPriceResults,
  monthOfDate,
  savePriceResult,
  setIncomeCents,
  updateLineItem,
  type NewLineItem,
} from '../db/repository';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate } from '../db/schema';
import { toNewLineItem, toUiLineItem } from '../db/mapping';
import { formatChf, parseChf } from '../db/types';
import type { SqlDatabase, SqlQueryResult, SqlValue } from '../db/sql';

/* ------------------------------------------------------------------ */
/* node:sqlite hinter dem SqlDatabase-Port                             */
/* ------------------------------------------------------------------ */

function createTestDb(): SqlDatabase {
  const raw = new DatabaseSync(':memory:');
  // Gleiche Pragmas wie initDatabase() in der App — ohne foreign_keys = ON
  // würde der CASCADE-Test bestehen, obwohl er in der App nichts tut.
  raw.exec('PRAGMA foreign_keys = ON');

  const execute = async (
    sql: string,
    params: SqlValue[] = [],
  ): Promise<SqlQueryResult> => {
    const rows = raw.prepare(sql).all(...params) as Record<string, unknown>[];
    const changes = raw.prepare('SELECT changes() AS c').get() as {
      c: number | bigint;
    };
    return { rows, rowsAffected: Number(changes.c) };
  };

  return {
    execute,
    transaction: async fn => {
      raw.exec('BEGIN');
      try {
        await fn({ execute });
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

async function freshDb(): Promise<SqlDatabase> {
  const db = createTestDb();
  await migrate(db);
  return db;
}

function makeItem(overrides: Partial<NewLineItem> = {}): NewLineItem {
  return {
    id: `item-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'fixed_cost',
    description: 'Miete',
    amountCents: 120000,
    currency: 'CHF',
    cadence: 'monthly',
    category: 'Wohnen',
    source: 'free_text',
    confidence: 0.92,
    reason: 'Miete ist typischerweise eine Wohnkostenposition.',
    needsInput: false,
    userEdited: false,
    notes: null,
    date: '2026-09-14',
    photoFilename: null,
    manuallyEditedFields: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */

describe('Migrationen', () => {
  test('setzt user_version auf die neueste Version', async () => {
    const db = createTestDb();
    const version = await migrate(db);
    expect(version).toBe(LATEST_SCHEMA_VERSION);
  });

  test('ist idempotent — zweiter Aufruf ändert nichts und wirft nicht', async () => {
    const db = createTestDb();
    await migrate(db);
    await expect(migrate(db)).resolves.toBe(LATEST_SCHEMA_VERSION);
  });

  test('legt alle drei Tabellen an', async () => {
    const db = await freshDb();
    const result = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = result.rows.map(row => row.name);
    expect(names).toEqual(
      expect.arrayContaining(['budget_months', 'line_items', 'price_results']),
    );
  });

  test('Migrationen 2+3 behalten bestehende Zeilen bei einem Upgrade von Version 1', async () => {
    const db = createTestDb();
    // Nur Migration 1 anwenden (der Zustand, in dem echte Geräte vor diesen
    // Fixes schon liefen) und die Zeile per Roh-SQL im damaligen v1-Schema
    // anlegen — addLineItems()/makeItem() setzen inzwischen photo_filename/
    // manually_edited_fields voraus (Migration 3), die zu diesem Zeitpunkt
    // noch nicht existieren.
    await db.transaction(async tx => {
      for (const statement of MIGRATIONS[0].statements) {
        await tx.execute(statement);
      }
      await tx.execute('PRAGMA user_version = 1');
    });
    const month = await getOrCreateMonth(db, '2026-09');
    await db.execute(
      `INSERT INTO line_items
         (id, month_id, kind, description, amount_cents, currency, cadence,
          category, source, confidence, reason, needs_input, user_edited,
          notes, date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'vor-migration-2',
        month.id,
        'fixed_cost',
        'Miete',
        120000,
        'CHF',
        'monthly',
        'Wohnen',
        'free_text',
        0.92,
        null,
        0,
        0,
        null,
        '2026-09-14',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      ],
    );

    await expect(migrate(db)).resolves.toBe(LATEST_SCHEMA_VERSION);

    const rows = await listLineItems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'vor-migration-2',
      description: 'Miete',
      // Migration 3 (ADD COLUMN): sinnvolle Defaults für alte Zeilen.
      photoFilename: null,
      manuallyEditedFields: [],
    });
  });

  test('speichert und liest source "photo" korrekt zurück (fehlte in Migration 1s CHECK-Constraint und in isSource())', async () => {
    const db = await freshDb();
    await addLineItems(db, [makeItem({ id: 'foto-beleg', source: 'photo' })]);

    const [row] = await listLineItems(db);
    // Ohne den Fix in isSource() würde ein unbekannter Wert still auf
    // 'manual' zurückfallen, statt den echten Wert durchzureichen.
    expect(row.source).toBe('photo');
  });

  test('speichert und liest photoFilename und manuallyEditedFields (Migration 3)', async () => {
    const db = await freshDb();
    await addLineItems(db, [
      makeItem({
        id: 'k1',
        photoFilename: 'beleg-item-k1.jpg',
        manuallyEditedFields: ['amount'],
      }),
      makeItem({ id: 'k2' }),
    ]);

    const rows = await listLineItems(db);
    const withPhoto = rows.find(r => r.id === 'k1')!;
    const withoutPhoto = rows.find(r => r.id === 'k2')!;
    expect(withPhoto.photoFilename).toBe('beleg-item-k1.jpg');
    expect(withPhoto.manuallyEditedFields).toEqual(['amount']);
    // Default für Posten, die nie manuell korrigiert wurden.
    expect(withoutPhoto.photoFilename).toBeNull();
    expect(withoutPhoto.manuallyEditedFields).toEqual([]);
  });
});

describe('Geldbeträge', () => {
  test('parseChf akzeptiert Schweizer und deutsche Schreibweisen', () => {
    expect(parseChf("1'200.50")).toBe(120050);
    expect(parseChf('1200,50')).toBe(120050);
    expect(parseChf('150')).toBe(15000);
    expect(parseChf(1200.5)).toBe(120050);
  });

  test('parseChf wirft bei Unsinn', () => {
    expect(() => parseChf('abc')).toThrow();
  });

  test('formatChf ist die Umkehrung', () => {
    expect(formatChf(120050)).toBe('1200.50');
    expect(formatChf(5)).toBe('0.05');
    expect(formatChf(-2500)).toBe('-25.00');
  });

  test('Integer-Rappen vermeiden den Float-Fehler, an dem REAL scheitert', async () => {
    // Genau die drei Beträge aus dem Demo-Budget: als float64 addiert ergeben
    // Miete 1200 + Handy-Abo 39.90 + Kopfhörer 149.90 nicht 1389.80, sondern
    // 1389.8000000000002. Mit REAL-Spalten wäre "Restbudget stimmt zu 100 %"
    // damit nicht haltbar — deshalb INTEGER.
    expect(1200 + 39.9 + 149.9).not.toBe(1389.8);

    const db = await freshDb();
    await addLineItems(db, [
      makeItem({ amountCents: parseChf('1200.00'), description: 'Miete' }),
      makeItem({ amountCents: parseChf('39.90'), description: 'Handy-Abo' }),
      makeItem({ amountCents: parseChf('149.90'), description: 'Kopfhörer' }),
    ]);
    await setIncomeCents(db, '2026-09', parseChf('4500.00'));

    const totals = await computeTotals(db, '2026-09');
    expect(totals.fixedCostsCents).toBe(138980);
    expect(formatChf(totals.fixedCostsCents)).toBe('1389.80');
    expect(totals.remainingCents).toBe(450000 - 138980);
  });
});

describe('Posten speichern und lesen', () => {
  test('speichert und liest einen Posten vollständig zurück', async () => {
    const db = await freshDb();
    const [saved] = await addLineItems(db, [makeItem({ id: 'x1' })]);

    const rows = await listLineItems(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(saved);
    expect(rows[0].description).toBe('Miete');
    expect(rows[0].amountCents).toBe(120000);
    expect(rows[0].confidence).toBeCloseTo(0.92);
    expect(rows[0].needsInput).toBe(false);
  });

  test('hängt den Posten an die Monatszeile seines Kaufdatums', async () => {
    const db = await freshDb();
    await addLineItems(db, [
      makeItem({ date: '2026-09-14' }),
      makeItem({ date: '2026-10-02', description: 'Oktober-Miete' }),
    ]);

    expect(await listLineItemsForMonth(db, '2026-09')).toHaveLength(1);
    expect(await listLineItemsForMonth(db, '2026-10')).toHaveLength(1);
    expect((await getMonth(db, '2026-10'))?.month).toBe('2026-10');
  });

  test('sortiert nach Datum aufsteigend', async () => {
    const db = await freshDb();
    await addLineItems(db, [
      makeItem({ date: '2026-09-20', description: 'spät' }),
      makeItem({ date: '2026-09-02', description: 'früh' }),
    ]);
    expect((await listLineItems(db)).map(r => r.description)).toEqual([
      'früh',
      'spät',
    ]);
  });

  test('eine Extraktion ist atomar — ein ungültiger Posten verwirft alle', async () => {
    const db = await freshDb();
    await expect(
      addLineItems(db, [
        makeItem({ description: 'gültig' }),
        // kind verletzt die CHECK-Constraint
        makeItem({ kind: 'quatsch' as NewLineItem['kind'] }),
      ]),
    ).rejects.toThrow();

    expect(await listLineItems(db)).toHaveLength(0);
  });

  test('ON DELETE CASCADE greift (foreign_keys = ON)', async () => {
    const db = await freshDb();
    await addLineItems(db, [makeItem()]);
    const month = await getMonth(db, '2026-09');

    await db.execute('DELETE FROM budget_months WHERE id = ?', [month!.id]);
    expect(await listLineItems(db)).toHaveLength(0);
  });

  test('deleteLineItem entfernt nur die eine Zeile', async () => {
    const db = await freshDb();
    await addLineItems(db, [
      makeItem({ id: 'a', description: 'bleibt' }),
      makeItem({ id: 'b', description: 'weg' }),
    ]);
    await deleteLineItem(db, 'b');
    expect((await listLineItems(db)).map(r => r.id)).toEqual(['a']);
  });
});

describe('Einkommen', () => {
  test('legt die Monatszeile bei Bedarf an und speichert den Betrag', async () => {
    const db = await freshDb();
    await setIncomeCents(db, '2026-09', 450000);
    expect((await getMonth(db, '2026-09'))?.incomeCents).toBe(450000);
  });

  test('überschreibt einen bestehenden Wert und akzeptiert null', async () => {
    const db = await freshDb();
    await setIncomeCents(db, '2026-09', 450000);
    await setIncomeCents(db, '2026-09', 500000);
    expect((await getMonth(db, '2026-09'))?.incomeCents).toBe(500000);

    await setIncomeCents(db, '2026-09', null);
    expect((await getMonth(db, '2026-09'))?.incomeCents).toBeNull();
  });

  test('getOrCreateMonth legt denselben Monat nicht zweimal an', async () => {
    const db = await freshDb();
    const first = await getOrCreateMonth(db, '2026-09');
    const second = await getOrCreateMonth(db, '2026-09');
    expect(second.id).toBe(first.id);

    const count = await db.execute('SELECT COUNT(*) AS n FROM budget_months');
    expect(count.rows[0].n).toBe(1);
  });
});

describe('Posten ohne Betrag (needs_input)', () => {
  test('bleiben gespeichert, fliessen aber in keine Summe ein', async () => {
    const db = await freshDb();
    await setIncomeCents(db, '2026-09', 450000);
    await addLineItems(db, [
      makeItem({ description: 'Miete', amountCents: 120000 }),
      makeItem({
        description: 'Kopfhörer',
        amountCents: null,
        needsInput: true,
        kind: 'planned_purchase',
        cadence: 'one_time',
      }),
    ]);

    expect(await listLineItems(db)).toHaveLength(2);

    const totals = await computeTotals(db, '2026-09');
    expect(totals.plannedPurchasesCents).toBe(0);
    expect(totals.remainingAfterPlannedCents).toBe(450000 - 120000);
  });

  test('erscheinen in listItemsNeedingReview', async () => {
    const db = await freshDb();
    await addLineItems(db, [
      makeItem({ id: 'ok', description: 'Miete' }),
      makeItem({ id: 'kein-betrag', amountCents: null, needsInput: true }),
      makeItem({ id: 'keine-kategorie', category: null, needsInput: true }),
    ]);

    const review = await listItemsNeedingReview(db);
    expect(review.map(r => r.id).sort()).toEqual([
      'kein-betrag',
      'keine-kategorie',
    ]);
  });

  test('ein Posten, dem nur die Kategorie fehlt, zählt trotzdem mit', async () => {
    // Sonst würde echtes Geld aus der Rechnung fallen, nur weil die KI die
    // Kategorie nicht sicher zuordnen konnte.
    const db = await freshDb();
    await setIncomeCents(db, '2026-09', 450000);
    await addLineItems(db, [
      makeItem({ amountCents: 120000, category: null, needsInput: true }),
    ]);

    const totals = await computeTotals(db, '2026-09');
    expect(totals.fixedCostsCents).toBe(120000);
  });
});

describe('updateLineItem', () => {
  test('schreibt die Änderung und setzt user_edited', async () => {
    const db = await freshDb();
    await addLineItems(db, [
      makeItem({ id: 'k1', amountCents: null, needsInput: true }),
    ]);

    await updateLineItem(db, 'k1', {
      amountCents: 14900,
      category: 'Freizeit',
      needsInput: false,
    });

    const [row] = await listLineItems(db);
    expect(row.amountCents).toBe(14900);
    expect(row.category).toBe('Freizeit');
    expect(row.userEdited).toBe(true);
  });

  test('schreibt photoFilename und manuallyEditedFields (JSON-Array-Spalte)', async () => {
    const db = await freshDb();
    await addLineItems(db, [makeItem({ id: 'k1' })]);

    await updateLineItem(db, 'k1', {
      photoFilename: 'beleg-item-k1.jpg',
      manuallyEditedFields: ['amount', 'category'],
    });

    const [row] = await listLineItems(db);
    expect(row.photoFilename).toBe('beleg-item-k1.jpg');
    expect(row.manuallyEditedFields).toEqual(['amount', 'category']);
  });

  test('nimmt die Zeile damit aus der Review-Liste', async () => {
    const db = await freshDb();
    await addLineItems(db, [
      makeItem({ id: 'k1', amountCents: null, needsInput: true }),
    ]);
    expect(await listItemsNeedingReview(db)).toHaveLength(1);

    await updateLineItem(db, 'k1', { amountCents: 14900, needsInput: false });
    expect(await listItemsNeedingReview(db)).toHaveLength(0);
  });

  test('lässt nicht übergebene Felder unangetastet', async () => {
    const db = await freshDb();
    await addLineItems(db, [makeItem({ id: 'k1', description: 'Miete' })]);

    await updateLineItem(db, 'k1', { amountCents: 130000 });

    const [row] = await listLineItems(db);
    expect(row.description).toBe('Miete');
    expect(row.category).toBe('Wohnen');
    expect(row.amountCents).toBe(130000);
  });
});

describe('Mapping UI <-> DB', () => {
  const uiItem: LineItem = {
    id: 'ui-1',
    description: 'Kopfhörer',
    amount: 149.9,
    currency: 'CHF',
    cadence: 'one_time',
    category: 'Freizeit',
    source: 'free_text',
    confidence: 0.81,
    notes: 'Kopfhörer sind Freizeitausgaben.',
    date: '2026-09-14',
    photoFilename: null,
    manuallyEditedFields: [],
  };

  test('Runde durch die DB verändert den Posten nicht', async () => {
    const db = await freshDb();
    await addLineItems(db, [toNewLineItem(uiItem)]);

    const [row] = await listLineItems(db);
    expect(toUiLineItem(row)).toEqual(uiItem);
  });

  test('leitet kind aus cadence ab', () => {
    expect(toNewLineItem({ ...uiItem, cadence: 'monthly' }).kind).toBe(
      'fixed_cost',
    );
    expect(toNewLineItem({ ...uiItem, cadence: 'one_time' }).kind).toBe(
      'planned_purchase',
    );
  });

  test('markiert fehlenden Betrag oder fehlende Kategorie als needsInput', () => {
    expect(toNewLineItem({ ...uiItem, amount: null }).needsInput).toBe(true);
    expect(toNewLineItem({ ...uiItem, category: null }).needsInput).toBe(true);
    expect(toNewLineItem(uiItem).needsInput).toBe(false);
  });

  test('rechnet Franken verlustfrei in Rappen', () => {
    expect(toNewLineItem({ ...uiItem, amount: 149.9 }).amountCents).toBe(14990);
    expect(toNewLineItem({ ...uiItem, amount: 0.1 + 0.2 }).amountCents).toBe(
      30,
    );
  });
});

describe('computeTotals stimmt mit computeBudget überein', () => {
  // Die SQL-Summen und die (bereits getestete) Engine dürfen nie auseinander
  // laufen — dieser Test ist die Klammer zwischen beiden.
  test('gleiche Daten, gleiches Restbudget', async () => {
    const uiItems: LineItem[] = [
      {
        id: '1',
        description: 'Miete',
        amount: 1200,
        currency: 'CHF',
        cadence: 'monthly',
        category: 'Wohnen',
        source: 'free_text',
        confidence: 0.9,
        notes: '',
        date: '2026-09-01',
        photoFilename: null,
        manuallyEditedFields: [],
      },
      {
        id: '2',
        description: 'Handy-Abo',
        amount: 39.9,
        currency: 'CHF',
        cadence: 'monthly',
        category: 'Abos',
        source: 'free_text',
        confidence: 0.9,
        notes: '',
        date: '2026-09-03',
        photoFilename: null,
        manuallyEditedFields: [],
      },
      {
        id: '3',
        description: 'Kopfhörer',
        amount: 149.9,
        currency: 'CHF',
        cadence: 'one_time',
        category: 'Freizeit',
        source: 'free_text',
        confidence: 0.8,
        notes: '',
        date: '2026-09-14',
        photoFilename: null,
        manuallyEditedFields: [],
      },
    ];

    const db = await freshDb();
    await setIncomeCents(db, '2026-09', 450000);
    await addLineItems(db, uiItems.map(toNewLineItem));

    const totals = await computeTotals(db, '2026-09');
    const summary = computeBudget(4500, uiItems);

    expect(totals.fixedCostsCents / 100).toBeCloseTo(
      summary.totalFixedCosts,
      2,
    );
    expect(totals.plannedPurchasesCents / 100).toBeCloseTo(
      summary.totalPlannedPurchases,
      2,
    );
    expect(totals.remainingAfterPlannedCents / 100).toBeCloseTo(
      summary.restbudget!,
      2,
    );
  });

  test('erkennt Überschreitung', async () => {
    const db = await freshDb();
    await setIncomeCents(db, '2026-09', 100000);
    await addLineItems(db, [makeItem({ amountCents: 150000 })]);

    const totals = await computeTotals(db, '2026-09');
    expect(totals.overBudget).toBe(true);
    expect(totals.remainingAfterPlannedCents).toBe(-50000);
  });

  test('remainingRatio ist null ohne Einkommen', async () => {
    const db = await freshDb();
    await addLineItems(db, [makeItem()]);
    expect((await computeTotals(db, '2026-09')).remainingRatio).toBeNull();
  });
});

describe('Hilfsfunktionen', () => {
  test('monthOfDate schneidet den Monat aus dem ISO-Datum', () => {
    expect(monthOfDate('2026-09-14')).toBe('2026-09');
    expect(monthOfDate('2026-01-01')).toBe('2026-01');
  });
});

describe('Preisergebnisse', () => {
  test('speichert einen Treffer und liest ihn nach query zurück', async () => {
    const db = await freshDb();
    await savePriceResult(db, {
      lineItemId: null,
      query: 'sony wh-1000xm5',
      productName: 'Sony WH-1000XM5 Schwarz',
      priceCents: 29900,
      currency: 'CHF',
      shop: 'Digitec',
      url: 'https://www.toppreise.ch/produkt/1',
      fetchedAt: new Date().toISOString(),
    });

    const found = await listPriceResults(db, 'sony wh-1000xm5');
    expect(found).toHaveLength(1);
    expect(found[0].priceCents).toBe(29900);
    expect(found[0].shop).toBe('Digitec');
  });
});
