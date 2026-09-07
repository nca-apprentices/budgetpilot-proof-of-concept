/**
 * @format
 */

import { GOLDEN_SET, compareToExpected } from '../goldenSet';

describe('GOLDEN_SET', () => {
  it('has unique ids', () => {
    const ids = GOLDEN_SET.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers all 7 categories', () => {
    const categories = new Set(GOLDEN_SET.map(c => c.expected.category));
    expect(categories.size).toBe(7);
  });
});

describe('compareToExpected', () => {
  const expected = {
    amount: 45,
    currency: 'CHF',
    cadence: 'one_time' as const,
    category: 'Lebensmittel' as const,
  };

  it('marks an exact match as fully correct', () => {
    const result = compareToExpected(expected, {
      amount: 45,
      cadence: 'one_time',
      category: 'Lebensmittel',
    });
    expect(result).toEqual({
      amountCorrect: true,
      categoryCorrect: true,
      cadenceCorrect: true,
      allCorrect: true,
    });
  });

  it('tolerates rounding noise below the epsilon', () => {
    const result = compareToExpected(expected, {
      amount: 45.001,
      cadence: 'one_time',
      category: 'Lebensmittel',
    });
    expect(result.amountCorrect).toBe(true);
  });

  it('flags a wrong amount but keeps category/cadence independent', () => {
    const result = compareToExpected(expected, {
      amount: 50,
      cadence: 'one_time',
      category: 'Lebensmittel',
    });
    expect(result).toEqual({
      amountCorrect: false,
      categoryCorrect: true,
      cadenceCorrect: true,
      allCorrect: false,
    });
  });

  it('treats a null amount (needs_input) as incorrect against a defined expectation', () => {
    const result = compareToExpected(expected, {
      amount: null,
      cadence: 'one_time',
      category: 'Lebensmittel',
    });
    expect(result.amountCorrect).toBe(false);
  });

  it('flags a wrong cadence', () => {
    const result = compareToExpected(expected, {
      amount: 45,
      cadence: 'monthly',
      category: 'Lebensmittel',
    });
    expect(result.cadenceCorrect).toBe(false);
    expect(result.allCorrect).toBe(false);
  });
});
