import { describe, it, expect, vi } from 'vitest';
import {
  Kernel,
  ok,
  err,
  combine,
  combineAll,
  fromThrowable,
  fromThrowableAsync,
  createToken,
  CommandRegistry,
  ExtensionManager,
  EventBus,
  ServiceContainer,
  Scheduler,
  DisposableStore,
  toDisposable,
  PRIORITY_WEIGHTS,
  localize,
} from '../src/index';

describe('Kernel (نواة P — الميكانيكا)', () => {
  it('boot يعيد KernelContext مع كل الأنظمة', async () => {
    const kernel = new Kernel();
    const res = await kernel.boot();
    expect(res.isOk).toBe(true);
    if (res.isErr) return;
    expect(res.value.events).toBeInstanceOf(EventBus);
    expect(res.value.commands).toBeInstanceOf(CommandRegistry);
    expect(res.value.services.get(createToken('x')).isErr).toBe(true);
    expect(res.value.scheduler).toBeDefined();
    expect(res.value.extensions).toBeInstanceOf(ExtensionManager);
  });

  it('boot آمن ضد الاستدعاء المزدوج', async () => {
    const kernel = new Kernel();
    const first = await kernel.boot();
    const second = await kernel.boot();
    expect(first.isOk && second.isOk).toBe(true);
  });

  it('يطلق حدث kernel:ready عند الإقلاع', async () => {
    const kernel = new Kernel();
    const handler = vi.fn();
    const disposables: any[] = [];
    kernel.getContext().events.on('kernel:ready', handler, disposables);
    await kernel.boot();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('shutdown ينهي الأنظمة ويعيد kernel:shutdown', async () => {
    const kernel = new Kernel();
    await kernel.boot();
    const shutdownHandler = vi.fn();
    const disposables: any[] = [];
    kernel.getContext().events.on('kernel:shutdown', shutdownHandler, disposables);

    const res = await kernel.shutdown();
    expect(res.isOk).toBe(true);
    expect(shutdownHandler).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ hadErrors: false }) })
    );
  });

  it('shutdown يعيد خطأ ويضع hadErrors=true عند إخفاق إلغاء تنشيط إضافة', async () => {
    const kernel = new Kernel();
    await kernel.boot();
    const shutdownHandler = vi.fn();
    const disposables: any[] = [];
    kernel.getContext().events.on('kernel:shutdown', shutdownHandler, disposables);

    await kernel.getContext().extensions.activate({
      id: 'faulty',
      name: { ar: 'معطوبة', en: 'faulty' },
      version: '1.0.0',
      activate: () => {},
      deactivate: () => { throw new Error('shutdown error'); },
    });

    const res = await kernel.shutdown();
    expect(res.isErr).toBe(true);
    if (res.isErr) {
      expect(res.error.message).toContain('shutdown error');
    }
    expect(shutdownHandler).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ hadErrors: true }) })
    );
  });
});

describe('ServiceContainer (ok/err + createToken)', () => {
  it('يرجع err عندما تكون الخدمة غير مسجلة', () => {
    const sc = new ServiceContainer();
    const token = createToken<number>('counter');
    const res = sc.get(token);
    expect(res.isErr).toBe(true);
    if (res.isErr) expect(res.error.message).toContain('counter');
  });

  it('يرجع ok مع الخدمة المسجلة', () => {
    const sc = new ServiceContainer();
    const token = createToken<number>('counter');
    sc.register(token, 42);
    const res = sc.get(token);
    expect(res.isOk && res.value).toBe(42);
  });

  it('يمنع تصادم الأسماء عبر Symbol الرمزي ويحمى من التسجيل المزدوج', () => {
    const sc = new ServiceContainer();
    const token1 = createToken<string>('db');
    const token2 = createToken<string>('db'); // same name string, distinct symbol token

    expect(token1.id).not.toBe(token2.id);

    sc.register(token1, 'pg');
    sc.register(token2, 'sqlite');

    const res1 = sc.get(token1);
    const res2 = sc.get(token2);
    expect(res1.isOk && res1.value).toBe('pg');
    expect(res2.isOk && res2.value).toBe('sqlite');

    // Attempting register again on same token fails
    const dupRes = sc.register(token1, 'new-pg');
    expect(dupRes.isErr).toBe(true);

    // Replace succeeds
    sc.replace(token1, 'new-pg');
    const res1Updated = sc.get(token1);
    expect(res1Updated.isOk && res1Updated.value).toBe('new-pg');
  });
});

