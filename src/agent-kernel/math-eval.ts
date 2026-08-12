/**
 * محلّل حسابي خاص (recursive descent) — بديل آمن عن `new Function` في أداة calc.
 * يدعم: أرقام صحيحة/عشرية · عمليات + - * / · أقواس · علامات أحادية (+/-).
 * لا تنفيذ كود (لا eval/no new Function) — أخطاء البنية تُرمى بأسباب عربية واضحة.
 */

type TokenType = 'number' | 'op' | 'lparen' | 'rparen' | 'eof';

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const src = input.trim();
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch });
      i++;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    if (/\d/.test(ch) || ch === '.') {
      let j = i;
      let dotSeen = false;
      while (j < src.length && (/\d/.test(src[j]) || src[j] === '.')) {
        if (src[j] === '.') {
          if (dotSeen) throw new Error("رقم غير صالح (نقطة مكررة)");
          dotSeen = true;
        }
        j++;
      }
      if (dotSeen && src.slice(i, j) === '.') throw new Error("رقم غير صالح");
      tokens.push({ type: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`رمز غير مسموح '${ch}'`);
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

function evaluateTokens(tokens: Token[]): number {
  let pos = 0;
  const peek = (): Token => tokens[pos];
  const expect = (type: TokenType, what: string): Token => {
    const t = peek();
    if (t.type !== type) throw new Error(`متوقع ${what}`);
    pos++;
    return t;
  };

  const parseExpression = (): number => {
    let value = parseTerm();
    for (;;) {
      const t = peek();
      if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
        pos++;
        const rhs = parseTerm();
        value = t.value === '+' ? value + rhs : value - rhs;
      } else {
        break;
      }
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    for (;;) {
      const t = peek();
      if (t.type === 'op' && (t.value === '*' || t.value === '/')) {
        pos++;
        const rhs = parseFactor();
        if (t.value === '/') {
          if (rhs === 0) throw new Error('القسمة على صفر');
          value = value / rhs;
        } else {
          value = value * rhs;
        }
      } else {
        break;
      }
    }
    return value;
  };

  const parseFactor = (): number => {
    const t = peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      pos++;
      const operand = parseFactor();
      return t.value === '-' ? -operand : operand;
    }
    return parsePrimary();
  };

  const parsePrimary = (): number => {
    const t = peek();
    if (t.type === 'number') {
      pos++;
      const n = Number(t.value);
      if (!Number.isFinite(n)) throw new Error('رقم غير صالح');
      return n;
    }
    if (t.type === 'lparen') {
      pos++;
      const inner = parseExpression();
      expect('rparen', "')'");
      return inner;
    }
    throw new Error('تعبير غير متوقع');
  };

  const value = parseExpression();
  if (peek().type !== 'eof') throw new Error('رموز زائدة بعد التعبير');
  return value;
}

/** يحسب تعبيراً حسابياً آمناً بلا eval؛ يرمي Error عند أي خلل بنيوي */
export function evaluateMathExpression(input: string): number {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('تعبير حسابي غير صالح');
  }
  const value = evaluateTokens(tokenize(input));
  if (!Number.isFinite(value)) {
    throw new Error('نتيجة غير محدودة');
  }
  return value;
}
