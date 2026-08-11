import { Result, ok, err } from './core/result';

/**
 * ServiceToken مع مفتاح فريد (symbol) لمنع تصادم الأسماء بشكل مضمون،
 * بالإضافة إلى اسم نصي لأغراض العرض والتصحيح.
 */
export interface ServiceToken<T> {
  readonly id: symbol;
  readonly name: string;
  _type?: T;
}

export function createToken<T>(name: string): ServiceToken<T> {
  return { id: Symbol(name), name };
}

export class ServiceContainer {
  private services = new Map<symbol, unknown>();

  /**
   * تسجيل خدمة جديدة. يرجع خطأ إذا كانت الخدمة مسجلة مسبقاً بنفس الـ Token.
   * للاستبدال الصريح للخدمة، استخدم `replace()`.
   */
  register<T>(token: ServiceToken<T>, service: T): Result<void, Error> {
    if (this.services.has(token.id)) {
      return err(new Error(`Service '${token.name}' already registered in ServiceContainer — use replace() explicitly`));
    }
    this.services.set(token.id, service);
    return ok(undefined);
  }

  /**
   * استبدال صريح لخدمة مسجلة مسبقاً أو إضافة جديدة.
   */
  replace<T>(token: ServiceToken<T>, service: T): Result<void, Error> {
    this.services.set(token.id, service);
    return ok(undefined);
  }

  get<T>(token: ServiceToken<T>): Result<T, Error> {
    const service = this.services.get(token.id);
    if (!service) {
      return err(new Error(`Service '${token.name}' not registered in ServiceContainer`));
    }
    return ok(service as T);
  }

  has<T>(token: ServiceToken<T>): boolean {
    return this.services.has(token.id);
  }

  clear(): void {
    this.services.clear();
  }
}

