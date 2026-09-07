/**
 * Repository — die einzige Stelle im Projekt, die SQL schreibt.
 *
 * Alle Funktionen nehmen den SQL-Port aus `sql.ts` entgegen (nicht op-sqlite
 * direkt), sind daher ohne Simulator testbar (siehe __tests__/db.test.ts).
 *
 * Beträge sind durchgehend Rappen (Integer). Umrechnung nach/von Franken
 * passiert ausschliesslich in `mapping.ts`.
 *
 * @format
 */

import type {
  BudgetMonthRow,
  BudgetTotals,
  LineItemRow,
  PriceResultRow,
} from './types';
import { isCadence, isCategory, isItemKind, isSource } from './types';
import type { SqlDatabase, SqlExecutor, SqlRow } from './sql';
import {
  readBoolean,
  readNullableNumber,
  readNullableText,
  readNumber,
  readText,
  toSqlBoolean,
} from './sql';

/** Posten, wie ihn ein Screen liefert — Monat und Zeitstempel setzt das Repo. */
export type NewLineItem = Omit<
  LineItemRow,
  'monthId' | 'createdAt' | 'updatedAt'
>;

/** Vom User im Entwurf-Screen überschreibbare Felder. */
export type LineItemPatch = Partial<
  Pick<
    LineItemRow,
    | 'description'
    | 'amountCents'
    | 'currency'
    | 'cadence'
    | 'category'
    | 'kind'
    | 'needsInput'
    | 'notes'
    | 'date'
  >
>;

function nowIso(): string {
  return new Date().toISOString();
}

