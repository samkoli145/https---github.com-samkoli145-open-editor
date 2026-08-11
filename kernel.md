# النواة الذكية — خريطة المشروع (Nawat Kernel)

> **مشروع مستقل بذاته:** نواة برمجية ذكية معيارية «تتطور معك» — تُبنى كما لو كانت نموذج ذكاء اصطناعي (infer → decide → act)،
> بنماذج محلية فقط، ومسار عمل قائم على التوجيهات الخمسة. الحالة: **166/166 اختباراً أخضر (10 ملفات)** · `tsc` نظيف · `build` نظيف.

---

## 1. رسم المشروع (الرؤية)

نواة برمجية تعمل في **أربع طبقات متدرجة**، كل طبقة مستقلة عن التي تحتها:

```
┌────────────────────────────────────────────────────────────────┐
│  المستضيف (Host) — الإقلاع والتشغيل                              │
│  bootNawat · PROFILES (4 أنماط) · NawatRuntime (آلة حالة) ·      │
│  VirtualFileSystem · config-loader · bin/nawat.ts (CLI)         │
├────────────────────────────────────────────────────────────────┤
│  النواة العليا (Agent Kernel — AIOS)                             │
│  llm-core · syscall · tools · registry · quota · session ·      │
│  storage + هيرمس (تعليم) + intelligence (عقل) + logic (DNA)      │
├────────────────────────────────────────────────────────────────┤
│  نواة النظام (P) — الميكانيكا                                    │
│  kernel + core (result/event-bus/disposable/cache) + i18n +     │
│  command-registry + scheduler + extension-manager               │
├────────────────────────────────────────────────────────────────┤
│  النظام (System) — البنية التحتية                                 │
│  vfs (path-sanitizer · file-type-detector · persistent-indexer) │
│  engine (base-engine · execution-sandbox) · storage             │
└────────────────────────────────────────────────────────────────┘
```

**المبدأ الجوهري:** النموذج الكبير «معلم» لا «عقل دائم» — يدفع (push) مواد تدريب (قواعد/نواهٍ/حقائق/مهارات) إلى جسر التعليم،
فتتحول إلى نواهٍ ومعرفة **فعالة** تغيّر سلوك الحلقة الرمزية، فتعمل النواة مستقلة ومتطورة بلا LLM مستمر، وتحفظ/تستأنف عبر VFS.

**معادلة سرعة النواة (عارية من أنوية الاتصالات):** النواة «مستوى إشارة» (Signaling Plane) — عملها ≤ **10ms** في كل المسارات
(`LRUCache` بمعامل TTL من `core/cache.ts` يخدم التخزين المؤقت للـLLM وأدواته دون تجاوز الميزانية)،
ومسار الوسائط الثقيل (ollama) يُسلَّم ثم يُتابَع ويُقاس زمنه كمقياس لا كفشل.

---

## 2. المطلوب (Deliverables / المتطلبات)

