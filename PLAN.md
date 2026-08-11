# خطة وحالة مشروع النواة (Nawat Kernel)

> **ملف الحالة المرجعي.** الخريطة التفصيلية + سورس النواة في `kernel.md`. هذا الملف: الهيكل المؤكَّد، ما تم، ما لم يُراجع بعد، المتبقي، والتحسينات المقترحة.

---

## 1. الخرائط والهيكل (Maps & Structure)

| الوثيقة | المحتوى |
|---|---|
| `kernel.md` | خريطة المشروع الكاملة (رؤية · مطلوب · مستهدف · شجرة · نمو) + **سورس النواة كاملاً** (11 ملفاً بـ`src/kernel/**` تحقّق آلي من مطابقتها) |
| `PLAN.md` | **هذا الملف** — حالة التنفيذ والمراجعة والمتبقي والتحسينات |

**الهيكل الفعلي المؤكَّد (قياس مباشر):**

```
src/  (55 ملفاً TS · 4845 سطراً)
├── kernel/        نواة P: 11 ملفاً / ~910 سطراً (kernel · core/{result,event-bus,disposable,types,cache} ·
│                    i18n · service-container · command-registry · scheduler · extension-manager)
├── host/          المستضيف: 6 ملفات / 608 سطراً (bootloader · runtime · profiles · vfs · config-loader)
├── agent-kernel/  النواة العليا: 30 ملفاً (llm-core · syscalls · tools · registry · quota · session ·
│                    storage · linux-arch-execution-layer) + hermes/ (7/489) + intelligence/ (5/343) +
│                    logic/ (9/334)
└── system/        النظام: 7 ملفات / 143 سطراً + engine/ (2/164) + vfs/ (3/405)

bin/nawat.ts (71) · server.ts (1121) · tests/ (13 ملفات · 226 اختباراً)
```

**الحالة المثبتة اليوم (آخر تحقق):**
- `bun install` ناجح · `tsc --noEmit` **نظيف** · `bun run build` **نظيف** (dist/server.cjs 67KB) · **226/226 اختباراً أخضر** (13 ملفات، ~2.3s).

---

## 2. ما تم (Done — مُثبَت)

| # | البند | الدليل |
|---|---|---|
| 1 | نواة P كاملة بلا اعتماد خارجي | `kernel.test.ts` (39) |
| 2 | مستضيف إقلاع: `bootNawat` + 4 أنماط + آلة حالة صارمة + VFS + تحميل إعداد | `host.test.ts` (19) |
| 3 | نواة عليا: llm-core (3 خلفيات) · syscalls (4 طوابير) · tools (3 أدوات + صلاحيات) · registry · quota · session · storage | `agent-kernel.test.ts` (16) + `architecture-enhancements.test.ts` (10) |
| 4 | هيرمس: SymbolicLoop · teaching-bridge (إديمبوتنسي + حدود سعة) · personas (3) · save/load عبر storage | `hermes.test.ts` (9) |
| 5 | العقل: constraint-engine (regex/DENY_TOOL/نص) · inference · context · decision (النواهي قبل الأوامر) | `intelligence.test.ts` (8) |
| 6 | المنطق: kernel-forge (3 نطاقات) · compiler · retro-extractor (حصاد) · program-distiller | `logic.test.ts` (12) |
| 7 | النظام: path-sanitizer · file-type-detector · persistent-indexer · base-engine · execution-sandbox · storage آمن (checksum FNV-1a + كتابة ذرّية) | `system.test.ts` (15) |
| 8 | مرونة/ضغط | `stress.test.ts` (3) |
| 9 | CLI `bin/nawat.ts` (boot/status/profiles) + خادم Express بواجهة لوحة تحكم RTL (`server.ts`) | `tsc`/`build` نظيفان |
| 10 | `kernel.md` محدَّث للهيكل الجديد وسورس النواة مطابق (11/11 ملفاً) | تحقّق آلي |
| 11 | **طبقة تنفيذ أرش** `LinuxArchExecutionLayer` — تنفيذ حقيقي `execFile` بلا shell ببوابات إلزامية: code-domain (قواعد أرش: `rm -rf`/`mkfs`/`dd`/`poweroff`/`sudo`/`pacman -R`…) → allowlist (70+ أداة) → quota (معدل/زمن/أخطاء) → جذر تنفيذ realpath (ضد هروب symlink خارج الشجرة) → ELF (توقيع + بت تنفيذ + **فحص عميق e_ident/e_type**) / سكربتات shebang (المفسّر من allowlist) / رفض الثنائيات المجهولة والملفات غير العادية + **إعادة تحقق TOCTOU قبل spawn + بصمات SHA-256 مخوّلة** | `linux-arch-execution-layer.test.ts` (55) |
| 12 | كشف الملفات المجهولة: shebang يكشف المفسّر واللغة (امتداد/نوع مجهولان) + الثنائيات المجهولة `bin/octet-stream` بدل تصنيفها نصاً + `inspectElfHeader` (e_ident class/endian/version + e_type؛ يرحب بـET_EXEC/ET_DYN فقط) | `system.test.ts` (23) |
| 13 | **ماسح المشروع الخارجي** `scanProject` — عند فحص مجلد مشروع من الخارج يكشف: ملفات مخفية (نقطية + أسماء Unicode خفية) · قابلة للتنفيذ (ELF/skriptات shebang) · backdoor (setuid/setgid + غير-عادية) · روابط رمزية خارجة عن الشجرة (هروب) · مزروعة (غير مسجّلة) / معبث بها (checksum SHA-256) / مفقودة مقابل `PersistentIndexer` — مدمج REST `/api/projects/scan` + تبويب لوحة | `project-scanner.test.ts` (6) |

