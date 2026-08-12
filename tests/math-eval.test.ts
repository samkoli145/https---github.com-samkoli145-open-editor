import { describe, it, expect } from 'vitest';
import { evaluateMathExpression } from '../src/agent-kernel/math-eval';
import { ToolRegistry } from '../src/agent-kernel/tools';

describe('§5-ز — محلّل حسابي خاص بدل new Function (لا eval)', () => {
  it('يحسب الجمع والطرح والضرب والقسمة مع الأسبقية الصحيحة', () => {
    expect(evaluateMathExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateMathExpression('(2 + 3) * 4')).toBe(20);
    expect(evaluateMathExpression('10 - 4 / 2')).toBe(8);
    expect(evaluateMathExpression('20 / 4 * 2')).toBe(10);
  });

  it('يدعم الكسور والعلامات الأحادية والأقواس المتداخلة', () => {
    expect(evaluateMathExpression('1.5 * 2')).toBe(3);
    expect(evaluateMathExpression('-3 + 7')).toBe(4);
    expect(evaluateMathExpression('-(2 + 3)')).toBe(-5);
    expect(evaluateMathExpression('((1 + 2) * (3 + 4))')).toBe(21);
    expect(evaluateMathExpression('2 - -3')).toBe(5);
  });

  it('يرفض الرموز غير المسموحة والبنية الفاسدة والقسمة على صفر', () => {
    expect(() => evaluateMathExpression('process.exit()')).toThrow();
    expect(() => evaluateMathExpression('2 +')).toThrow();
    expect(() => evaluateMathExpression('(2 + 3')).toThrow();
    expect(() => evaluateMathExpression('2 + 3)')).toThrow();
    expect(() => evaluateMathExpression('2..3')).toThrow();
    expect(() => evaluateMathExpression('1/0')).toThrow();
    expect(() => evaluateMathExpression('')).toThrow();
    expect(() => evaluateMathExpression('2 ; 3')).toThrow();
  });

  it('أداة calc تستخدم المحلل الآمن (نفس السلوك من خلال النواة)', async () => {
    const registry = new ToolRegistry();
    const okRes = await registry.executeTool('calc', { expr: '(10 + 20) * 3' });
    expect(okRes.isOk).toBe(true);
    if (okRes.isOk) expect(okRes.value).toBe(90);

    const badRes = await registry.executeTool('calc', { expr: 'process.exit()' });
    expect(badRes.isErr).toBe(true);
    if (badRes.isErr) expect(badRes.error.message).toContain('EEXEC');

    const divZero = await registry.executeTool('calc', { expr: '1/0' });
    expect(divZero.isErr).toBe(true);
  });
});
