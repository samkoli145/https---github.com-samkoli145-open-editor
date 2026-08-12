# بنية النواة — الحالة الحالية (Architecture Snapshot)

> **وثيقة الحالة الجارية.** تُحدَّث مع كل تغيير هيكلي، ولا تحفظ التاريخ (التاريخ في `docs/changelog.md`). `PLAN.md` = مؤشر (index) فقط.
> آخر تحديث: جلسة §4-4 (اكتشاف سيرفرات LLM المحلية + دمجها في الإقلاع) — اقرأ من الأسفل إلى الأعلى (الحديث فوق).

## 1. التدرج الطبقي

```
النظام (system/)          → بنية تحتية: storage, vfs, engine, indexer
نواة P (kernel/)          → ميكانيكا: EventBus, CommandRegistry, Result, Scheduler
النواة العليا (agent-kernel/) → AIOS: LLMCore, ToolRegistry, Registry, Access, Quota, Session, Storage, AgentKernel
المستضيف (host/)          → إقلاع: bootloader, runtime, config, launcher, snowball, editor
طبقة HTTP (server.ts)     → نقاط REST + Web UI
```

كل طبقة لا تعرف ما فوقها (انضباط نادر الحفاظ عليه).

## 2. نواتان فقط (القاعدة العقدية)

| النواة | الموقع | الدور |
|---|---|---|
| نواة النظام P | `src/kernel/kernel.ts` | ميكانيكا عامة: أوامر/أحداث/خدمات/إضافات |
| النواة العليا | `src/agent-kernel/agent-kernel.ts` (`AgentKernel` — الطبقة الخامسة §8) | توزيع عمل الوكلاء عبر `executeSyscall` + إدارة محركات |

**الحالة الراهنة (بعد §4-0):** `bootloader.ts` يبني **مثيلاً حقيقياً** `new AgentKernel({ backends, tools, quota, sessions, storage })` + `boot()` + `attach(this._kernel)` — النواة العليا أصبحت فئة واحدة تُسجِّل أوامر `agent.*` (24 أمراً + scheduler.stats/llm.models/llm.health) في سجل نواة النظام بنفسها. `subsystems.agentKernel` هو المثيل نفسه (لا كائن تجميعي). معالج `agent.llm.chat` اليدوي في bootloader غلاف يتصل بـ`executeSyscall` ويعيد `{ output }`؛ `server.ts` يستخدم `runtime.agentKernel?.llm`. (تفاصيل §4-0 → docs/changelog.md)

## 3. النواة العليا (AgentKernel) — الطبقة الخامسة

- **مستقلة قائمة بذاتها**: تملك llm/tools/registry/quota/session/storage — ليست جزءاً من المستضيف ولا من نواة P.
- **بوابة الصلاحيات** `AccessManager`: `checkCommand`/`checkTool` → EPERM عند `deniedTools`/`deniedCommands`؛ إنكار تلقائي عند غياب السياسة.
- **المجدول** `AgentScheduler`: RR (افتراضي) / serial، `submit/awaitDone/stats`.
- **عقد الأوامر** `AGENT_KERNEL_COMMANDS` (12): registry/access/quota/session/storage/engine/kernel + llm/tool/scheduler/models/health.
- **مسار التنفيذ**: `executeSyscall` → أثر (ensureAgent) → بوابة الصلاحيات → مسار سريع (إدارة) أو مجدول (بيانات).
- **attach(kernel)** يسجّل أوامر `agent.*` في نواة P؛ **registerEngine** يدير محركات (هيرمس/سنجبول/محرر/لانشر) كوحدات داخلية.
- `LLMCore` أُضيف له `availableModels()`/`health()` (إضافي آمن، لم يمس `mcp-*`).
- `OllamaBackend` (بعد §4-3): يتصل فعلياً عبر `fetch` إلى `POST {baseUrl}/api/chat` (`{model, messages, stream:false}`) مع `AbortController` مهلة 10s؛ المحاكاة fallback فقط عند فشل الاتصال، و`simulateOnFailure:false` يجعلها حتمية. `fetchImpl` لحقن fetch في الاختبار.
- `discoverLocalLLMServers` (بعد §4-4): مسح شامل للمضيفين (`127.0.0.1`/`localhost`) × المنافذ النموذجية (`DEFAULT_LLM_SERVER_PORTS` — Ollama 11434 · LM Studio 1234 · llama.cpp 8080 · vLLM 8000 · Jan 1337 · KoboldCpp 5001 · text-generation-webui 7860 · 3001) بترتيب بروتوكول: Ollama الأصلية (`/api/version` ثم `/api/tags`) ثم OpenAI-المتوافقة (`/v1/models` ثم `/models` على 404)؛ استدلال البائع من البروتوكول أو `vendorForPort`؛ مهلة 800ms + إجهاض AbortController + `concurrency` 8 + `fetchImpl`؛ أي فشل فردي يُتجاوز. المصدر: `src/agent-kernel/local-server-discovery.ts`.
- **دمج الإقلاع** (بعد §4-4): `bootloader` عند `enableLLMDiscovery` (خيار/ملف إعداد/`NAWAT_LLM_DISCOVERY=1`) يكتشف قبل بناء `AgentKernel` ويمرّر `backends = [DeterministicBackend, ...backendsFromDiscoveredServers(infos)]` → `availableModels()` يظهر نماذج حية (`ollama@11434 → qwen2.5:0.5b`)؛ افتراضي false حفظاً لميزانية `boot<500ms`؛ `bootloader.discoveredLLMServers` يعرض السيرفرات.

