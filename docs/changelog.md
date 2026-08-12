# سجل التغييرات (Changelog)

> **تراكمي، لا يُعاد كتابته.** الأحدث أولاً. `PLAN.md` = مؤشر (index) + §8 سجل تجربة الطبقة الخامسة. الحالة الجارية في `docs/architecture.md`.
> بدأ النقل من أحدث نقطة زمنية (§6 في PLAN.md) دون إعادة كتابة التاريخ الأقدم.

## 2026-08-12 — §5-ح + §5-ك + §5-طـ + §5-ب + §5-د (إغلاق جدول التحسينات §5 بالكامل)

**ما أُنجز:**
- **§5-ح — لا ابتلاع صامت لأخطاء المستمعين:** `SessionInstance` يستقبل `EventBus` (يُمرَّر من `SessionManager`) ويُصدر `session:stream:error` عند رمي أي مستمع في `emitStream` — الخطأ مرئي عبر الناقل بدل `// Safe listener logging`، ومستمع خاطئ لا يُسقط البث عن بقية المستمعين.
- **§5-ك — عدّاد توكنات معياري قابل للحقن:** `TokenCounter` + `DEFAULT_TOKEN_COUNTER` (كلمات + نصف علامات الترقيم — تقدير أوضح من `length/4`)، يُحقن عبر `ContextWindowOptions.tokenCounter` أو `setTokenCounter`، و`estimateTokens` يستخدمه.
- **§5-طـ — الفهرس يتتبع السيملينك:** `VFSFileIndexEntry.linkTarget` + معامل `linkTarget` لـ`registerFile` يرفض `ESECURITY` عند هروب الهدف (مطلق، أو نسبي عبر `..` يُحلّ نسبةً لمسير الرابط) خارج جذر الفهرس، ويسجّل الهدف؛ `resolveLinkTarget` يسترجعه؛ الهدف يُحفظ ويُستعاد عبر snapshot.
- **§5-ب — كمون إشارة مُقاس لا ثابت:** `signalingLatencyMs` تُحسب بـ`performance.now` حول `commands.execute` في `executeSyscall` بدل القيمة الجاهزة 0.8.
- **§5-د — كتابة مفتاح واحدة:** `SafeStorageEngine.save` يخزّن المفتاح المُنقّى فقط (لم يعد نسختين خام + مُنقّى)؛ `exists`/`load`/`delete` تعمل على المفتاح المُنقّى وحده.

**التحقق:** tsc نظيف · `npm test` **331/332** (الوحيد الفاشل بيئي Firefox — بصمة §5-0) · `tests/finalize-5.test.ts` **9/9** · `tests/host.test.ts` **31/31** · `tests/system.test.ts` **21/21** · `tests/architecture-enhancements.test.ts` **10/10** (مُحدَّث للمفتاح المُنقّى).

**الملفات:** `src/agent-kernel/session.ts` · `src/agent-kernel/intelligence/context-model.ts` · `src/system/vfs/persistent-indexer.ts` · `src/host/runtime.ts` · `src/system/storage.ts` · `tests/finalize-5.test.ts` (جديد) · `tests/host.test.ts` · `tests/system.test.ts` · `tests/architecture-enhancements.test.ts`.

## 2026-08-12 — §5-ز + §5-م + §5-ط (إزالة eval والرسائل الجاهزة والاعتماد البائد)

