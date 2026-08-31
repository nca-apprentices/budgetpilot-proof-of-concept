/**
 * Reine Budget-Berechnung — keine React-Hooks, kein State, kein I/O.
 * Deterministisch: gleiche Eingabe → exakt gleiche Ausgabe (siehe __tests__/budgetEngine.test.ts).
 */

import type { LineItem } from './budget';

export type BudgetSummary = {
  totalFixedCosts: number;
  totalPlannedPurchases: number;
  totalSpent: number;
  restbudget: number | null;
  restbudgetPercent: number | null;
  warnings: string[];
};

const LOW_BUDGET_WARNING_PERCENT = 15;

// Erst am Schluss runden, nicht zwischen den einzelnen Rechenschritten —
// vermeidet, dass sich Rundungsfehler bei mehreren Posten aufaddieren.
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function sumAmounts(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + (item.amount as number), 0);
}

export function computeBudget(
  income: number | null,
  items: LineItem[],
): BudgetSummary {
  const validItems = items.filter(item => item.amount !== null);
  const fixedCosts = validItems.filter(item => item.cadence === 'monthly');
  const plannedPurchases = validItems.filter(item => item.cadence === 'one_time');

  const totalFixedCosts = sumAmounts(fixedCosts);
  const totalPlannedPurchases = sumAmounts(plannedPurchases);
  const totalSpent = totalFixedCosts + totalPlannedPurchases;

  const hasValidIncome = income !== null && income > 0;
  const restbudgetRaw = hasValidIncome ? (income as number) - totalSpent : null;
  const restbudgetPercentRaw =
    hasValidIncome && restbudgetRaw !== null
      ? (restbudgetRaw / (income as number)) * 100
      : null;

  const restbudget = restbudgetRaw !== null ? round2(restbudgetRaw) : null;
  const restbudgetPercent =
    restbudgetPercentRaw !== null ? round2(restbudgetPercentRaw) : null;

  const warnings: string[] = [];
  if (restbudget !== null && restbudget < 0) {
    warnings.push(
      `Budget überschritten: ${Math.abs(restbudget).toFixed(2)} CHF über dem verfügbaren Einkommen.`,
    );
  } else if (
    restbudget !== null &&
    restbudget >= 0 &&
    restbudgetPercent !== null &&
    restbudgetPercent < LOW_BUDGET_WARNING_PERCENT
  ) {
    warnings.push(
      `Restbudget knapp: nur noch ${restbudgetPercent.toFixed(1)}% des Einkommens übrig.`,
    );
  }

  return {
    totalFixedCosts: round2(totalFixedCosts),
    totalPlannedPurchases: round2(totalPlannedPurchases),
    totalSpent: round2(totalSpent),
    restbudget,
    restbudgetPercent,
    warnings,
  };
}