---

## 3. لم يُراجع بعد (Not yet fully reviewed)

| المنطقة | الملفات | درجة المراجعة |
|---|---|---|
| أجسام ملفات الاختبار | `tests/*.test.ts` (13) | راجعت الأعداد فقط، لا تفاصيل الحالات — عدا `e2e-server`/`nawat-cli` (مكتوبان هذه الجلسة) |
| منطق التقطير | `logic/program-distiller.ts` (47) | لم يُراجع بالكامل |
| بروفايلات النطاقات | `logic/domains/code/reasoning/scraping-domain.ts` (3) | لم تُراجع (الـ index/forge/compiler/retro نعم) |
| الفهرسة الدائمة | `system/vfs/persistent-indexer.ts` (325) + `file-type-detector.ts` (85) | indexer: روجعت بالكامل — حفظ/تحميل ذرّي حقيقي + SHA-256 (ص/ف تمّا) · detector: قراءة موحّدة 512 بايت + `inspectElfHeader` (ض/ش تمّا) |
| اختبار الضغط | `stress.test.ts` (143) | لم يُراجع محتواه |
| تشغيل فعلي للخادم | `server.ts` | ✅ **تم آلياً** — `e2e-server.test.ts` (15) يُقلع الخادم في عملية فرعية ويختبر HTTP: مصادقة/أوامر/أرش/هيرمس/فحص/تدقيق |
| تشغيل فعلي للـCLI | `bin/nawat.ts` | ✅ **تم آلياً** — `nawat-cli.test.ts` (4): help/--help/-h/profiles/status |
| LLM حقيقي | `OllamaBackend` | لا يوجد نموذج محلي؛ الاختبار الحقيقي معلّق |

---

## 4. المتبقي (Remaining)

1. ~~**ربط حقيقي للنواة العليا/هيرمس في المستضيف** — `bootloader.initializeKernel` يبني حالياً «أشباحاً» (stubs) لـ`agentKernel`/`hermes`/`editor` بدل ربط `HermesKernel`/`AgentKernel` الحقيقية (راجع §5-أ).~~ **تم** — ربط `HermesKernel` + نواة وكيل حقيقية (LLMCore/ToolRegistry/SessionManager) في `initializeKernel` (§5-أ).
2. ~~**VFS وظيفية في المستضيف** — `host/vfs.ts` mount/dispose فقط؛ VFS الحقيقية في `system/vfs` غير موصولة.~~ **تم** — `host/vfs.ts` أصبح مدعوماً بـ`SafeStorageEngine` (write/read/exists/delete) (§5-هـ).
3. **Ollama حقيقي** — `OllamaBackend.chat` يرد بمحاكاة وليس عبر `fetch` إلى ollama؛ تعطيل المحاكاة عند توفر نموذج.
4. **اختبارات E2E** — `server.ts` (REST/لوحة) و`bin/nawat.ts` بلا اختبارات.
5. **محرر كامل** — `editor` في البروفايلات مجرد اسم؛ لا قدرات محرر فعلية. (المرحلة 5)
6. **واجهة فاتحة** — لوحة `server.ts` داكنة (slate-900)؛ الهدف «واجهة فاتحة 100%».
7. **كرة الثلج** — تعلم من مصادر متعددة (`snowball.ts`) لم يُنفَّذ.
8. **استكمال المراجعة** — بنود §3 (المقطّر/البروفايلات/الفهرسة/الضغط/التشغيل الفعلي).