describe('EventBus (الأحداث وربط المالك والخطأ الموحد)', () => {
  it('يولد معرف فريد تسلسلي ويربط الاشتراك بالمالك', () => {
    const bus = new EventBus();
    const disposables: any[] = [];
    let received: any = null;

    bus.on('data', (e) => { received = e; }, disposables);
    expect(disposables).toHaveLength(1);

    bus.emit('data', { x: 10 });
    expect(received).toBeDefined();
    expect(received.id).toMatch(/^\d+-\d+$/);
    expect(received.payload.x).toBe(10);

    // Dispose via owner
    disposables[0].dispose();
    bus.emit('data', { x: 20 });
    expect(received.payload.x).toBe(10); // unchanged
  });

  it('يسجل أخطاء المعالجات ولا يسقط حلقة الأحداث', () => {
    const bus = new EventBus();
    const disposables: any[] = [];
    bus.on('failing', () => {
      throw new Error('boom');
    }, disposables);

    bus.emit('failing', {});
    expect(bus.getHandlerErrors()).toHaveLength(1);
    expect(bus.getHandlerErrors()[0].error).toBe('boom');
  });
});

describe('CommandRegistry', () => {
  it('ينفّذ أمراً مسجلاً ويعيد نتيجته', async () => {
    const registry = new CommandRegistry();
    registry.register({
      id: 'file.save',
      title: { ar: 'حفظ', en: 'Save' },
      handler: () => 'saved',
    });
    const res = await registry.execute('file.save');
    expect(res.isOk && res.value).toBe('saved');
  });

  it('يرجع err عند أمر غير موجود', async () => {
    const registry = new CommandRegistry();
    const res = await registry.execute('missing.cmd');
    expect(res.isErr).toBe(true);
  });

  it('يسجل سجل التنفيذ', async () => {
    const registry = new CommandRegistry();
    registry.register({ id: 'a', title: { ar: 'أ', en: 'a' }, handler: () => 1 });
    await registry.execute('a');
    expect(registry.getLog()).toHaveLength(1);
    expect(registry.getLog()[0].success).toBe(true);
  });

  it('يحمي من الحذف الخاطئ عند التسجيل المزدوج ويربط بالمالك owner', async () => {
    const registry = new CommandRegistry();
    const ownerDisposables: any[] = [];

    const dispA = registry.register({ id: 'cmd.duplicate', title: { ar: 'أ', en: 'a' }, handler: () => 'A' });
    registry.register({ id: 'cmd.duplicate', title: { ar: 'ب', en: 'b' }, handler: () => 'B' }, ownerDisposables);

    expect(ownerDisposables).toHaveLength(1);

    // Old registration A disposes - should NOT remove B from registry
    dispA.dispose();
    expect(registry.has('cmd.duplicate')).toBe(true);

    const resB = await registry.execute('cmd.duplicate');
    expect(resB.isOk && resB.value).toBe('B');

    // Owner disposes B
    ownerDisposables[0].dispose();
    expect(registry.has('cmd.duplicate')).toBe(false);
  });

  it('يفحص التمكين الشرطي isEnabled ويرفض التنفيذ إذا كان معطلاً', async () => {
    const registry = new CommandRegistry();
    let enabled = false;

    registry.register({
      id: 'cmd.conditional',
      title: { ar: 'شرطي', en: 'conditional' },
      isEnabled: () => enabled,
      handler: () => 'done',
    });

    const resDisabled = await registry.execute('cmd.conditional');
    expect(resDisabled.isErr).toBe(true);

    enabled = true;
    const resEnabled = await registry.execute('cmd.conditional');
    expect(resEnabled.isOk && resEnabled.value).toBe('done');
  });
});

