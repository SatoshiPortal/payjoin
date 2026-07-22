import Utils from './Utils';

describe('Utils.btcToSats — float rounding', () => {

  /**
   * These amounts are known IEEE 754 double-precision pitfalls where
   * `Number(btc) * 1e8` produces a value slightly below the true integer,
   * causing Math.floor to round down by 1 sat.
   *
   * Verified in Node.js:
   *   Number('0.29') * 1e8  → 28999999.999999996  → floors to 28999999  (off by 1)
   *   Number('0.1')  * 1e8  → 10000000.000000002  → floors to 10000000  (ok by luck)
   *   Number('1.005') * 1e8 → 100499999.99999999  → floors to 100499999 (off by 1)
   *   Number('0.57') * 1e8  → 56999999.99999999   → floors to 56999999  (off by 1)
   */

  const cases: Array<[string | number, bigint]> = [
    // exact representations — must still work
    ['0',        0n],
    ['0.00000001', 1n],           // 1 sat
    ['0.0001',   10_000n],
    ['1',        100_000_000n],
    ['21',       2_100_000_000n],

    // problematic IEEE 754 values
    ['0.29',     29_000_000n],    // classic off-by-1 with float
    ['0.57',     57_000_000n],
    ['1.005',    100_500_000n],
    ['0.19',     19_000_000n],
    ['0.39',     39_000_000n],
    ['10.1',     1_010_000_000n],

    // accepts number input too
    [0.29,       29_000_000n],
    [1,          100_000_000n],
  ];

  test.each(cases)('btcToSats(%s) === %s', (input, expected) => {
    expect(Utils.btcToSats(input)).toBe(expected);
  });

  it('throws on non-numeric input', () => {
    expect(() => Utils.btcToSats('abc')).toThrow('Invalid number');
  });

});

describe('Utils.jsonStringify — Error serialization', () => {

  it('preserves message/name/stack for a plain Error (normally non-enumerable, so JSON.stringify alone gives {})', () => {
    const err = new Error('boom');
    const parsed = JSON.parse(Utils.jsonStringify(err));
    expect(parsed.message).toBe('boom');
    expect(parsed.name).toBe('Error');
    expect(typeof parsed.stack).toBe('string');
  });

  it('still captures a custom subclass\'s own enumerable fields alongside message/stack', () => {
    class CustomError extends Error {
      code: number;
      constructor(message: string, code: number) {
        super(message);
        this.name = 'CustomError';
        this.code = code;
      }
    }
    const parsed = JSON.parse(Utils.jsonStringify(new CustomError('bad request', 400)));
    expect(parsed.message).toBe('bad request');
    expect(parsed.name).toBe('CustomError');
    expect(parsed.code).toBe(400);
  });

  it('leaves non-Error objects going through the existing recursive branch untouched', () => {
    const parsed = JSON.parse(Utils.jsonStringify({ a: 1n, b: [1, 2n], c: { d: 'x' } }));
    expect(parsed).toEqual({ a: '1', b: [1, '2'], c: { d: 'x' } });
  });

});