---

## 5. التحسينات المقترحة (Improvements)

| # | الملاحظة | الموضع | المقترح |
|---|---|---|---|
| أ | ~~المستضيف يبني أشباحاً بدل الأنظمة الحقيقية: `chat: async (msg) => \`Agent response to: ${msg}\``~~ **✅ عولج** — ربط حقيقي في `initializeKernel`: `HermesKernel` (ToolRegistry + SafeStorageEngine) عند `enableHermes`، ونواة وكيل حقيقية عبر `LLMCore` (DeterministicBackend) + `ToolRegistry` + `SessionManager` عند `enableAgentKernel`؛ بوابتا `serve`/`learn`/`chat` ووصلا الأوامر `hermes.learn` و`agent.llm.chat` للنواة الحقيقية | `host/bootloader.ts` | **تم** — اختباران (editor: `kernel instanceof HermesKernel` + serve/learn حقيقيان · agent: chat عبر LLMCore) · **182/182** |
| ب | `signalingLatencyMs` مُرمَّز 0.8 (ثابت) | `host/runtime.ts:111` | قياس فعلي (performance.now حول syscall/executeCommand) |
| ج | `OllamaBackend.chat` محاكاة لا اتصال | `agent-kernel/llm-core.ts:42-56` | `fetch` حقيقي إلى `{baseUrl}/api/chat`، والمحاكاة fallback فقط عند فشل الاتصال |
| د | `SafeStorageEngine.save` يكتب المفتاح مرتين (خام + مُنقّى) | `system/storage.ts:74-75` | كتابة المفتاح المُنقّى فقط + تحديث `exists/delete/load` عليه |
| هـ | ~~`host/vfs.ts` فارغ (mount/dispose فقط)~~ **✅ عولج** — VFS واقعي مدعوم بـ`SafeStorageEngine`: `writeFile/readFile/exists/deleteFile/listFiles` (ذاكرة + تخزين آمن بالمجموع الاختباري) | `host/vfs.ts` | **تم** — اختبار كتابة/قراءة/حذف ✓ |
| ث | ~~رفض غير معالج للوعود~~ **✅ عولج** — `AgentSyscall.donePromise.catch(()=>{})` في المشيد + `isCanceled()`؛ و`executeSyscall` أصبح يعالج فعلياً عبر `AgentSyscallQueue` + تنفيذ أمر من `CommandRegistry` ويصدر `syscall:executed`، مع `p.catch` لتفادي الرفض المعلّق أثناء shutdown/forceKill | `agent-kernel/syscalls.ts` + `host/runtime.ts` | **تم** — اختباران: إرسال أمر حقيقي+حدث ✓ · إلغاء أمر بطيء على shutdown بلا رفض غير معالج ✓ |
| ت | ~~لا جسر بين `ToolRegistry` و`CommandRegistry`~~ **✅ عولج** — `ToolRegistry(commandRegistry?)` + `attachCommandRegistry` + `syncToolToCommand` → أوامر `tool.<name>` تلقائياً | `agent-kernel/tools.ts` + `host/bootloader.ts` | **تم** — اختبار: `tool.echo`/`tool.now` مسجّلتان وقابلتا التنفيذ ✓ |
| خ | ~~لا ربط بين الجلسات والحصص~~ **✅ عولج** — `SessionManager(eventBus, quotaGuard)` + `SessionInstance.executeRequest` يحسب `trackSyscall` ويبث `interrupt_request` عند تجاوز الحصة | `agent-kernel/session.ts` + `host/bootloader.ts` | **تم** — اختبار: بعد حصة 2/دقيقة تُرفض الثالثة بـ`EQUOTA_EXCEEDED` ✓ |
| ذ | ~~لا نقطة OpenAI متوافقة~~ **✅ عولج** — `/api/v1/chat/completions` عبر `HermesKernel.serve` + fallback بـ`LLMCore.chat` (API صحيح)، مع `/api/hermes/serve` و`/api/hermes/train` + حدث `arch:command_executed` — كلها تحت المصادقة `X-API-Key` والتدقيق | `server.ts` | **تم** — E2E: 401 بلا مفتاح · completion بتنسيق OpenAI ✓ · serve (calc=42) ✓ · train ✓ · `arch:command_executed` في /api/events ✓ |
| و | `ExecutionSandboxEngine.execute` يرجع رسالة جاهزة لا تنفيذاً | `system/engine/execution-sandbox.ts:76-97` | **تم على مستوى أرش:** `LinuxArchExecutionLayer` ينفّذ فعلياً (بوابات + حصص + ELF/shebang). الباقي: إعادة توجيه `ExecutionSandboxEngine` إلى الطبقة، أو استبداله بها |
| ز | أداة `calc` تستخدم `new Function` | `agent-kernel/tools.ts:125` | محلِّل حسابي خاص (shunting-yard) بلا eval |
| ح | `SessionInstance.emitStream` يبتلع أخطاء المستمعين صامتاً | `agent-kernel/session.ts:55-61` | توجيهها إلى `EventBus`/onError بدل `// Safe listener logging` |
| ط | `@google/genai` في dependencies وغير مستخدم إطلاقاً | `package.json:28` | حذفه (المشروع محلي بلا سحابة) |
| ي | نقاط REST تسمح بتسجيل أوامر/إضافات بلا مصادقة على `0.0.0.0` — **وأصبح أخطر**: `/api/arch/execute` ينفّذ أوامر نظام (مقيّدة بالبوابات لكنها منفذة فعلاً) | `server.ts:180,242` + `/api/arch/execute` | فتحها محلياً فقط (`127.0.0.1`) أو إضافة مفتاح/تقييد + تسجيل تدقيق إلزامي |
| ك | `estimateTokens` تقدير خام (طول/4) | `agent-kernel/intelligence/context-model.ts:43` | عدّاد توكنات معياري قابل للحقن |
| ل | ~~لا اختبار آلي لـ`server.ts`/`bin/nawat.ts`~~ **✅ عولج** — اختبارات تكاملية سوداء تشغّل الخادم والـCLI في عمليات فرعية | `tests/e2e-server.test.ts` + `tests/nawat-cli.test.ts` | **تم** — E2E: 401 بلا مفتاح/بمفتاح خاطئ · 200 بالمفتاح المثبّت · أمر echo ✓ · arch allowed + هروب مطلق blocked · hermes serve/train ✓ · chat completions (شكل OpenAI) ✓ · scan خارج الجذر 403 / داخل الجذر (hidden/executable/backdoor/outside_link/unregistered/tampered) ✓ · audit يحتوي projects.scan/denied/arch.execute ✓ — CLI: help/--help/-h/profiles/status (exit 0) ✓ |
| م | `ExecutionSandboxEngine.execute` لا يزال رسالة جاهزة | `system/engine/execution-sandbox.ts:76-97` | إعادة توجيهه إلى `LinuxArchExecutionLayer` (التنفيذ الفعلي أصبح فيها) |
| ن | ~~**TOCTOU** بين `inspectPath` و`execFile`: يُفحص المسار ثم يُنفَّذ بمسار قد يتغير~~ **✅ عولج** — `postCheckProgram`/`postCheckBinary` تُستدعى فوراً قبل spawn: إعادة `realpathSync` (تبديل symlink/استبدال مسار)، إعادة `stat` (اختفاء/نوع/setuid طارئ)، وفحص بصمة SHA-256 إذا وُجد `authorizedSignatures` | `linux-arch-execution-layer.ts:460-519` | **تم** — 3 اختبارات (بصمة مخوّلة تنفّذ ✓ · محتوى مُبدَّل على القرص محجوب ESECURITY ✓ · symlink داخل الجذر يُنفَّذ ببصمة الهدف الحقيقي ✓) |
| س | ~~لا عزل نظامي في التنفيذ الأرشي~~ **✅ عولج** — عزل بجذر تنفيذ إلزامي (فجوة س): `enforceExecRoot` افتراضي `true` — root = `execRoot`/cwd/جذر العمل؛ cwd خارج الجذر → رفض؛ أهداف مطلقة خارج الجذر (`cat /etc/hostname`، `touch /etc/x`) → `ESECURITY`؛ بلا cwd يُنفَّذ داخل الجذر؛ `parseCommand` يعالج المطلق كـ target لا subCommand | `linux-arch-execution-layer.ts` + `server.ts` (execRoot=project dir) | **تم** — 5 اختبارات (pwd داخل الجذر · cwd خارج مرفوض · /etc مرفوض حتى للمعدوم · نسبي يعمل) · **180/180** · E2E: cat /etc/hostname→denied ✓ |
| ش | ~~**توقيع ELF سطحي** — يُقبل بأربعة بايتات magic فقط دون فحص `e_ident`/`e_type` ودون موافقة توقيع مخوّل~~ **✅ عولج** — `inspectElfHeader` يقرأ e_ident (class 32/64 · endian · version) + e_type ويرحب بـET_EXEC/ET_DYN فقط (ET_REL/CORE → data غير قابلة للتنفيذ) + `authorizedSignatures` (SHA-256) | `file-type-detector.ts` + `linux-arch-execution-layer.ts` | **تم** — 3 اختبارات (EXEC 64-bit little ✓ · DYN 32-bit big ✓ · ET_REL محجوب ببصمة ET_REL ✓ + طبقة الأرش تحجب ELF غير قابل للتنفيذ) |
| ص | ~~**`syncToDisk()` في `PersistentIndexer` دمية (no-op)** — الفهرس لا يُحفظ فعلياً؛ يفقد خط الأساس عند إعادة التشغيل فلا يمكن تتبّع المزروع/المعبث عبر الجلسات~~ **✅ عولج** — حفظ ذرّي حقيقي (JSON + tmp + rename إلى `.nawat-index.json`) مع غلاف بصمة SHA-256 + `loadFromDisk` يتحقق (`EINTEGRITY` عند الفساد) ويعيد بناء الفهرس والعداد | `system/vfs/persistent-indexer.ts:267-312` | **تم** — 2 اختباران (حفظ/تحميل عبر الجلسات ✓ · snapshot معبث → EINTEGRITY ✓) |
| ض | ~~**`file-type-detector` يقرأ 64 بايتاً بينما طبقة الأرش تقرأ 512** — تغطية قراءة غير موحّدة (كشف متناقض محتمل للثنائيات التي magic بعد 64)~~ **✅ عولج** — قراءة موحّدة 512 بايت في الجهتين (string وUint8Array) | `system/vfs/file-type-detector.ts` | **تم** — كشف ELF/shebang على 512 بايت متطابق بين الطبقتين |
| طـ | **`PersistentIndexer` يسجّل `symlink` كعقدة دون تتبّع هدفها** — لا فحص هروب/إعادة توجيه داخل الفهرس (الماسح يعوّضه بـ`outside_link` لكن الفهرس نفسه يبقى ساذجاً) | `system/vfs/persistent-indexer.ts:6` | تخزين `linkTarget` + فحصه عند التسجيل |
| ع | ~~لا رفض صريح لـ`setuid/setgid` في `LinuxArchExecutionLayer`~~ **✅ عولج** — رفض `ESECURITY` عند اكتشاف `(mode & 0o6000)` في `inspectPath` قبل أي تنفيذ | `linux-arch-execution-layer.ts` | **تم** — 3 اختبارات (SUID/SGID مرفوضان + عادي يعمل) · E2E curl: `denied ESECURITY ... 0o104755` ✓ |
| غ | ~~`/api/projects/scan` و`/api/arch/*` بلا مصادقة على `0.0.0.0`~~ **✅ عولج** — ربط `127.0.0.1` افتراضياً (`NAWAT_HOST`) + مفتاح `X-API-Key` إلزامي لكل `/api` (يُولَّد تلقائياً أو `NAWAT_API_KEY`) + تقييد جذور الفحص بجذر العمل (`NAWAT_SCAN_ROOTS`) + تدقيق `[AUDIT]` + `/api/audit` | `server.ts` | **تم** — E2E: بلا مفتاح 401 · خارج الجذر 403 · داخل الجذر يعمل · تنفيذ+تدقيق ✓ |
| ف | ~~**checksum الماسح FNV-1a غير تشفيري** — كشف العبث مضمون الحوادث (collision) لا مضمون التشفير~~ **✅ عولج** — ترقية إلى SHA-256 (`node:crypto`) في الماسح **والفهرس** (`computeChecksum`) **وخادم `/api/projects/scan`** — خوارزمية واحدة للبصمات | `system/vfs/project-scanner.ts` + `persistent-indexer.ts` + `server.ts:497` | **تم** — `project-scanner.test.ts` يستخدم sha256 لخط الأساس (لا false positives) · E2E: baseline معبث → `tampered` ✓ |