/** "2026-09-14" -> "2026-09". Der Monat eines Postens folgt seinem Kaufdatum. */
export function monthOfDate(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/* ------------------------------------------------------------------ */
/* Row -> Objekt                                                       */
/* ------------------------------------------------------------------ */

function toBudgetMonth(row: SqlRow): BudgetMonthRow {
  return {
    id: readText(row.id),
    month: readText(row.month),
    incomeCents: readNullableNumber(row.income_cents),
    currency: readText(row.currency, 'CHF'),
    createdAt: readText(row.created_at),
    updatedAt: readText(row.updated_at),
  };
}

function toLineItem(row: SqlRow): LineItemRow {
  const kind = row.kind;
  const cadence = row.cadence;
  const source = row.source;
  return {
    id: readText(row.id),
    monthId: readText(row.month_id),
    // Fallbacks statt Exception: eine einzelne unlesbare Zeile darf nicht den
    // ganzen App-Start verhindern. Die CHECK-Constraints machen das
    // unwahrscheinlich, aber nicht unmöglich (Migration, manuelles Editieren).
    kind: isItemKind(kind) ? kind : 'expense',
    description: readText(row.description),
    amountCents: readNullableNumber(row.amount_cents),
    currency: readText(row.currency, 'CHF'),
    cadence: isCadence(cadence) ? cadence : 'one_time',
    category: isCategory(row.category) ? row.category : null,
    source: isSource(source) ? source : 'manual',
    confidence: readNullableNumber(row.confidence),
    reason: readNullableText(row.reason),
    needsInput: readBoolean(row.needs_input),
    userEdited: readBoolean(row.user_edited),
    notes: readNullableText(row.notes),
    date: readText(row.date),
    createdAt: readText(row.created_at),
    updatedAt: readText(row.updated_at),
  };
}

function toPriceResult(row: SqlRow): PriceResultRow {
  return {
    id: readText(row.id),
    lineItemId: readNullableText(row.line_item_id),
    query: readText(row.query),
    productName: readText(row.product_name),
    priceCents: readNumber(row.price_cents),
    currency: readText(row.currency, 'CHF'),
    shop: readNullableText(row.shop),
    url: readNullableText(row.url),
    fetchedAt: readText(row.fetched_at),
  };
}

/* ------------------------------------------------------------------ */
/* Monate                                                              */
/* ------------------------------------------------------------------ */

export async function getMonth(
  db: SqlExecutor,
  month: string,
): Promise<BudgetMonthRow | null> {
  const result = await db.execute(
    'SELECT * FROM budget_months WHERE month = ?',
    [month],
  );
  const row = result.rows[0];
  return row ? toBudgetMonth(row) : null;
}

/**
 * Holt die Monatszeile oder legt sie an. Nimmt einen SqlExecutor, damit sie
 * auch INNERHALB einer Transaktion aufgerufen werden kann (siehe addLineItems).
 */
export async function getOrCreateMonth(
  db: SqlExecutor,
  month: string,
  currency = 'CHF',
): Promise<BudgetMonthRow> {
  const existing = await getMonth(db, month);
  if (existing) {
    return existing;
  }
  const timestamp = nowIso();
  const row: BudgetMonthRow = {
    id: createId(),
    month,
    incomeCents: null,
    currency,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await db.execute(
    `INSERT INTO budget_months (id, month, income_cents, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.month,
      row.incomeCents,
      row.currency,
      row.createdAt,
      row.updatedAt,
    ],
  );
  return row;
}

/** Setzt (oder löscht mit null) das Einkommen des Monats. */
export async function setIncomeCents(
  db: SqlDatabase,
  month: string,
  incomeCents: number | null,
): Promise<void> {
  await getOrCreateMonth(db, month);
  await db.execute(
    'UPDATE budget_months SET income_cents = ?, updated_at = ? WHERE month = ?',
    [incomeCents, nowIso(), month],
  );
}

/* ------------------------------------------------------------------ */
/* Posten                                                             */
/* ------------------------------------------------------------------ */

async function insertLineItem(
  tx: SqlExecutor,
  item: NewLineItem,
): Promise<LineItemRow> {
  const month = await getOrCreateMonth(
    tx,
    monthOfDate(item.date),
    item.currency,
  );
  const timestamp = nowIso();
  const row: LineItemRow = {
    ...item,
    monthId: month.id,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await tx.execute(
    `INSERT INTO line_items
       (id, month_id, kind, description, amount_cents, currency, cadence,
        category, source, confidence, reason, needs_input, user_edited,
        notes, date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.monthId,
      row.kind,
      row.description,
      row.amountCents,
      row.currency,
      row.cadence,
      row.category,
      row.source,
      row.confidence,
      row.reason,
      toSqlBoolean(row.needsInput),
      toSqlBoolean(row.userEdited),
      row.notes,
      row.date,
      row.createdAt,
      row.updatedAt,
    ],
  );
  return row;
}

/**
 * Speichert alle Posten EINER Extraktion in einer Transaktion.
 * Grund: eine halb gespeicherte Freitext-Eingabe ("Miete 1200, Handy 60") wäre
 * schlimmer als eine fehlgeschlagene — der User sieht sonst ein Budget, das er
 * nie so eingegeben hat.
 */
export async function addLineItems(
  db: SqlDatabase,
  items: NewLineItem[],
): Promise<LineItemRow[]> {
  if (items.length === 0) {
    return [];
  }
  const saved: LineItemRow[] = [];
  await db.transaction(async tx => {
    saved.length = 0;
    for (const item of items) {
      saved.push(await insertLineItem(tx, item));
    }
  });
  return saved;
}

/** Alle Posten, älteste zuerst. Reihenfolge stabil auch bei gleichem Datum. */
export async function listLineItems(db: SqlExecutor): Promise<LineItemRow[]> {
  const result = await db.execute(
    'SELECT * FROM line_items ORDER BY date ASC, created_at ASC',
  );
  return result.rows.map(toLineItem);
}

export async function listLineItemsForMonth(
  db: SqlExecutor,
  month: string,
): Promise<LineItemRow[]> {
  const result = await db.execute(
    `SELECT li.* FROM line_items li
       JOIN budget_months bm ON bm.id = li.month_id
      WHERE bm.month = ?
      ORDER BY li.date ASC, li.created_at ASC`,
    [month],
  );
  return result.rows.map(toLineItem);
}

/**
 * Posten, die der User noch prüfen muss: fehlender Betrag, fehlende Kategorie
 * oder explizit gesetztes needs_input — und noch nicht vom User bestätigt.
 */
export async function listItemsNeedingReview(
  db: SqlExecutor,
): Promise<LineItemRow[]> {
  const result = await db.execute(
    `SELECT * FROM line_items
      WHERE user_edited = 0
        AND (needs_input = 1 OR amount_cents IS NULL OR category IS NULL)
      ORDER BY created_at ASC`,
  );
  return result.rows.map(toLineItem);
}

/**
 * Ändert einen Posten und markiert ihn als `user_edited`.
 * Das Flag ist doppelt nützlich: die Zeile verschwindet aus
 * listItemsNeedingReview(), und die Accuracy-Messung kann später trennen,
 * welche Zeilen das Modell richtig hatte und welche der User korrigieren musste.
 */
export async function updateLineItem(
  db: SqlExecutor,
  id: string,
  patch: LineItemPatch,
): Promise<void> {
  const columns: Record<keyof LineItemPatch, string> = {
    description: 'description',
    amountCents: 'amount_cents',
    currency: 'currency',
    cadence: 'cadence',
    category: 'category',
    kind: 'kind',
    needsInput: 'needs_input',
    notes: 'notes',
    date: 'date',
  };

  const assignments: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [key, column] of Object.entries(columns) as [
    keyof LineItemPatch,
    string,
  ][]) {
    if (!(key in patch)) {
      continue;
    }
    const value = patch[key];
    assignments.push(`${column} = ?`);
    params.push(
      typeof value === 'boolean' ? toSqlBoolean(value) : value ?? null,
    );
  }

  assignments.push('user_edited = 1', 'updated_at = ?');
  params.push(nowIso(), id);

  await db.execute(
    `UPDATE line_items SET ${assignments.join(', ')} WHERE id = ?`,
    params,
  );
}

export async function deleteLineItem(
  db: SqlExecutor,
  id: string,
): Promise<void> {
  await db.execute('DELETE FROM line_items WHERE id = ?', [id]);
}

/* ------------------------------------------------------------------ */
/* Summen                                                             */
/* ------------------------------------------------------------------ */

/**
 * Budgetsummen direkt aus SQL — reine Integer-Addition, deterministisch.
 *
 * `amount_cents IS NOT NULL` ist der entscheidende Filter: ein von Gemma
 * extrahierter Posten ohne Betrag ("Kopfhörer", kein Preis genannt) bleibt als
 * Zeile erhalten und erscheint in listItemsNeedingReview(), fliesst aber in
 * keine Summe ein und kann das Restbudget damit nicht still verfälschen.
 *
 * Bewusst NICHT auf `needs_input = 0` gefiltert: needs_input ist auch gesetzt,
 * wenn nur die Kategorie fehlt. Ein solcher Posten hat aber einen gültigen
 * Betrag und muss mitgezählt werden — sonst fehlt echtes Geld in der Rechnung.
 */
export async function computeTotals(
  db: SqlExecutor,
  month: string,
): Promise<BudgetTotals> {
  const monthRow = await getMonth(db, month);
  const incomeCents = monthRow?.incomeCents ?? 0;

  const result = await db.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN li.kind = 'income_deduction' THEN li.amount_cents ELSE 0 END), 0) AS deductions,
       COALESCE(SUM(CASE WHEN li.kind = 'fixed_cost'       THEN li.amount_cents ELSE 0 END), 0) AS fixed_costs,
       COALESCE(SUM(CASE WHEN li.kind = 'expense'          THEN li.amount_cents ELSE 0 END), 0) AS expenses,
       COALESCE(SUM(CASE WHEN li.kind = 'planned_purchase' THEN li.amount_cents ELSE 0 END), 0) AS planned
     FROM line_items li
     JOIN budget_months bm ON bm.id = li.month_id
     WHERE bm.month = ? AND li.amount_cents IS NOT NULL`,
    [month],
  );

  const row = result.rows[0] ?? {};
  const deductionsCents = readNumber(row.deductions);
  const fixedCostsCents = readNumber(row.fixed_costs);
  const expensesCents = readNumber(row.expenses);
  const plannedPurchasesCents = readNumber(row.planned);

  const netIncomeCents = incomeCents - deductionsCents;
  const remainingCents = netIncomeCents - fixedCostsCents - expensesCents;
  const remainingAfterPlannedCents = remainingCents - plannedPurchasesCents;

  return {
    incomeCents,
    deductionsCents,
    netIncomeCents,
    fixedCostsCents,
    expensesCents,
    plannedPurchasesCents,
    remainingCents,
    remainingAfterPlannedCents,
    remainingRatio:
      netIncomeCents > 0 ? remainingAfterPlannedCents / netIncomeCents : null,
    overBudget: remainingAfterPlannedCents < 0,
  };
}

/* ------------------------------------------------------------------ */
/* Preise (toppreise.ch)                                              */
/* ------------------------------------------------------------------ */

/**
 * Noch von keinem Screen aufgerufen: der Preis-Cache in `toppreise.ch` liegt
 * aktuell als JSON-Datei via react-native-fs vor und funktioniert. Tabelle und
 * Funktionen gehören aber zum Datenmodell aus CLAUDE.md und stehen bereit,
 * sobald ein gefundener Preis an einen Posten geheftet werden soll.
 */
export async function savePriceResult(
  db: SqlExecutor,
  result: Omit<PriceResultRow, 'id'>,
): Promise<PriceResultRow> {
  const row: PriceResultRow = { ...result, id: createId() };
  await db.execute(
    `INSERT INTO price_results
       (id, line_item_id, query, product_name, price_cents, currency, shop, url, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.lineItemId,
      row.query,
      row.productName,
      row.priceCents,
      row.currency,
      row.shop,
      row.url,
      row.fetchedAt,
    ],
  );
  return row;
}

export async function listPriceResults(
  db: SqlExecutor,
  query: string,
): Promise<PriceResultRow[]> {
  const result = await db.execute(
    'SELECT * FROM price_results WHERE query = ? ORDER BY fetched_at DESC',
    [query],
  );
  return result.rows.map(toPriceResult);
}
