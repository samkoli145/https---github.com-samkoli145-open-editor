export type Result<T, E = Error> = Ok<T> | Err<E>;

export class Ok<T> {
  readonly isOk = true as const;
  readonly isErr = false as const;
  constructor(readonly value: T) {}
}

export class Err<E> {
  readonly isOk = false as const;
  readonly isErr = true as const;
  constructor(readonly error: E) {}
}

export function ok<T>(value: T): Result<T, never> {
  return new Ok(value);
}

export function err<E>(error: E): Result<never, E> {
  return new Err(error);
}

/**
 * دمج نتائج قائمة (Fail-Fast): يعيد أول خطأ أو مصفوفة القيم
 */
export function combine<T, E>(results: Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const res of results) {
    if (res.isErr) return err(res.error);
    values.push(res.value);
  }
  return ok(values);
}

/**
 * دمج نتائج قائمة مع جمع كافة الأخطاء بدلاً من التوقف عند أول خطأ
 */
export function combineAll<T, E>(results: Result<T, E>[]): Result<T[], E[]> {
  const values: T[] = [];
  const errors: E[] = [];
  for (const res of results) {
    if (res.isErr) {
      errors.push(res.error);
    } else {
      values.push(res.value);
    }
  }
  return errors.length > 0 ? err(errors) : ok(values);
}

/**
 * تحويل تنفيذ دالة متزامنة قد تطلق استثناءً إلى Result
 */
export function fromThrowable<T, E = Error>(
  fn: () => T,
  errorMapper?: (err: unknown) => E
): Result<T, E> {
  try {
    return ok(fn());
  } catch (e) {
    const mapped = errorMapper ? errorMapper(e) : (e instanceof Error ? e : new Error(String(e))) as unknown as E;
    return err(mapped);
  }
}

/**
 * تحويل تنفيذ دالة غير متزامنة قد تطلق استثناءً إلى Promise<Result>
 */
export async function fromThrowableAsync<T, E = Error>(
  fn: () => Promise<T>,
  errorMapper?: (err: unknown) => E
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (e) {
    const mapped = errorMapper ? errorMapper(e) : (e instanceof Error ? e : new Error(String(e))) as unknown as E;
    return err(mapped);
  }
}