**ما أُنجز:**
- **§5-ز — محلِّل حسابي خاص بلا eval:** `src/agent-kernel/math-eval.ts` (recursive descent) حلّ محل `new Function` في أداة `calc` (`tools.ts`). يدعم رُكام `+ -` ومعاملات `* /` وعوامل `( )` وأرقام عشرية وعلامات أحادية، ويرمي أخطاء بنية بأسباب واضحة (رمز غير مسموح · رقم غير صالح · القسمة على صفر · رموز زائدة · تعبير غير متوقع). مُصدَّر من `agent-kernel/index.ts`.
- **§5-م — `ExecutionSandboxEngine` ينفّذ فعلياً:** `execute` لم يعد رسالة `[SANDBOX_EXEC]` جاهزة — يُوجَّه إلى `LinuxArchExecutionLayer` (بوابات allowlist → حصص → عزل أهداف → جذر تنفيذ → ELF/shebang → TOCTOU) بعد بوابة `verifyExecutionRights` الحتمية (sanitize + فهرس + بت POSIX + ملكية UID/GID). `execLayer`/`execRoot` قابلان للحقن؛ افتراضياً تُبنى طبقة `LinuxArchExecutionLayer` بجذر عمل الخادم (`sandbox`) وتُغذّى من allowlist المحرك. نتائج الطبقة تُعرض على `ExecutionResult` (exitCode/stdout/stderr/durationMs)، وأخطاء blocked/not_found/timeout تُترجم إلى `ESECURITY`/`ENOENT`/`ETIMEDOUT`.
- **§5-ط — حذف الاعتماد البائد:** `@google/genai` أُزيل من dependencies (`npm uninstall`) — المشروع محلي بلا سحابة ولا مراجع له في src/server/tests.

**التحقق:** tsc نظيف · `npm test` **320/321** (الوحيد الفاشل بيئي Firefox — بصمة §5-0) · `tests/math-eval.test.ts` **4/4** (أسبقية/أقواس/كسور/علامات أحادية · رفض `process.exit()`/`2..3`/`1/0`/القسمة على صفر · calc عبر النواة `(10+20)*3` = 90) · `system.test.ts` **20/20** (سكربت node حقيقي `#!/usr/bin/env node` يُنفَّذ عبر الطبقة داخل جذر مؤقت: exitCode=0 وstdout=`inode_ok` · ملف `0o600` → EPERM قبل أي spawn).

**الملفات:** `src/agent-kernel/math-eval.ts` (جديد) · `src/agent-kernel/tools.ts` · `src/agent-kernel/index.ts` · `src/system/engine/execution-sandbox.ts` · `tests/math-eval.test.ts` (جديد) · `tests/system.test.ts` · `package.json`.

## 2026-08-12 — §5-ي تحصين أمان REST (تسجيل أوامر/إضافات + مقارنة مفتاح ثابتة الزمن)

**ما أُنجز:**
- **مقارنة ثابتة الزمن** لمفتاح `X-API-Key`: استُبدل `req.headers['x-api-key'] !== API_KEY` بـ`crypto.timingSafeEqual` (طول غير متطابق يُرفض قبل المقارنة) — إغلاق هجوم توقيت على المصادقة الإلزامية لكل `/api`.
- **تدقيق إلزامي** للمسارات الحساسة التي كانت صامتة (تُسجَّل الآن في `/api/audit`): `commands.register` · `extensions.activate` · `extensions.deactivate` · `events.emit`.
- الاستمرار: §5-غ سبق أن فرض `X-API-Key` على كل `/api` (عدا `/api/health`) + افتراضي `127.0.0.1` (تجاوز `NAWAT_HOST` فقط للشبكة).

**التحقق:** tsc نظيف · `npm test` **316/317** (الوحيد الفاشل بيئي Firefox — بصمة §5-0) · blackbox **24/24** (ضمنها اختبارا §5-ي: `/api/commands/register` بلا مفتاح → 401 · register/activate/emit تُسجَّل في `/api/audit`).

**الملفات:** `server.ts` · `tests/e2e-blackbox.test.ts`.

## 2026-08-12 — §4-4 دمج الاكتشاف في إقلاع النواة (bootloader → AgentKernel → نماذج حية)