| الطبقة | المكوّن | الملف | المطلوب منه |
|---|---|---|---|
| نواة P | Kernel + أحداث | `src/kernel/kernel.ts` + `core/result.ts` + `core/event-bus.ts` + `core/disposable.ts` | KernelContext، أحداث `kernel:ready`، Result (`ok/err`)، EventBus بمالك إجباري، Disposable/DisposableStore |
| نواة P | حاويات/سجلات/جدولة | `service-container.ts` · `command-registry.ts` · `scheduler.ts` · `extension-manager.ts` | DI بـ `createToken`، أوامر مسجلة بملاك، debounce/throttle، تحميل امتدادات |
| نواة P | تخزين مؤقت | `core/cache.ts` | `LRUCache` معامِل TTL وO(1) لموازنة الـ10ms (ذروة/طلعة/نسبة إصابة مقيسة) |
| نواة P | i18n | `i18n/localized-string.ts` | `LocalizedString {ar, en}` عربي أول |
| مستضيف | إقلاع | `host/bootloader.ts` | `Bootloader` + `bootNawat` بمراحل: config-loaded→vfs-mounted→kernel-ready→agent/hermes-ready→extensions-loaded→running |
| مستضيف | أنماط/تشغيل | `host/profiles.ts` · `host/runtime.ts` | 4 أنماط (headless/agent/hermes/editor) + `NawatRuntime` بآلة حالة صارمة `VALID_TRANSITIONS` + مقاييس (bootTimeMs، signalingLatencyMs، …) + `pendingSyscalls` (ECANCELED/EKILLED) |
| مستضيف | VFS/إعداد | `host/vfs.ts` · `host/config-loader.ts` | نظام ملفات افتراضي + قراءة ملف إعداد يتجاوز النمط |
| نواة عليا | LLM | `agent-kernel/llm-core.ts` | توجيه متسلسل/دائري + `OllamaBackend` (محلي بلا سحابة) + `DeterministicBackend` |
| نواة عليا | نداءات/أدوات/وكلاء | `syscalls.ts` · `tools.ts` · `registry.ts` | دورة حياة syscall، سجل أدوات، هوية/حالة الوكيل |
| نواة عليا | حصص/جلسات/تخزين | `quota.ts` · `session.ts` · `storage.ts` | `ResourceQuotaGuard` (حصص الموارد) · `SessionManager` (جلسات دائمة مع دفق) · `SafeStorageEngine` (بمجاميع تحقق) |
| نواة عليا | تنفيذ أرش (ELF/أوامر) | `linux-arch-execution-layer.ts` | `LinuxArchExecutionLayer` — تنفيذ حقيقي `execFile` بلا shell ببوابات إلزامية: code-domain → allowlist → quota (زمن/معدل/أخطاء) → تحقق ELF (توقيع + بت تنفيذ) + `sanitizePath` |
| هيرمس | سلك + حلقة | `hermes/hermes-adapter.ts` · `hermes/agent-loop.ts` | صيغة OpenAI Function-Calling + SymbolicLoop (Observe→Think→Decide→Act→Output) مع MetricSink |
| هيرمس | شخصيات/تعليم | `hermes/persona-system.ts` · `hermes/teaching-bridge.ts` · `hermes/material-schema.ts` | أدوار (مساعد/معلم/محلل) + مواد→نواهٍ/معرفة فعالة |
| هيرمس | اللصق | `hermes/hermes-kernel.ts` | أوامر `hermes.*` + ربط بحلقة النواة |
| العقل | استدلال/سياق/قرار/قيود | `intelligence/inference-engine.ts` · `context-model.ts` · `decision-engine.ts` · `constraint-engine.ts` | `inferFacts → decide → act` بلا LLM + «النواهي قبل الأوامر» (حجب hard/soft/audit) |
| المنطق | DNA | `logic/kernel-forge.ts` · `compiler.ts` · `retro-extractor.ts` · `program-distiller.ts` · `domains/*` | توليد نوى مجالات + الحصاد من برامج قائمة |
| النظام | VFS/محرك | `system/vfs/*` · `system/engine/base-engine.ts` · `system/engine/execution-sandbox.ts` · `system/storage.ts` | تنقية مسارات + تعرّف نوع ملف + فهرسة دائمة + محرك أساسي + صندوق تنفيذ معزول |

---

## 3. المستهدف (Targets / أهداف قابلة للقياس)

| الهدف | الحالة | القياس |
|---|---|---|
| نواة P كاملة (Result/EventBus/Scheduler/DI/Extensions/Cache) | ✅ مكتمل | `kernel.test.ts` (36) |
| مستضيف إقلاع بأنماط + آلة حالة صارمة + VFS | ✅ مكتمل | `host.test.ts` (19) |
| نواة عليا (llm-core/syscall/tools/registry/quota/session/storage/أرش) | ✅ مكتمل | `agent-kernel.test.ts` (15) + `architecture-enhancements.test.ts` (10) + `linux-arch-execution-layer.test.ts` (36) |
| حلقة هيرمس + تعليم + شخصيات | ✅ مكتمل | `hermes.test.ts` (9) |
| العقل (infer→decide→act) + قيود | ✅ مكتمل | `intelligence.test.ts` (8) |
| المنطق (forge/compiler/retro/distill) | ✅ مكتمل | `logic.test.ts` (12) |
| النظام (VFS/محرك/صندوق تنفيذ/تخزين/ماسح مشروع) | ✅ مكتمل | `system.test.ts` (18) + `project-scanner.test.ts` (6) |
| مرونة/ضغط | ✅ مكتمل | `stress.test.ts` (3) |
| **الكلّي الأخضر** | ✅ **172/172** | 11 ملفات اختبار |
| `tsc --noEmit` نظيف + `bun run build` نظيف | ✅ | `dist/` |
| CLI + خادم (bin/nawat.ts + server.ts) | ✅ تشغيل | `nawat boot/status/profiles` · REST (health، kernel status) |
| نماذج محلية (Ollama) | 🟡 واجهة جاهزة | `OllamaBackend` موجود؛ الاختبار الحقيقي معلّق حتى وجود نموذج |
| كرة الثلج — تعلم من مصادر متعددة | ⏳ قادمة | `snowball.ts` عند التنفيذ |
| واجهة فاتحة 100% | ⏳ مرحلة الواجهة | لا أسود/داكن |

---

## 4. شجرة المشروع (Project Tree)

