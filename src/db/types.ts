/**
 * BudgetPilot – Persistenz-Datenmodell (POC)
 *
 * WICHTIG: Alle Geldbeträge werden als GANZZAHLIGE RAPPEN (cents) gespeichert.
 * Grund: SQLite REAL ist ein float64. 0.1 + 0.2 !== 0.3 gilt auch dort.
 * Erfolgskriterium "Restbudget stimmt zu 100 %" ist mit Floats nicht haltbar.
 * Umrechnung nur an der UI-Grenze (siehe formatChf / parseChf unten).
 *
 * Verhältnis zu `budget.ts`: dort steht das UI-/Engine-Modell (Franken als
 * `number`, wie es TextInput und computeBudget verwenden), hier das
 * Datenbank-Modell (Rappen als Integer). Die Typen heissen deshalb `...Row`,
 * damit in App.tsx unmissverständlich bleibt, welches der beiden gemeint ist.
 * Umgerechnet wird ausschliesslich in `mapping.ts`.
 *
 * @format
 */

// Kategorien/Cadence/Source sind fachlich dieselbe Aufzählung wie im
// UI-Modell — bewusst von dort importiert statt hier ein zweites Mal
// definiert, sonst driften die beiden Listen auseinander.
import { ALLOWED_CATEGORIES } from '../budget';
import type { Cadence, Category, Source } from '../budget';

export type { Cadence, Category, Source };

/**
 * Art des Postens. Trennt die Budgetrechnung sauber auf:
 *   income_deduction – AHV, Pensionskasse, Quellensteuer … (reduziert Nettolohn)
 *   fixed_cost       – Miete, Abos, Versicherung … (monatlich)
 *   planned_purchase – Wunschliste, noch nicht gekauft
 *   expense          – bereits getätigte Ausgabe
 *
 * Die aktuelle UI erfasst nur `cadence` und leitet daraus `fixed_cost` bzw.
 * `planned_purchase` ab (siehe mapping.ts). `income_deduction` und `expense`
 * sind schon Teil des Schemas, werden aber noch von keinem Screen erzeugt —
 * gleiche Vorgehensweise wie bei `Source: 'manual' | 'toppreise'` in budget.ts.
 */
export const ITEM_KINDS = [
  'income_deduction',
  'fixed_cost',
  'planned_purchase',
  'expense',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface BudgetMonthRow {
  id: string;
  /** ISO-Monat, z. B. "2026-09" */
  month: string;
  /** Bruttoeinkommen in Rappen; null, solange der User nichts eingegeben hat. */
  incomeCents: number | null;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

export interface LineItemRow {
  id: string;
  monthId: string;
  kind: ItemKind;
  description: string;
  /**
   * Betrag in Rappen. null ist erlaubt und bedeutet "Betrag fehlt" — solche
   * Zeilen werden aus allen Summen ausgeschlossen (siehe repository.ts),
   * damit ein Posten ohne Preis das Restbudget nicht still verfälscht.
   */
  amountCents: number | null;
  currency: string;
  cadence: Cadence;
  /** null, wenn das Modell keine sichere Kategorie liefern konnte. */
  category: Category | null;
  source: Source;
  /** LLM-Konfidenz 0..1, null bei manueller Eingabe */
  confidence: number | null;
  /** 1-Satz-Begründung des Modells (Erklärbarkeit) */
  reason: string | null;
  /** true, wenn Betrag oder Kategorie fehlt und nachgefragt werden muss */
  needsInput: boolean;
  /** true, sobald der User die LLM-Zuordnung überschrieben hat */
  userEdited: boolean;
  /** Freitext-Notiz des Users. Noch von keinem Screen geschrieben. */
  notes: string | null;
  /** Kaufdatum, ISO `YYYY-MM-DD` — Grundlage der Kalender-Markierungen. */
  date: string;
  /**
   * Dateiname (nicht Pfad, siehe schema.ts Migration 3) des zugehörigen
   * Beleg-Fotos in RNFS.DocumentDirectoryPath, oder null ohne Foto.
   */
  photoFilename: string | null;
  /** Feldnamen, die der User gegenüber der letzten KI-Extraktion überschrieben hat. */
  manuallyEditedFields: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PriceResultRow {
  id: string;
  lineItemId: string | null;
  query: string;
  productName: string;
  priceCents: number;
  currency: string;
  shop: string | null;
  url: string | null;
  fetchedAt: string;
}

/** Ergebnis der Budgetrechnung – rein aus SQL-Integersummen, deterministisch. */
export interface BudgetTotals {
  incomeCents: number;
  deductionsCents: number;
  netIncomeCents: number;
  fixedCostsCents: number;
  expensesCents: number;
  plannedPurchasesCents: number;
  /** netIncome - fixedCosts - expenses */
  remainingCents: number;
  /** remaining - plannedPurchases  (Restbudget NACH Wunschliste) */
  remainingAfterPlannedCents: number;
  /** Anteil des Nettoeinkommens, der noch frei ist (0..1, null wenn netIncome <= 0) */
  remainingRatio: number | null;
  overBudget: boolean;
}

/* ------------------------------------------------------------------ */
/* Geld-Helfer – nur an der UI-Grenze verwenden, nie in der Rechnung.  */
/* ------------------------------------------------------------------ */

export function formatChf(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(
    2,
    '0',
  )}`;
}

/** "1'200.50" | "1200,50" | "150" -> 120050 | 15000. Wirft bei Unsinn. */
export function parseChf(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      throw new Error(`Ungültiger Betrag: ${input}`);
    }
    return Math.round(input * 100);
  }
  const cleaned = input.replace(/['\s’]/g, '').replace(',', '.');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    throw new Error(`Ungültiger Betrag: ${input}`);
  }
  return Math.round(value * 100);
}

/* ------------------------------------------------------------------ */
/* Guards – schützen beim LESEN aus der DB. SQLite hat kein ENUM, in   */
/* den TEXT-Spalten kann (z. B. nach einer Migration) alles stehen.    */
/* ------------------------------------------------------------------ */

export function isCategory(value: unknown): value is Category {
  return (
    typeof value === 'string' &&
    (ALLOWED_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isCadence(value: unknown): value is Cadence {
  return value === 'monthly' || value === 'one_time';
}

export function isItemKind(value: unknown): value is ItemKind {
  return (
    typeof value === 'string' &&
    (ITEM_KINDS as readonly string[]).includes(value)
  );
}

export function isSource(value: unknown): value is Source {
  return (
    value === 'free_text' ||
    value === 'photo' ||
    value === 'manual' ||
    value === 'toppreise'
  );
}