**ما أُنجز:**
- `backendsFromDiscoveredServers(infos)` في `llm-core.ts`: يحوّل سيرفرات Ollama المكتشفة إلى خلفيات `OllamaBackend` (`name: ollama@<port>`، `model:` أول نموذج معلن) — السيرفرات OpenAI-المتوافقة الأخرى تُكتشف وتُعرض بلا خلفية حتى تُنفَّذ واجهتها.
- `bootloader.ts`: عند تفعيل الاكتشاف (`BootOptions.enableLLMDiscovery` أو `enableLLMDiscovery` في ملف الإعداد) يجري `discoverLocalLLMServers` **قبل** بناء `AgentKernel` ويمرّر `backends = [DeterministicBackend, ...المكتشفة]` — الخلفية الحتمية أولاً فتبقى الردود مستقرة بلا شبكة؛ فشل الاكتشاف لا يُسقط الإقلاع (best-effort). `bootloader.discoveredLLMServers` يعرض السيرفرات المكتشفة.
- افتراضي **false** في كل البروفايلات (حفظاً لعقد أداء `boot < 500ms` في `host.test.ts` و10 دورات Memory Safety) — مفعّل عبر خيار صريح أو `NAWAT_LLM_DISCOVERY=1` عند تشغيل `server.ts`.
- `profiles.ts`/`config-loader.ts`: حقل `enableLLMDiscovery` معتمد ومُحلَّل.

**التحقق:** tsc نظيف · `npm test` **314/315** (الوحيد الفاشل بيئي Firefox — بصمة §5-0) · `tests/llm-discovery-boot.test.ts` **4/4** (تفعيل→خلفية حية في `availableModels` · غياب سيرفر→لا خلفية وإقلاع سليم · الافتراضي بلا شبكة · ملف الإعداد `enableLLMDiscovery` معتمد) · **تجربة حية**: إقلاع `agent`+اكتشاف ضد Ollama **0.32.1** → **77ms** · `availableModels = [deterministic, ollama@11434→qwen2.5:0.5b]` · shutdown نظيف.

**الملفات:** `src/agent-kernel/llm-core.ts` · `src/agent-kernel/index.ts` · `src/host/bootloader.ts` · `src/host/profiles.ts` · `src/host/config-loader.ts` · `server.ts` · `tests/llm-discovery-boot.test.ts`.

## 2026-08-12 — §4-4 اكتشاف شامل لسيرفرات LLM المحلية عبر المنافذ (الشروط النموذجية)

**ما أُنجز:** وحدة `local-server-discovery.ts` لمسح شامل للمنافذ المعروفة دون اعتماد خارجي:

- **التجربة الحية (إغلاق §3-65):** Ollama **0.32.1** يعمل على `127.0.0.1:11434` — `discoverLocalLLMServers` رصد السيرفر خلال **71ms** (17 نموذجاً: qwen2.5:0.5b، gemma3:12b… عبر `/api/version`+`/api/tags`)، و`OllamaBackend` (qwen2.5:0.5b، `simulateOnFailure:false`) أجرى محادثة حقيقية `POST /api/chat` → رد فعلي في **5.1s** بusage حقيقي.

- **المضيفون الافتراضي:** `127.0.0.1` ثم `localhost`.
- **المنافذ النموذجية** (`DEFAULT_LLM_SERVER_PORTS`): Ollama 11434 · LM Studio 1234 · llama.cpp 8080 · vLLM 8000 · Jan 1337 · KoboldCpp 5001 · text-generation-webui 7860 · LM Studio القديم 3001.
- **ترتيب بروتوكول ذكي:** بروتوكول Ollama الأصلي (`/api/version` → إصدار، ثم `/api/tags` → نماذج `models[].name`) قبل واجهة OpenAI-المتوافقة (`/v1/models` ثم `/models` كبديل على 404) — نفس فكرة Atomic-Chat (`get_local_http`) لكن fetch محقون وبدون Tauri.
- **استدلال البائع:** من البروتوكول المكتشف أو من المنفذ (`vendorForPort`: 11434→ollama · 1234→lm-studio · 8080→llamacpp · 8000→vllm · 1337→jan · غيرها→openai-compatible).
- **شروط متانة:** مهلة `timeoutMs` (افتراضي 800ms) مع إجهاض AbortController · `concurrency` (افتراضي 8) بدل تسلسلي · أي فشل فردي (ECONNREFUSED/غير-JSON/مهلة) يُتجاوز دون إسقاط الفحص · النتائج مرتبة حسب المنفذ · `fetchImpl` للحقن في الاختبار.