```
kernel-project/
├── src/                              (55 ملفاً · ~4845 سطراً)
│   ├── index.ts                      ← برميل التصدير: kernel + host + agent-kernel + system
│   ├── kernel/                       ← الميكانيكا (نواة P): kernel.ts · core/result · event-bus ·
│   │   │                                 disposable · types · cache · i18n/localized-string ·
│   │   │                                 service-container · command-registry · scheduler ·
│   │   │                                 extension-manager
│   │   └── core/cache.ts             ← LRUCache بمعامل TTL (موازنة الـ10ms)
│   ├── host/                         ← المستضيف (NEW): bootloader (bootNawat) · runtime
│   │   │                                 (NawatRuntime + آلة حالة + مقاييس) · profiles (4 أنماط) ·
│   │   │                                 vfs · config-loader
│   │   └── index.ts
│   ├── agent-kernel/                 ← النواة العليا (AIOS):
│   │   ├── llm-core.ts               ← LLMCore + OllamaBackend + DeterministicBackend
│   │   ├── syscalls.ts               ← AgentSyscall + queue (دورة حياة + أزمنة)
│   │   ├── tools.ts                  ← ToolRegistry + أدوات افتراضية
│   │   ├── registry.ts               ← هوية/حالة الوكيل
│   │   ├── quota.ts                  ← ResourceQuotaGuard (حصص الموارد)
│   │   ├── linux-arch-execution-layer.ts ← تنفيذ أرش/ELF/سكربتات ببوابات: code-domain →
│   │   │                                 allowlist → quota → جذر تنفيذ (realpath) → ELF/shebang
│   │   ├── session.ts                ← SessionManager (جلسات دائمة + دفق)
│   │   ├── storage.ts                ← SafeStorageEngine (مجاميع تحقق)
│   │   ├── hermes/                   ← طبقة هيرمس: hermes-adapter · agent-loop ·
│   │   │   │                             hermes-kernel · persona-system · teaching-bridge ·
│   │   │   │                             material-schema
│   │   │   └── index.ts
│   │   ├── intelligence/             ← العقل: inference-engine · context-model ·
│   │   │   │                             decision-engine · constraint-engine
│   │   │   └── index.ts
│   │   ├── logic/                    ← المنطق: kernel-forge · compiler · retro-extractor ·
│   │   │   │                             program-distiller · domains (code/reasoning/scraping)
│   │   │   └── index.ts
│   │   └── index.ts
│   └── system/                       ← النظام (NEW): vfs (path-sanitizer · file-type-detector ·
│       │                                 persistent-indexer · project-scanner) · engine
│       │                                 (base-engine · execution-sandbox) · storage
│       └── index.ts
├── bin/nawat.ts                      ← CLI: nawat boot [--profile=…] · status · profiles
├── server.ts                         ← خادم Express: host/agent/hermes + REST (arch + projects/scan)
├── tests/                            ← 11 ملفات · 172 اختباراً:
│   │                                     kernel (36) · host (19) · agent-kernel (15) ·
│   │                                     system (18) · logic (12) · architecture-enhancements (10) ·
│   │                                     hermes (9) · intelligence (8) · stress (3) ·
│   │                                     linux-arch-execution-layer (36) · project-scanner (6)
├── kernel.md                         ← ← هذا الملف: خريطة المشروع + سورس النواة
├── metadata.json                     ← تعريف النشر (AI Studio)
├── package.json · tsconfig*.json · vitest.config.ts · bun.lock
└── dist/                             ← مخرجات البناء النظيفة
```

---

## 5. القابل للنمو (Extensibility / نقاط النمو)

