/**
 * @format
 */

import { computeBudget } from '../budgetEngine';
import type { LineItem } from '../budget';

function makeItem(overrides: Partial<LineItem>): LineItem {
  return {
    id: 'test-id',
    description: 'Testposten',
    amount: 100,
    currency: 'CHF',
    cadence: 'monthly',
    category: 'Sonstiges',
    source: 'free_text',
    confidence: 0.9,
    notes: '',
    date: '2026-01-01',
    ...overrides,
  };
}

describe('computeBudget', () => {
  test('Normalfall: Fixkosten + geplante Käufe, positives Restbudget', () => {
    const items = [
      makeItem({
        id: '1',
        description: 'Miete',
        amount: 1200,
        cadence: 'monthly',
      }),
      makeItem({ id: '2', description: 'Abo', amount: 20, cadence: 'monthly' }),
      makeItem({
        id: '3',
        description: 'Kopfhörer',
        amount: 150,
        cadence: 'one_time',
      }),
    ];

    const result = computeBudget(4500, items);

    expect(result.totalFixedCosts).toBe(1220);
    expect(result.totalPlannedPurchases).toBe(150);
    expect(result.totalSpent).toBe(1370);
    expect(result.restbudget).toBe(3130);
    expect(result.restbudgetPercent).toBeCloseTo((3130 / 4500) * 100, 1);
    expect(result.warnings).toEqual([]);
  });

  test('Überschreitung: restbudget negativ → passende Warnung', () => {
    const items = [
      makeItem({
        id: '1',
        description: 'Miete',
        amount: 4000,
        cadence: 'monthly',
      }),
      makeItem({
        id: '2',
        description: 'Auto',
        amount: 1000,
        cadence: 'one_time',
      }),
    ];

    const result = computeBudget(4500, items);

    expect(result.restbudget).toBe(-500);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('überschritten');
    expect(result.warnings[0]).toContain('500.00');
  });

  test('Restbudget knapp (< 15%): Warnung, aber keine Überschreitungs-Warnung', () => {
    const items = [
      makeItem({
        id: '1',
        description: 'Miete',
        amount: 4000,
        cadence: 'monthly',
      }),
    ];

    // Restbudget = 500 von 4500 = 11.11% → < 15%, aber >= 0.
    const result = computeBudget(4500, items);

    expect(result.restbudget).toBe(500);
    expect(result.restbudgetPercent).toBeLessThan(15);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('knapp');
    expect(result.warnings[0]).not.toContain('überschritten');
  });

  test('income === null: restbudget und restbudgetPercent beide null, keine Exceptions', () => {
    const items = [makeItem({ id: '1', amount: 100, cadence: 'monthly' })];

    const result = computeBudget(null, items);

    expect(result.restbudget).toBeNull();
    expect(result.restbudgetPercent).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  test('leere items[]: totalSpent 0, restbudget === income', () => {
    const result = computeBudget(3000, []);

    expect(result.totalFixedCosts).toBe(0);
    expect(result.totalPlannedPurchases).toBe(0);
    expect(result.totalSpent).toBe(0);
    expect(result.restbudget).toBe(3000);
    expect(result.restbudgetPercent).toBe(100);
    expect(result.warnings).toEqual([]);
  });

  test('Items mit amount === null werden ignoriert statt die Summe zu verfälschen', () => {
    const items = [
      makeItem({ id: '1', amount: 500, cadence: 'monthly' }),
      makeItem({ id: '2', amount: null, cadence: 'monthly', category: null }),
      makeItem({ id: '3', amount: null, cadence: 'one_time', category: null }),
    ];

    expect(() => computeBudget(2000, items)).not.toThrow();
    const result = computeBudget(2000, items);

    expect(result.totalFixedCosts).toBe(500);
    expect(result.totalPlannedPurchases).toBe(0);
    expect(result.totalSpent).toBe(500);
    expect(result.restbudget).toBe(1500);
  });

  test('income <= 0: restbudget und restbudgetPercent null statt Division durch 0', () => {
    const result = computeBudget(0, [makeItem({ amount: 50 })]);

    expect(result.restbudget).toBeNull();
    expect(result.restbudgetPercent).toBeNull();
  });
});