**التحقق:** tsc نظيف · `npm test` **310/311** (الوحيد الفاشل بيئي Firefox — بصمة §5-0) · `tests/local-server-discovery.test.ts` **11/11** (الشروط النموذجية مصدَّرة · خريطة المنافذ · Ollama عبر /api/version+/api/tags · Ollama عند تعطل /api/version · LM Studio عبر /v1/models · بديل /models على 404 · استدلال المنفذ · تخطي ECONNREFUSED · تخطي HTML غير-JSON · مهلة الإجهاض لا تعلّق · رصد منافذ متعددة مرتبة).

**الملفات:** `src/agent-kernel/local-server-discovery.ts` · `src/agent-kernel/index.ts` (تصدير) · `tests/local-server-discovery.test.ts`.

## 2026-08-12 — §4-3 Ollama حقيقي (بروتوكول fetch فعلي بدل محاكاة)

**ما أُنجز:**
- `OllamaBackend.chat` يرسل `POST {baseUrl}/api/chat` حقيقياً بجسم بروتوكول ollama (`{model, messages, stream:false}`) عبر `fetch`، مع `AbortController` لإجهاض الطلب بعد مهلة افتراضية 10s (`timeoutMs`).
- المحاكاة أصبحت **fallback فقط** عند فشل الاتصال (شبكة/مهلة/غياب fetch) — الاختبارات المحلية بلا Ollama تبقى تعمل.
- `simulateOnFailure: false` يجعل الاتصال حتمياً: يعيد الخطأ الأصلي (ECONNREFUSED…) أو يرمي `Ollama HTTP <status>` عند رد غير ناجح.
- استهلاك الرد الفعلي: `data.message.content`/`data.model`/`data.done_reason`/`prompt_eval_count`/`eval_count` تُملأ في `LLMReply`.
- خيار `fetchImpl` لحقن fetch (اختبار البروتوكول دون اعتماد خارجي).

**التحقق:** tsc نظيف · `npm test` **299/300** (الوحيد الفاشل بيئي Firefox — بصمة §5-0) · `tests/ollama-protocol.test.ts` 5/5 · `agent-kernel.test.ts` 15/15.

**الملفات:** `src/agent-kernel/llm-core.ts` · `tests/ollama-protocol.test.ts`.

## 2026-08-12 — §4-0 ربط المستضيف بالنواة العليا الفعلية `new AgentKernel(...)`

**ما أُنجز:** استُبدل الكائن التجميعي `subsystems.agentKernel` في `bootloader.ts` (كان يجمّع `llmCore`/`llm`/`chat`/`tools`/`sessionMgr`/`quotaGuard` يدوياً) بمثيل حقيقي للفئة `AgentKernel`:

1. `new AgentKernel({ backends: [DeterministicBackend], tools, quota, sessions, storage })` — الخيارات `tools` (موصولة بسجل أوامر النواة) و`quota`/`sessions` (مربوطة بالحصص) صارت تُمرَّر للفئة بدل إعادة بناءها كحقول مجمّعة.
2. `await agentKernel.boot()` ثم `agentKernel.attach(this._kernel)` — النواة العليا الآن **فئة واحدة** تُسجِّل أوامر `agent.*` (24 أمراً من `AGENT_KERNEL_COMMANDS` + `agent.scheduler.stats`/`agent.llm.models`/`agent.llm.health`) في سجل نواة النظام بنفسها، فلا ازدواجية بنية/اسم.
3. معالج `agent.llm.chat` اليدوي في bootloader صار غلافاً يتصل بـ`executeSyscall('agent.llm.chat', { messages })` ويعيد `{ output }` (حفاظاً على عقد `runtime.executeCommand`/`executeSyscall` والاختبارات).
4. `server.ts:429` انتقل من `runtime.agentKernel?.llmCore` إلى `runtime.agentKernel?.llm` (الحقل الفعلي).
5. `tests/host.test.ts` حُدِّث: `chat('agent-1', [{role:'user',content:'hello-agent'}])` بتوقيع النواة الحقيقية.