| نقطة النمو | الآلية الحالية | كيف تتسع لاحقاً |
|---|---|---|
| **الأنماط (Profiles)** | `PROFILES` (headless/agent/hermes/editor) + `enableAgentKernel/enableHermes/enableEditor/enableLinuxHost` | نمط جديد يُضاف ككائن واحد، وكل ما ينشّطه يُربط في `Bootloader.initializeKernel` |
| **آلة الحالة** | `VALID_TRANSITIONS` في `NawatRuntime` | مراحل إقلاع جديدة (interface-ready…) تُضاف كأعضاء في `RuntimeState` + جدول الانتقال |
| **الحصص (Quota)** | `ResourceQuotaGuard` | قواعد تحكّم جديدة بموارد إضافية دون تغيير النواة |
| **الجلسات** | `SessionManager` (دائم + دفق) | جلسات متعددة العملاء عبر `server.ts` |
| **أنواع المواد** | `MaterialType` مرن (rule/example/constraint/policy/fact/skill/…) | أنواع تعليم جديدة تُعالج في `teaching-bridge` |
| **أنواع أدوات الحلقة** | `ToolRegistry` + `LoopToolSet` | أي أداة تُسجَّل تُقاس تلقائياً (latency/confidence) |
| **نماذج LLM** | `ILLMBackend` (Ollama أساسي) | llama.cpp / LM Studio / أي نهاية تلتزم الواجهة |
| **العقل/المنطق** | `InferenceEngine` + `LogicDNA` | نوى مجالات جديدة عبر `kernel-forge` + الحصاد `retro-extractor`/`program-distiller` |
| **تنفيذ أرش (ELF/أوامر)** | `LinuxArchExecutionLayer` — بوابات (code-domain → allowlist → quota → جذر تنفيذ → ELF/shebang) | عزل نظامي أعمق (bubblewrap/Landlock) · قوائم سماح لكل نمط · توقيعات ELF معمّقة (e_ident/e_type) · ربطه بـ`ToolRegistry`/`HermesKernel` |
| **فحص مشروع خارجي** | `scanProject` — مخفي (نقطية/Unicode) · قابل تنفيذ · setuid/backdoor · هروب روابط · مزروع/معبث/مفقود مقابل `PersistentIndexer` | خط أساس دائم (مخزن SHA-256) · عزل أثناء الفحص · جداول `dist`/`node_modules` مخصّصة لكل مشروع |
| **VFS/النظام** | `system/vfs` + `engine/base-engine` + `execution-sandbox` | مخزن قرص حقيقي + صندوق عزل مضيّق دون تغيير النواة |
| **إضافات/وحدات** | `ExtensionManager` | تحميل وحدات معيارية فوق نواة ثابتة (نموذج GKI) |
| **كرة الثلج** | مقاييس/معاملات قابلة للجمع | مصادر متعددة تُجمَّع في كرة تنمو (`snowball.ts`) |

---

## 6. الحالة الختامية (Checkpoint)

- ✅ **172/172 اختباراً أخضر (11 ملفات)** · `tsc --noEmit` نظيف · `bun run build` نظيف.
- ✅ أربع طبقات مكتملة: نواة P (11 ملفاً بلا اعتماد خارجي) + مستضيف إقلاع بأنماط + نواة عليا AIOS + نظام VFS/محرك.
- ✅ تنفيذ أرش حقيقي (`LinuxArchExecutionLayer`) + ماسح مشروع خارجي (`scanProject`) — يكتشف الملفات المخفية (نقطية/Unicode)، القابل للتنفيذ، setuid، هروب الروابط، المزروع/المعبث/المفقود مقابل الفهرس.
- ✅ النواة تعمل بلا LLM مستمر (حلقة رمزية حتمية) + تعليم يغيّر سلوكها فعلياً عبر هيرمس.
- ✅ موازنة الـ10ms حاضرة: `signalingLatencyMs` في المقاييس + `LRUCache` بمعامل TTL.
- ✅ CLI (`bin/nawat.ts`) + خادم Express (`server.ts`) يعملان فوق النواة.
- ⏳ المتبقي: اختبار Ollama حقيقي عند توفر نموذج · كرة الثلج · واجهة فاتحة · محرر كامل.
- ⚠️ فجوات أمنية مسجّلة (تتبع في `PLAN.md` §5): عولج **غ** (ربط 127.0.0.1 + مفتاح API + تقييد جذور الفحص + تدقيق) و**ع** (رفض setuid/setgid) و**س** (عزل بجذر تنفيذ إلزامي) — المتبقي: ن/ش/ف/ص/ض/طـ.
- 📋 الحالة التفصيلية (ما تم · ما لم يُراجع · المتبقي · التحسينات) في **`PLAN.md`**.

---

## 7. سورس النواة (Source Code) — `src/kernel/**`

> النواة (نواة P) كاملة كما في المستودع: 11 ملفاً · ~910 سطراً · TS صارم · بلا أي اعتماد خارجي.

### 7.1 `src/kernel/kernel.ts`