## 4. الأمان — بوابات LinuxArchExecutionLayer (دفاع متعدد الطبقات)

`src/agent-kernel/linux-arch-execution-layer.ts`:
1. **قيود** (ConstraintEngine): rm -rf، mkfs، dd، poweroff، sudo/su/chroot، pacman -R، chown root.
2. **allowlist** للأسماء البسيطة (`allowedBinaries.includes(toolName)`).
3. **حصص** (quota): trackSyscall لكل وكيل.
4. **جذر تنفيذ إلزامي** (`enforceExecRoot` افتراضي): cwd خارج الجذر → رفض؛ أهداف مطلقة خارج الجذر → `ESECURITY`.
5. **عزل الأهداف** (`isolateAbsoluteTargets`): المطلق + هروب نسبي `..` عبر `resolve(cwd, target)`.
6. **TOCTOU**: إعادة `realpathSync`+`stat` فوراً قبل spawn.
7. **رفض setuid/setgid** (`0o6000`).
8. **توقيع ELF** (e_ident/e_type + SHA-256 `authorizedSignatures`).

> ~~⚠️ **ثغرة مفتوحة [CVE-internal] §5-0**: المسار الحاوي على `/` يتجاوز allowlist ويُقبل بفحص ELF فقط — `binaryPath` اعتباطي من `/api/launcher/*` (افتراضي `/bin/bash`).~~ **✅ عولج (2026-08-12)**: دفاع ثلاثي — بوابة `ProcessLauncher` (allowlist `LAUNCHER_ALLOWED_BINARIES` + حظر المفسِّرات) + `FORBIDDEN_GENERAL_INTERPRETERS` في الطبقة الأرشية (basename المسار المطلق) + إزالة `/bin/bash` واستيفاء `resolveProgramBinary` من الكتالوج. `tests/lolbin-hardening.test.ts` (9/9).

## 5. المصادقة والتدقيق (REST)

- `X-API-Key` إلزامي لكل `/api` (عدا `/api/health`) — يُولَّد عشوائياً (`randomBytes(24)`) عند غياب `NAWAT_API_KEY` ويُطبع عند الإقلاع؛ افتراضي الربط `127.0.0.1` (تجاوز `NAWAT_HOST` للشبكة) (§5-غ).
- مقارنة المفتاح **ثابتة الزمن** عبر `crypto.timingSafeEqual` (§5-ي).
- تدقيق إلزامي في `/api/audit`: `arch.execute` · `hermes.chat.completions`/`hermes.train` · `projects.scan`/`projects.scan.denied` · `launcher.launch`/`embed`/`stop` · `commands.register` · `extensions.activate`/`deactivate` · `events.emit` (§5-ي).

## 6. المكونات المترابطة

| الوحدة | الموقع | الحالة |
|---|---|---|
| هيرمس | `host/bootloader.ts` (HermesKernel) | **مربوطة** فعلياً (serve/learn/chat) |
| العقل الموجّه | `host/editor-manager.ts` + `host/lsp-adapter.ts` | **مربوطة** (اكتشاف 12 أداة + LSP) |
| كرة الثلج | `host/snowball/` | **مربوطة** (مسارات §7-1 عولجت) |
| اللانشر | `host/launcher/` | منقولة كما هي، معالجة مؤجلة §7 (ثغرة §5-0 أعلاه) |

## 7. التحقق

- `tsc --noEmit` نظيف · `npm test` **331/332** (الفاشل الوحيد بيئي: Firefox في `launch-desktop-command`).
- `tests/agent-kernel-upper.test.ts` — 17/17 · `tests/lolbin-hardening.test.ts` — 9/9 · `tests/ollama-protocol.test.ts` — 5/5 · `tests/local-server-discovery.test.ts` — 11/11 · `tests/llm-discovery-boot.test.ts` — 4/4 · `tests/math-eval.test.ts` — 4/4 · `tests/finalize-5.test.ts` — 9/9 · `tests/host.test.ts` — 31/31 · `tests/system.test.ts` — 21/21.
- **تجربة حية (§3-65 أُغلقت):** Ollama **0.32.1** على `127.0.0.1:11434` — الاكتشاف رصد السيرفر في **71ms** (17 نموذجاً عبر `/api/version`+`/api/tags`)، ومحادثة `POST /api/chat` حقيقية عبر `OllamaBackend` (qwen2.5:0.5b) ردّت في **5.1s** بusage فعلي.
- **قيود بيئة التشغيل**: `bun test` يُسقط بتّات setuid (bun يُقنع `0o777`) — المرجع المعتمد **node/vitest** عبر `npm test`.