**التحقق:** tsc نظيف · `npm test` **294/295** (الفاشل الوحيد بيئي Firefox — بصمة §5-0) · `host.test.ts` 30/30 (أهمها: `agentKernel` مثيل حقيقي chat عبر LLMCore · attach يسجّل أوامر agent.* · headless → ENOSYS) · `agent-kernel-upper.test.ts` 17/17.

**الملفات:** `src/host/bootloader.ts` · `server.ts` · `tests/host.test.ts`.

## 2026-08-12 — إصلاح CVE-internal §5-0 (LOLBin / binaryPath اعتباطي)

**الثغرة المؤكَّدة تجريبياً:** `binaryPath=node -e ...` عبر `/api/launcher/launch` كان يُنفَّذ (pid حقيقي) لأن الاسم المجرد `node`/`python3` في `DEFAULT_ALLOWED_BINARIES` كاستخدام أرشي شرعي — فيصبح مُطلِقاً حراً من العميل خلف مفتاح API فقط (فئة LOLBins). كما أن الافتراضي الخطير `/bin/bash` كان في قائمة البرامج ومسارَي الإطلاق.

**الإصلاح (دفاع ثلاثي):**
1. **بوابة `ProcessLauncher.validateCommand`** — allowlist صريح `LAUNCHER_ALLOWED_BINARIES` بأسماء الملفات النهائية + حظر المفسِّرات العامة، على كل إطلاق بغضّ عن الشكل (مسار/مجرد).
2. **`LinuxArchExecutionLayer`** — `FORBIDDEN_GENERAL_INTERPRETERS` تُفحص على basename المسار المطلق داخل الجذر (حتى ELF سليم مرفوض)، مع بقاء سكربتات shebang العادية تعمل.
3. **الخادم** — حُذف `/bin/bash` من البرامج الافتراضية ومسارَي launch/embed؛ `resolveProgramBinary(programId)` يستوفي من الكتالوج أو يرفض.

**التحقق:** `tests/lolbin-hardening.test.ts` (9/9) · tsc نظيف · `npm test` **295/296** (الفاشل الوحيد بيئي Firefox).

**الملفات:** `src/agent-kernel/linux-arch-execution-layer.ts` · `src/host/launcher/process-launcher.ts` · `src/host/launcher/launcher-manager.ts` · `server.ts` · `tests/lolbin-hardening.test.ts`.

## 2026-08-12 — النواة العليا المستقلة (AgentKernel) — الطبقة الخامسة (تجربة §8)

**ما أُنجز:**
- `AccessManager` (بوابة صلاحيات: checkCommand/checkTool + EPERM على deniedTools/deniedCommands + إنكار تلقائي عند غياب السياسة).
- `AgentScheduler` (RR افتراضي / serial، submit/awaitDone/stats).
- `AgentKernel` فئة مستقلة قائمة بذاتها (llm/tools/registry/quota/session/storage + registerEngine) مع عقد `AGENT_KERNEL_COMMANDS` (12 أمراً) — `executeSyscall` يمر عبر بوابة الصلاحيات ثم مسار سريع (إدارة) أو مجدول (بيانات).
- `attach(kernel)` يسجّل أوامر `agent.*` في نواة النظام P.
- إضافات آمنة لـ`LLMCore`: `availableModels()`/`health()`.
- لا مساس بمصدر `mcp-*` ولا بمكونات الطبقات السابقة.

**التحقق:** `tsc --noEmit` نظيف · `npm test` **286/287** (الفاشل الوحيد بيئي: Firefox) · `tests/agent-kernel-upper.test.ts` 17/17.

**الملفات:** `src/agent-kernel/access.ts` · `src/agent-kernel/scheduler.ts` · `src/agent-kernel/agent-kernel.ts` · `tests/agent-kernel-upper.test.ts` · تعديلات طفيفة `index.ts`/`llm-core.ts`.

## السجل الأقدم (قبل نقل الفصل)

راجع `PLAN.md` §6 (خط الإنجاز) للجلسات السابقة: العقل الموجّه (Orchestrator) · نقل النسخة التجريبية · معالجة §7-1 (سنجبول) · اعتماد نسخة archive · تحصينات LinuxArchExecutionLayer · ربط هيرمس/النواة العلويّة.