```ts
import { EventBus } from './core/event-bus';
import { Result, ok, err } from './core/result';
import { CommandRegistry } from './command-registry';
import { ServiceContainer } from './service-container';
import { Scheduler } from './scheduler';
import { ExtensionManager } from './extension-manager';

export interface KernelContext {
  events: EventBus;
  commands: CommandRegistry;
  services: ServiceContainer;
  scheduler: Scheduler;
  extensions: ExtensionManager;
}

export class Kernel {
  private events = new EventBus();
  private commands = new CommandRegistry();
  private services = new ServiceContainer();
  private scheduler = new Scheduler();
  private extensions = new ExtensionManager();
  private isReady = false;

  async boot(): Promise<Result<KernelContext, Error>> {
    if (this.isReady) {
      return ok(this.getContext());
    }

    try {
      this.isReady = true;
      this.events.emit('kernel:ready', { timestamp: Date.now() });

      return ok(this.getContext());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Kernel boot error: ${msg}`));
    }
  }

  async shutdown(): Promise<Result<void, Error>> {
    if (!this.isReady) return ok(undefined);

    try {
      this.events.emit('kernel:beforeShutdown', { timestamp: Date.now() });
      this.scheduler.cancelAll();
      const deactivateRes = await this.extensions.deactivateAll();

      this.isReady = false;
      this.events.emit('kernel:shutdown', {
        timestamp: Date.now(),
        hadErrors: deactivateRes.isErr,
      });

      if (deactivateRes.isErr) {
        return err(deactivateRes.error);
      }

      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Kernel shutdown error: ${msg}`));
    }
  }

  getContext(): KernelContext {
    return {
      events: this.events,
      commands: this.commands,
      services: this.services,
      scheduler: this.scheduler,
      extensions: this.extensions,
    };
  }
}
```

### 7.2 `src/kernel/core/result.ts`

```ts
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
```

### 7.3 `src/kernel/core/event-bus.ts`

```ts
import { Disposable } from './disposable';
import { EventName, EventHandler, SystemEvent } from './types';

export interface EventBusHandlerError {
  readonly eventName: EventName;
  readonly error: string;
  readonly timestamp: number;
}

export interface EventBusOptions {
  readonly onError?: (eventName: EventName, error: unknown, event: SystemEvent) => void;
  readonly maxHistory?: number;
}

export class EventBus {
  private handlers = new Map<EventName, Set<EventHandler>>();
  private history: SystemEvent[] = [];
  private handlerErrors: EventBusHandlerError[] = [];
  private eventCounter = 0;
  private readonly maxHistory: number;
  private readonly onError?: (eventName: EventName, error: unknown, event: SystemEvent) => void;

  constructor(options: EventBusOptions = {}) {
    this.maxHistory = options.maxHistory ?? 100;
    this.onError = options.onError;
  }

  emit<T>(name: EventName, payload: T): void {
    const event: SystemEvent<T> = {
      id: `${Date.now()}-${++this.eventCounter}`,
      name,
      payload,
      timestamp: Date.now(),
    };

    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    const set = this.handlers.get(name);
    if (set) {
      for (const handler of set) {
        try {
          handler(event);
        } catch (err: any) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.handlerErrors.push({
            eventName: name,
            error: errMsg,
            timestamp: Date.now(),
          });
          if (this.handlerErrors.length > this.maxHistory) {
            this.handlerErrors.shift();
          }
          if (this.onError) {
            try {
              this.onError(name, err, event);
            } catch (onErrorErr) {
              console.error(`[EventBus] onError handler itself threw for '${name}':`, onErrorErr);
            }
          } else {
            console.error(`[EventBus] Error in event handler for '${name}':`, err);
          }
        }
      }
    }
  }

  /**
   * الاشتراك في حدث مفروض الربط بمالك (DisposableStore أو مصفوفة Disposables) لمنع تسريب الذاكرة تلقائياً.
   */
  on<T>(
    name: EventName,
    handler: EventHandler<T>,
    owner: Disposable[] | { add(d: Disposable): Disposable }
  ): Disposable {
    if (!this.handlers.has(name)) {
      this.handlers.set(name, new Set());
    }
    const set = this.handlers.get(name)!;
    const genericHandler = handler as EventHandler<unknown>;
    set.add(genericHandler);

    const disposable: Disposable = {
      dispose: () => {
        set.delete(genericHandler);
        if (set.size === 0) {
          this.handlers.delete(name);
        }
      },
    };

    if (Array.isArray(owner)) {
      owner.push(disposable);
    } else if (typeof owner.add === 'function') {
      owner.add(disposable);
    }

    return disposable;
  }

  /**
   * ربط الاشتراك بمالك بشكل صريح عبر scopedOn.
   */
  scopedOn<T>(
    owner: Disposable[] | { add(d: Disposable): Disposable },
    name: EventName,
    handler: EventHandler<T>
  ): Disposable {
    return this.on(name, handler, owner);
  }

  recent(): ReadonlyArray<SystemEvent> {
    return [...this.history];
  }

  getHandlerErrors(): ReadonlyArray<EventBusHandlerError> {
    return [...this.handlerErrors];
  }

  clearHandlerErrors(): void {
    this.handlerErrors = [];
  }
}
```

### 7.4 `src/kernel/core/disposable.ts`

```ts
export interface Disposable {
  dispose(): void;
}

/**
 * دالة مساعدة لتحويل دالة التنظيف إلى كائن Disposable
 */
export function toDisposable(fn: () => void): Disposable {
  return { dispose: fn };
}

export class DisposableStore implements Disposable {
  private toDispose = new Set<Disposable>();
  private isDisposed = false;

  get disposed(): boolean {
    return this.isDisposed;
  }

  /**
   * إضافة كائن قابل للتخلص منه إلى المتجر مع ربط التنظيف التلقائي عند التخلص الفردي
   */
  add<T extends Disposable>(disposable: T): T {
    if (this.isDisposed) {
      disposable.dispose();
      return disposable;
    }

    const originalDispose = disposable.dispose.bind(disposable);
    let disposed = false;
    disposable.dispose = () => {
      if (disposed) return;
      disposed = true;
      this.toDispose.delete(disposable);
      originalDispose();
    };

    this.toDispose.add(disposable);
    return disposable;
  }

  /**
   * حذف كائن محدد من متجر التنظيف بدون استدعاء dispose() عليه
   */
  delete(disposable: Disposable): void {
    this.toDispose.delete(disposable);
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const item of this.toDispose) {
      try {
        item.dispose();
      } catch (e) {
        console.error('Error disposing resource:', e);
      }
    }
    this.toDispose.clear();
  }
}
```

### 7.5 `src/kernel/core/types.ts`

```ts
export type Id = string;

export type Priority = 'low' | 'normal' | 'high' | 'critical';

export const PRIORITY_WEIGHTS: Record<Priority, number> = {
  low: 0,
  normal: 10,
  high: 20,
  critical: 30,
};

export interface SystemEvent<T = unknown> {
  id: Id;
  name: string;
  payload: T;
  timestamp: number;
}

export type EventName = string;
export type EventHandler<T = unknown> = (event: SystemEvent<T>) => void;
```

### 7.6 `src/kernel/core/cache.ts`

```ts
export interface CacheOptions {
  maxSize?: number;
  defaultTtlMs?: number;
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number | null;
}

/**
 * High-performance, O(1) LRU Cache with TTL support.
 * Tailored for sub-10ms latency budgets in LLM prompt caching, tool outputs, and preloaded pattern lookups.
 */
export class LRUCache<K, V> {
  private maxSize: number;
  private defaultTtlMs: number | null;
  private cache = new Map<K, CacheEntry<V>>();

  private hits = 0;
  private misses = 0;

  constructor(options: CacheOptions = {}) {
    this.maxSize = options.maxSize && options.maxSize > 0 ? options.maxSize : 500;
    this.defaultTtlMs = options.defaultTtlMs && options.defaultTtlMs > 0 ? options.defaultTtlMs : null;
  }

  public get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return undefined;
    }

    // Refresh position in Map for LRU
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  public set(key: K, value: V, ttlMs?: number): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (first item in Map)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    const ttl = ttlMs ?? this.defaultTtlMs;
    const expiresAt = ttl ? Date.now() + ttl : null;
    this.cache.set(key, { value, expiresAt });
  }

  public has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  public delete(key: K): boolean {
    return this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  public size(): number {
    return this.cache.size;
  }

  public getMetrics(): { size: number; maxSize: number; hits: number; misses: number; hitRatio: number } {
    const total = this.hits + this.misses;
    const hitRatio = total > 0 ? this.hits / total : 0;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRatio: Number(hitRatio.toFixed(3))
    };
  }
}
```

### 7.7 `src/kernel/extension-manager.ts`

```ts
import { Result, ok, err } from './core/result';
import { LocalizedString } from './i18n/localized-string';

export interface Extension {
  id: string;
  name: LocalizedString;
  version: string;
  activate: () => Promise<void> | void;
  deactivate?: () => Promise<void> | void;
}

export class ExtensionManager {
  private activeExtensions = new Map<string, Extension>();

  async activate(extension: Extension): Promise<Result<void, Error>> {
    if (this.activeExtensions.has(extension.id)) {
      return ok(undefined);
    }

    try {
      await extension.activate();
      this.activeExtensions.set(extension.id, extension);
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Failed to activate extension ${extension.id}: ${msg}`));
    }
  }

  async deactivate(extensionId: string): Promise<Result<void, Error>> {
    const ext = this.activeExtensions.get(extensionId);
    if (!ext) {
      return ok(undefined);
    }

    try {
      if (ext.deactivate) {
        await ext.deactivate();
      }
      return ok(undefined);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Failed to deactivate extension ${extensionId}: ${msg}`));
    } finally {
      this.activeExtensions.delete(extensionId);
    }
  }

  async deactivateAll(): Promise<Result<void, Error>> {
    const activeList = Array.from(this.activeExtensions.values()).reverse();
    const errors: string[] = [];

    for (const ext of activeList) {
      const res = await this.deactivate(ext.id);
      if (res.isErr) {
        errors.push(res.error.message);
      }
    }

    if (errors.length > 0) {
      return err(new Error(`Errors during deactivateAll:\n${errors.join('\n')}`));
    }

    return ok(undefined);
  }

  get(extensionId: string): Extension | undefined {
    return this.activeExtensions.get(extensionId);
  }

  isActivated(extensionId: string): boolean {
    return this.activeExtensions.has(extensionId);
  }

  list(): Extension[] {
    return Array.from(this.activeExtensions.values());
  }

  getActiveCount(): number {
    return this.activeExtensions.size;
  }
}
```

### 7.8 `src/kernel/i18n/localized-string.ts`

```ts
export interface LocalizedString {
  ar: string;
  en: string;
}

export function localize(
  str: LocalizedString | string | null | undefined,
  lang: 'ar' | 'en' = 'ar'
): string {
  if (!str) return '';
  if (typeof str === 'string') return str;
  const primary = str[lang];
  if (primary && primary.trim() !== '') return primary;
  const fallbackAr = str.ar;
  if (fallbackAr && fallbackAr.trim() !== '') return fallbackAr;
  const fallbackEn = str.en;
  if (fallbackEn && fallbackEn.trim() !== '') return fallbackEn;
  return '';
}
```

### 7.9 `src/kernel/command-registry.ts`

```ts
import { Disposable } from './core/disposable';
import { Result, ok, err } from './core/result';
import { LocalizedString } from './i18n/localized-string';

export interface CommandDefinition<T = unknown> {
  id: string;
  title: LocalizedString;
  category?: LocalizedString;
  description?: LocalizedString;
  shortcut?: string;
  isEnabled?: (payload?: unknown) => boolean | Promise<boolean>;
  handler: (payload?: unknown) => Promise<T> | T;
}

export interface CommandExecutionRecord {
  id: string;
  timestamp: number;
  success: boolean;
  error?: string;
}

export class CommandRegistry {
  private commands = new Map<string, CommandDefinition>();
  private executionLog: CommandExecutionRecord[] = [];
  private readonly maxLogHistory = 200;

  /**
   * تسجيل أمر جديد في السجل مع دعم ربط التخلّص منه بمالك (DisposableStore/Array)
   */
  register<T>(
    def: CommandDefinition<T>,
    owner?: Disposable[] | { add(d: Disposable): Disposable }
  ): Disposable {
    if (this.commands.has(def.id)) {
      console.warn(`[CommandRegistry] Command '${def.id}' is being re-registered. Previous definition will be replaced.`);
    }
    const genericDef = def as CommandDefinition<unknown>;
    this.commands.set(def.id, genericDef);

    const disposable: Disposable = {
      dispose: () => {
        // حماية من التخلّص الخاطئ: لا نحذف إلا إذا كان هذا المرجع هو المسجل حالياً
        if (this.commands.get(def.id) === genericDef) {
          this.commands.delete(def.id);
        }
      },
    };

    if (owner) {
      if (Array.isArray(owner)) {
        owner.push(disposable);
      } else if (typeof owner.add === 'function') {
        owner.add(disposable);
      }
    }

    return disposable;
  }

  async execute<T>(id: string, payload?: unknown): Promise<Result<T, Error>> {
    const cmd = this.commands.get(id);
    if (!cmd) {
      const errorMsg = `Command '${id}' not found`;
      this.logExecution(id, false, errorMsg);
      return err(new Error(errorMsg));
    }

    if (cmd.isEnabled) {
      try {
        const enabled = await cmd.isEnabled(payload);
        if (!enabled) {
          const disabledMsg = `Command '${id}' is currently disabled`;
          this.logExecution(id, false, disabledMsg);
          return err(new Error(disabledMsg));
        }
      } catch (e) {
        const errStr = e instanceof Error ? e.message : String(e);
        const disabledErr = `Command '${id}' enablement check failed: ${errStr}`;
        this.logExecution(id, false, disabledErr);
        return err(new Error(disabledErr));
      }
    }

    try {
      const res = await cmd.handler(payload);
      this.logExecution(id, true);
      return ok(res as T);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.logExecution(id, false, errorMsg);
      return err(new Error(errorMsg));
    }
  }

  getCommand(id: string): CommandDefinition | undefined {
    return this.commands.get(id);
  }

  list(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  getLog(): ReadonlyArray<CommandExecutionRecord> {
    return [...this.executionLog];
  }

  clear(): void {
    this.commands.clear();
    this.executionLog = [];
  }

  private logExecution(id: string, success: boolean, error?: string) {
    this.executionLog.push({
      id,
      timestamp: Date.now(),
      success,
      error,
    });
    if (this.executionLog.length > this.maxLogHistory) {
      this.executionLog.shift();
    }
  }
}
```

### 7.10 `src/kernel/scheduler.ts`

```ts
import { Disposable } from './core/disposable';
import { Priority } from './core/types';

export interface Task {
  id: string;
  run: () => void | Promise<void>;
  priority?: Priority;
}

export class Scheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastExecuted = new Map<string, number>();
  private pendingTasks = new Map<string, Task>();

  /**
   * تأجيل تنفيذ المهمة حتى يتوقف استدعاؤها لمدّة ms (Debounce)
   */
  debounce(
    task: Task,
    ms: number,
    owner?: Disposable[] | { add(d: Disposable): Disposable }
  ): Disposable {
    const isNewRegistration = !this.timers.has(task.id) && !this.pendingTasks.has(task.id);

    if (this.timers.has(task.id)) {
      clearTimeout(this.timers.get(task.id)!);
    }

    this.pendingTasks.set(task.id, task);

    const timerId = setTimeout(() => {
      this.timers.delete(task.id);
      const latestTask = this.pendingTasks.get(task.id);
      this.pendingTasks.delete(task.id);
      if (latestTask) {
        this.executeTask(latestTask);
      }
    }, ms);

    this.timers.set(task.id, timerId);

    const disposable: Disposable = {
      dispose: () => {
        if (this.pendingTasks.get(task.id) === task) {
          this.pendingTasks.delete(task.id);
          if (this.timers.has(task.id)) {
            clearTimeout(this.timers.get(task.id)!);
            this.timers.delete(task.id);
          }
        }
      },
    };

    if (owner && isNewRegistration) {
      if (Array.isArray(owner)) {
        owner.push(disposable);
      } else if (typeof owner.add === 'function') {
        owner.add(disposable);
      }
    }

    return disposable;
  }

  /**
   * خنق استدعاء المهمة بحيث لا تُنفّذ أكثر من مرّة واحدة كل ms (Throttle) مع التنسيق بين المهام المتتالية
   */
  throttle(
    task: Task,
    ms: number,
    owner?: Disposable[] | { add(d: Disposable): Disposable }
  ): Disposable {
    const isNewRegistration = !this.timers.has(task.id) && !this.pendingTasks.has(task.id);
    const now = Date.now();
    const last = this.lastExecuted.get(task.id) ?? 0;
    const remaining = ms - (now - last);

    if (remaining <= 0) {
      if (this.timers.has(task.id)) {
        clearTimeout(this.timers.get(task.id)!);
        this.timers.delete(task.id);
      }
      this.pendingTasks.delete(task.id);
      this.lastExecuted.set(task.id, now);
      this.executeTask(task);
    } else {
      // دائماً نحفظ أحدث مهمة لتنفيذها عند انتهاء النافذة الزمنية
      this.pendingTasks.set(task.id, task);

      if (!this.timers.has(task.id)) {
        const timerId = setTimeout(() => {
          this.timers.delete(task.id);
          const latestTask = this.pendingTasks.get(task.id);
          this.pendingTasks.delete(task.id);
          this.lastExecuted.set(task.id, Date.now());
          if (latestTask) {
            this.executeTask(latestTask);
          }
        }, remaining);
        this.timers.set(task.id, timerId);
      }
    }

    const disposable: Disposable = {
      dispose: () => {
        if (this.pendingTasks.get(task.id) === task) {
          this.pendingTasks.delete(task.id);
          if (this.timers.has(task.id)) {
            clearTimeout(this.timers.get(task.id)!);
            this.timers.delete(task.id);
          }
        }
      },
    };

    if (owner && isNewRegistration) {
      if (Array.isArray(owner)) {
        owner.push(disposable);
      } else if (typeof owner.add === 'function') {
        owner.add(disposable);
      }
    }

    return disposable;
  }

  /**
   * إلغاء مؤقت مهمة محددة بمعرّفها
   */
  cancel(taskId: string): void {
    if (this.timers.has(taskId)) {
      clearTimeout(this.timers.get(taskId)!);
      this.timers.delete(taskId);
    }
    this.pendingTasks.delete(taskId);
  }

  /**
   * إلغاء جميع المؤقتات النشطة
   */
  cancelAll(): void {
    for (const timerId of this.timers.values()) {
      clearTimeout(timerId);
    }
    this.timers.clear();
    this.lastExecuted.clear();
    this.pendingTasks.clear();
  }

  /**
   * عدد المؤقتات النشطة حالياً
   */
  getActiveCount(): number {
    return this.timers.size;
  }

  private executeTask(task: Task): void {
    try {
      const result = task.run();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((e) => {
          console.error(`[Scheduler] Async error in task '${task.id}':`, e);
        });
      }
    } catch (e) {
      console.error(`[Scheduler] Synchronous error in task '${task.id}':`, e);
    }
  }
}
```

### 7.11 `src/kernel/service-container.ts`

```ts
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
```
