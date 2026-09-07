/**
 * Übersetzung zwischen UI-Modell (`budget.ts`, Franken als number) und
 * DB-Modell (`types.ts`, Rappen als Integer).
 *
 * Diese Datei ist die EINZIGE Stelle, an der umgerechnet wird — bewusst so
 * eingegrenzt, damit der Rest der App entweder nur Franken (Screens,
 * budgetEngine, pdfExport) oder nur Rappen (repository) sieht.
 *
 * Zwei Felder brauchen eine Erklärung:
 *
 * `kind` erfasst die aktuelle UI nicht — sie kennt nur `cadence`. Abgeleitet
 * wird deshalb monthly -> fixed_cost und one_time -> planned_purchase, genau
 * die Ableitung, die BudgetScreen für seine beiden Listen schon macht. Sobald
 * der Entwurf-Screen "schon gekauft" von "geplant" unterscheiden kann, ist
 * `expense` der richtige Wert für den ersten Fall.
 *
 * `notes` im UI-Modell enthält die 1-Satz-Begründung des Modells (siehe
 * ExpenseFlow: `notes: finalDraft.reason`). Gespeichert wird sie deshalb in
 * der Spalte `reason`; die Spalte `notes` bleibt für echte Nutzernotizen frei.
 *
 * @format
 */

import type { LineItem } from '../budget';
import type { ItemKind, LineItemRow } from './types';
import { parseChf } from './types';
import type { NewLineItem } from './repository';

/** monthly -> Fixkosten, one_time -> geplanter Kauf. */
export function kindFromCadence(cadence: LineItem['cadence']): ItemKind {
  return cadence === 'monthly' ? 'fixed_cost' : 'planned_purchase';
}

/** UI-Posten -> noch nicht gespeicherte DB-Zeile. */
export function toNewLineItem(item: LineItem): NewLineItem {
  const notes = item.notes.trim();
  return {
    id: item.id,
    kind: kindFromCadence(item.cadence),
    description: item.description,
    amountCents: item.amount === null ? null : parseChf(item.amount),
    currency: item.currency,
    cadence: item.cadence,
    category: item.category,
    source: item.source,
    confidence: item.confidence,
    reason: notes === '' ? null : notes,
    // Ein Posten ohne Betrag oder Kategorie muss nachgefragt werden — der
    // Betrag fliesst zusätzlich in keine Summe ein (siehe computeTotals).
    needsInput: item.amount === null || item.category === null,
    userEdited: false,
    notes: null,
    date: item.date,
  };
}

/** DB-Zeile -> UI-Posten. */
export function toUiLineItem(row: LineItemRow): LineItem {
  return {
    id: row.id,
    description: row.description,
    amount: row.amountCents === null ? null : row.amountCents / 100,
    currency: row.currency,
    cadence: row.cadence,
    category: row.category,
    source: row.source,
    confidence: row.confidence,
    notes: row.reason ?? row.notes ?? '',
    date: row.date,
  };
}

/** Einkommen: Franken (UI) -> Rappen (DB). */
export function incomeToCents(income: number | null): number | null {
  return income === null ? null : parseChf(income);
}

/** Einkommen: Rappen (DB) -> Franken (UI). */
export function incomeToChf(incomeCents: number | null): number | null {
  return incomeCents === null ? null : incomeCents / 100;
}