---

## 6. خط الإنجاز (Rolling Checkpoint)

| التاريخ | ما تحقق | الاختبارات |
|---|---|---|
| اليوم | **تنفيذ البنود الأمنية الأربعة ذات الأولوية (ص·ف·ن·ش·ل)** — ① خط أساس دائم حقيقي: `syncToDisk` ذرّي (tmp+rename) + `loadFromDisk` مع بصمة غلاف SHA-256 (`EINTEGRITY`) · ② توحيد SHA-256 في الماسح والفهرس **والخادم** (FNV-1a سابقاً في `server.ts` كان سيولّد false positives) · ③ إعادة تحقق TOCTOU فورياً قبل spawn (`postCheckProgram`/`postCheckBinary`: realpath + stat + setuid + `authorizedSignatures` SHA-256) · ④ فحص ELF عميق `inspectElfHeader` (e_ident class/endian/version + e_type؛ ET_REL/CORE محجوبة) + قراءة موحّدة 512 بايت + إصلاح `executable:false` الثابت في فرع ET_REL · ⑤ **E2E آلي أسود**: `e2e-server.test.ts` (15) يُقلع `server.ts` في عملية فرعية + `nawat-cli.test.ts` (4) | `tsc` نظيف · `build` نظيف · **226/226** · E2E: 401/200/403 · scan (hidden/executable/backdoor/outside_link/unregistered/tampered) · arch allowed+blocked · hermes · chat OpenAI shape · audit ✓ · CLI help/profiles/status ✓ |
| اليوم | مراجعة التحديثات · تحديث `kernel.md` للهيكل الجديد · توثيق الحالة | `tsc` نظيف · `build` نظيف · **127/127** |
| اليوم | طبقة `LinuxArchExecutionLayer` (تنفيذ حقيقي + بوابات أرش) · دعم الملفات المجهولة (shebang/ثنائي مجهول) · تحصين الملفات المخفية (جذر realpath · Unicode · devices · dotfiles) | `tsc` نظيف · **166/166** |
| اليوم | دمج الطبقة في `server.ts`: `/api/arch/execute` + `/api/arch/history` + `/api/arch/status` + تبويب لوحة (RTL) — اختُبرت E2E بالـcurl | `tsc` نظيف · `build` نظيف · curl: allowed/blocked/audit ✓ |
| اليوم | **دمج مراجعة الطرف الخارجي فوق تحصيناتنا** — إصلاح الوعود غير المعالجة (`donePromise.catch` + `isCanceled`) · `executeSyscall` حقيقي عبر الطابور وسجل الأوامر + `syscall:executed` · جسر Tool↔Command · ربط Session↔Quota · VFS مدعوم بـ`SafeStorageEngine` · `/api/v1/chat/completions` + `/api/hermes/serve` + `/api/hermes/train` + حدث `arch:command_executed` — مع **الإبقاء على الحماية** (127.0.0.1 + X-API-Key + جذور فحص + تدقيق + رفض setuid + عزل جذر التنفيذ) · أصلحنا `LLMCore` الخاطئ في endpoint الطرف الخارجي (chat بدل generateResponse) | `tsc` نظيف · `build` نظيف · **187/187** · E2E: 401 بلا مفتاح ✓ · completion ✓ · serve ✓ · train ✓ · scan /etc→403 ✓ · cat /etc→denied ✓ |
| اليوم | **تبنّي فكرة حل الطرف الخارجي (لا نسخته)** — ① خيارات عزل مُسمّاة: `rejectSetuidSetgid`/`isolateAbsoluteTargets` (افتراضي true) منفصلة عن `enforceExecRoot` · ② دلالات العنصر المسحوب فعلياً في `executeSyscall`: تنفيذ بـ`sysName`/`sysPayload`/`currentSyscall.id` لا بمتغيرات الإغلاق (لا تداخل دلالي بين استدعاءات متزامنة) · ③ `agentKernel.storage = SafeStorageEngine` · ④ `hermes.serveText` يستخرج النص/الحالة من `SymbolicLoop` بأمان · مع بقاء رفض setuid الافتراضي والـ`LLMCore.chat` الصحيح (أُنجزا سابقاً) | `tsc` نظيف · **194/194** · اختبارات: خيارا العزل (مُفعّل/مُعطّل) · 8 استدعاءات متزامنة بهويات مستقلة ✓ · `storage`/`serveText` ✓ |
| اليوم | **تدقيق أعمق لكشف أخطاء إجابة الطرف (وجدنا خطأين لم يذكراهما)** — ① **هروب نسبي عبر `..`** خارج الجذر: عزل الأهداف كان يغطي المطلقة فقط؛ `cat ../.../etc/hostname` من داخل الجذر يفلت (ويصنّف `parseCommand` المَسارات كـ subCommand لا target) → عولج: `parseCommand` يعامل أي رمز يحوي `/` كـ target، و`isolateAbsoluteTargets` يحسب `resolve(cwd, target)` ويرفض أي هروب نسبي أو مطلق خارج الجذر · ② **تسرّب `pendingSyscalls`** عند اختلاف هوية العنصر المسحوب عن المسجَّل: يُحذف المفتاحان (`currentSyscall.id` + `syscall.id`) في النجاح والفشل | `tsc` نظيف · **197/197** · E2E: `cat ../../etc/hostname` من داخل الجذر → blocked ✓ · `cat package.json` → allowed ✓ · 401 ✓ · completion ✓ · serve ✓ · اختبارا هروب نسبي + لا تسرّب ✓ |
| اليوم | **خطأ قالب العميل في `server.ts` (اكتشفه العميل وصدّقناه)** — داخل قالب backtick كانت `\n` تُفسَّر كنقل سطر فعلي في سلسلة الخادم، فيصل المتصفح سلاسل مفكوكة مثل `'` + سطر جديد → `Uncaught SyntaxError: Invalid or unexpected token` في `executeArch` (النتائج) و`runScan` (`lines.join`). عولج: تهريب `\\n` لكل مواقع الستة في القالب؛ تحقّق آلي: استخراج `<script>` من الصفحة المرسلة و`node --check` نظيف (13494 بايت) و7 تسلسلات `'\n` سليمة في المخرَج | `tsc` نظيف · build نظيف · **197/197** · `node --check` على سكربت العميل المرسَل ✓ |
| اليوم | **ربط حقيقي للنواة العليا/هيرمس في المستضيف** — استبدال الأشباح في `bootloader.initializeKernel`: `HermesKernel` حقيقي (enableHermes) + نواة وكيل عبر `LLMCore`/`ToolRegistry`/`SessionManager` (enableAgentKernel)؛ الأوامر `hermes.learn`/`agent.llm.chat` توصل النواة الحقيقية | `tsc` نظيف · **182/182** · اختباران: `instanceof HermesKernel` + serve/learn/chat عبر نواة حقيقية |
| اليوم | **ماسح المشروع الخارجي** `scanProject` (مخفي/قابل تنفيذ/setuid/هروب/مزروع/معبث/مفقود) + `/api/projects/scan` + تبويب لوحة — E2E بالـcurl ✓ · سُجّلت فجوات أمنية §5 (ن→ف) | `tsc` نظيف · `build` نظيف · **172/172** · curl: 6 فئات إيجابية + baseline tampered ✓ |