describe('ExtensionManager', () => {
  it('يفعّل إضافة ويستدعي activate', async () => {
    const em = new ExtensionManager();
    const activate = vi.fn();
    const res = await em.activate({ id: 'e1', name: { ar: 'إضافة', en: 'ext' }, version: '1.0.0', activate });
    expect(res.isOk).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(em.isActivated('e1')).toBe(true);
    expect(em.getActiveCount()).toBe(1);
    expect(em.get('e1')?.version).toBe('1.0.0');
  });

  it('لا يعيد التنشيط للإضافة المفعّلة مسبقاً', async () => {
    const em = new ExtensionManager();
    const activate = vi.fn();
    await em.activate({ id: 'e1', name: { ar: 'إ', en: 'e' }, version: '1', activate });
    await em.activate({ id: 'e1', name: { ar: 'إ', en: 'e' }, version: '1', activate });
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('يزيل الإضافة من القائمة حتى لو فشل deactivate الضمني (finally guarantee)', async () => {
    const em = new ExtensionManager();
    await em.activate({
      id: 'failing',
      name: { ar: 'فاشل', en: 'failing' },
      version: '1.0.0',
      activate: () => {},
      deactivate: () => { throw new Error('deactivate error'); },
    });

    const res = await em.deactivate('failing');
    expect(res.isErr).toBe(true);
    expect(em.isActivated('failing')).toBe(false);
    expect(em.getActiveCount()).toBe(0);
  });

  it('يدعم deactivateAll لإلغاء تنشيط الإضافات بالترتيب العكسي (LIFO)', async () => {
    const em = new ExtensionManager();
    const order: string[] = [];

    await em.activate({
      id: 'ext1',
      name: { ar: '1', en: '1' },
      version: '1',
      activate: () => {},
      deactivate: () => { order.push('deactivate:ext1'); },
    });

    await em.activate({
      id: 'ext2',
      name: { ar: '2', en: '2' },
      version: '1',
      activate: () => {},
      deactivate: () => { order.push('deactivate:ext2'); },
    });

    const res = await em.deactivateAll();
    expect(res.isOk).toBe(true);
    expect(order).toEqual(['deactivate:ext2', 'deactivate:ext1']);
    expect(em.getActiveCount()).toBe(0);
  });
});

describe('Scheduler', () => {
  it('يقوم بدعم debounce مع إلغاء المؤقت السابق عند التكرار والربط بالمالك دون تكرار العناصر فيه', async () => {
    const scheduler = new Scheduler();
    const disposables: any[] = [];
    const runFn = vi.fn();

    scheduler.debounce({ id: 't1', run: runFn }, 50, disposables);
    scheduler.debounce({ id: 't1', run: runFn }, 50, disposables);
    scheduler.debounce({ id: 't1', run: runFn }, 50, disposables);

    // يضاف عنصر واحد فقط للمالك عند البداية ويمنع تراكم التكرار
    expect(disposables).toHaveLength(1);
    expect(scheduler.getActiveCount()).toBe(1);

    await new Promise((r) => setTimeout(r, 80));
    expect(runFn).toHaveBeenCalledTimes(1);
    expect(scheduler.getActiveCount()).toBe(0);
  });

  it('يدعم throttle مع ضمان تنفيذ أحدث مهمة (Trailing Task Execution) عند خنق الاستدعاءات المتكررة', async () => {
    const scheduler = new Scheduler();
    const disposables: any[] = [];
    const executedPayloads: string[] = [];

    // First call executed immediately (t=0)
    scheduler.throttle({ id: 't2', run: () => { executedPayloads.push('first'); } }, 100, disposables);
    // Second call queued (t=10)
    scheduler.throttle({ id: 't2', run: () => { executedPayloads.push('second-ignored'); } }, 100, disposables);
    // Third call overrides queued task with latest payload (t=20)
    scheduler.throttle({ id: 't2', run: () => { executedPayloads.push('third-latest'); } }, 100, disposables);

    expect(executedPayloads).toEqual(['first']);

    await new Promise((r) => setTimeout(r, 130));
    // Must execute latest task ('third-latest'), NOT the intermediate ('second-ignored')
    expect(executedPayloads).toEqual(['first', 'third-latest']);
  });

  it('يحمي من Stale Disposal عند استدعاء dispose قديم مع وجود مهمة أحدث بنفس المعرّف', async () => {
    const scheduler = new Scheduler();
    const executedPayloads: string[] = [];

    const task1 = { id: 'stale.test', run: () => { executedPayloads.push('task1'); } };
    const task2 = { id: 'stale.test', run: () => { executedPayloads.push('task2'); } };

    // T0: First throttle executes task1 immediately
    const disp1 = scheduler.throttle(task1, 100);
    // T1: Second throttle queues task2
    scheduler.throttle(task2, 100);

    // Stale dispose on disp1 - should NOT delete task2 from pendingTasks
    disp1.dispose();

    await new Promise((r) => setTimeout(r, 120));
    expect(executedPayloads).toEqual(['task1', 'task2']);
  });

  it('يدعم cancel و cancelAll لتنظيف كافة المؤقتات والمهام المتبقية', () => {
    const scheduler = new Scheduler();
    const disposables: any[] = [];
    const runFn = vi.fn();

    scheduler.debounce({ id: 't1', run: runFn }, 100, disposables);
    scheduler.debounce({ id: 't2', run: runFn }, 100, disposables);
    expect(scheduler.getActiveCount()).toBe(2);

    scheduler.cancel('t1');
    expect(scheduler.getActiveCount()).toBe(1);

    scheduler.cancelAll();
    expect(scheduler.getActiveCount()).toBe(0);
  });
});

describe('DisposableStore', () => {
  it('يدعم toDisposable وتحويل الدوال إلى Disposable', () => {
    const fn = vi.fn();
    const d = toDisposable(fn);
    d.dispose();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('يتتبع حالة disposed عبر الخصيصة العائدة', () => {
    const store = new DisposableStore();
    expect(store.disposed).toBe(false);
    store.dispose();
    expect(store.disposed).toBe(true);
  });

  it('ينفذ التنظيف الذاتي تلقائياً عند استدعاء dispose الفردي (Auto-unlinking)', () => {
    const store = new DisposableStore();
    const cleanupFn = vi.fn();
    const d = store.add(toDisposable(cleanupFn));

    // استدعاء التخلص الفردي
    d.dispose();
    expect(cleanupFn).toHaveBeenCalledTimes(1);

    // عند التخلص من المفهوم الرئيسي (Store.dispose) لا يتكرر الاستدعاء
    store.dispose();
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('يدعم delete لحذف عنصر يدويًا بدون استدعاء dispose عليه', () => {
    const store = new DisposableStore();
    const cleanupFn = vi.fn();
    const d = toDisposable(cleanupFn);

    store.add(d);
    store.delete(d);
    store.dispose();

    expect(cleanupFn).not.toHaveBeenCalled();
  });

  it('delete يفصل الملكية لكن الكائن يبقى قابلاً للتنظيف الذاتي بعدها', () => {
    const store = new DisposableStore();
    const cleanupFn = vi.fn();
    const d = store.add(toDisposable(cleanupFn));

    store.delete(d);
    d.dispose();

    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });
});

describe('Result (ok/err)', () => {
  it('ok يحمل isOk=true', () => {
    expect(ok(1).isOk).toBe(true);
    expect(ok(1).isErr).toBe(false);
  });
  it('err يحمل isErr=true', () => {
    const e = err(new Error('x'));
    if (!e.isErr) throw new Error('expected err');
    expect(e.isErr).toBe(true);
    expect(e.error.message).toBe('x');
  });

  it('combine يعمل بأسلوب fail-fast ويعيد أول خطأ أو القيم كاملة', () => {
    const successRes = combine([ok(1), ok(2), ok(3)]);
    expect(successRes.isOk).toBe(true);
    if (successRes.isOk) {
      expect(successRes.value).toEqual([1, 2, 3]);
    }

    const failRes = combine([ok(1), err(new Error('e1')), err(new Error('e2'))]);
    expect(failRes.isErr).toBe(true);
    if (failRes.isErr) {
      expect(failRes.error.message).toBe('e1');
    }
  });

  it('combineAll يجمع كافة الأخطاء بدلاً من التوقف عند الأول', () => {
    const failAll = combineAll([ok(1), err('e1'), err('e2')]);
    expect(failAll.isErr).toBe(true);
    if (failAll.isErr) {
      expect(failAll.error).toEqual(['e1', 'e2']);
    }
  });

  it('fromThrowable يعالج الدوال المتزامنة التي تطلق استثناءات', () => {
    const success = fromThrowable(() => 42);
    expect(success.isOk).toBe(true);
    if (success.isOk) expect(success.value).toBe(42);

    const failure = fromThrowable(() => {
      throw new Error('boom');
    });
    expect(failure.isErr).toBe(true);
    if (failure.isErr) expect(failure.error.message).toBe('boom');
  });

  it('fromThrowableAsync يعالج الدوال غير المتزامنة بشكل صحيح', async () => {
    const success = await fromThrowableAsync(async () => 'async result');
    expect(success.isOk).toBe(true);
    if (success.isOk) expect(success.value).toBe('async result');

    const failure = await fromThrowableAsync(async () => {
      throw new Error('async error');
    });
    expect(failure.isErr).toBe(true);
    if (failure.isErr) expect(failure.error.message).toBe('async error');
  });
});

describe('PRIORITY_WEIGHTS & localize', () => {
  it('PRIORITY_WEIGHTS تحتوي أوزان ترتيب الأولويات الصحيحة', () => {
    expect(PRIORITY_WEIGHTS.low).toBeLessThan(PRIORITY_WEIGHTS.normal);
    expect(PRIORITY_WEIGHTS.normal).toBeLessThan(PRIORITY_WEIGHTS.high);
    expect(PRIORITY_WEIGHTS.high).toBeLessThan(PRIORITY_WEIGHTS.critical);
  });

  it('localize يتعامل بأمان مع السلاسل والكائنات غير المكتملة والقيم الفارغة', () => {
    expect(localize('plain string')).toBe('plain string');
    expect(localize(null)).toBe('');
    expect(localize(undefined)).toBe('');

    expect(localize({ ar: 'مرحبا', en: 'hello' }, 'ar')).toBe('مرحبا');
    expect(localize({ ar: 'مرحبا', en: 'hello' }, 'en')).toBe('hello');

    // Fallbacks
    expect(localize({ ar: 'عربي فقط', en: '' }, 'en')).toBe('عربي فقط');
  });
});

