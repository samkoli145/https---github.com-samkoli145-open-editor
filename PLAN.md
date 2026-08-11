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

bin/nawat.ts (71) · server.ts (1618) · tests/ (14 ملفات · 230 اختباراً)
```

**الحالة المثبتة اليوم (آخر تحقق):**
- `bun install` ناجح · `tsc --noEmit` **نظيف** · `bun run build` **نظيف** (dist/server.cjs 67KB) · **230/230 اختباراً أخضر** (14 ملفات، ~3.3s).

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
| 11 | **طبقة تنفيذ أرش** `LinuxArchExecutionLayer` — تنفيذ حقيقي `execFile` بلا shell ببوابات إلزامية: code-domain (قواعد أرش: `rm -rf`/`mkfs`/`dd`/`poweroff`/`sudo`/`pacman -R`…) → allowlist (70+ أداة) → quota (معدل/زمن/أخطاء) → جذر تنفيذ realpath (ضد هروب symlink خارج الشجرة) → ELF (توقيع + بت تنفيذ) / سكربتات shebang (المفسّر من allowlist) / رفض الثنائيات المجهولة والملفات غير العادية | `linux-arch-execution-layer.test.ts` (36) |
| 12 | كشف الملفات المجهولة: shebang يكشف المفسّر واللغة (امتداد/نوع مجهولان) + الثنائيات المجهولة `bin/octet-stream` بدل تصنيفها نصاً | `system.test.ts` (18) |
| 13 | **ماسح المشروع الخارجي** `scanProject` — عند فحص مجلد مشروع من الخارج يكشف: ملفات مخفية (نقطية + أسماء Unicode خفية) · قابلة للتنفيذ (ELF/skriptات shebang) · backdoor (setuid/setgid + غير-عادية) · روابط رمزية خارجة عن الشجرة (هروب) · مزروعة (غير مسجّلة) / معبث بها (checksum) / مفقودة مقابل `PersistentIndexer` — مدمج REST `/api/projects/scan` + تبويب لوحة | `project-scanner.test.ts` (6) |

---

## 3. لم يُراجع بعد (Not yet fully reviewed)

| المنطقة | الملفات | درجة المراجعة |
|---|---|---|
| أجسام ملفات الاختبار | `tests/*.test.ts` (11) | راجعت الأعداد فقط، لا تفاصيل الحالات |
| منطق التقطير | `logic/program-distiller.ts` (47) | لم يُراجع بالكامل |
| بروفايلات النطاقات | `logic/domains/code/reasoning/scraping-domain.ts` (3) | لم تُراجع (الـ index/forge/compiler/retro نعم) |
| الفهرسة الدائمة | `system/vfs/persistent-indexer.ts` (255) + `file-type-detector.ts` (85) | indexer: روجعت بالكامل — ثغرة symlink غير متتبَّعة (سجّلت في §5-طـ) · detector: يُعاد قراءته عند توحيد 512 بايت (§5-ض) |
| اختبار الضغط | `stress.test.ts` (143) | لم يُراجع محتواه |
| تشغيل فعلي للخادم | `server.ts` | شغّلته واختبرت `/api/arch/*` (curl): allowed/blocked/audit ✓ — بقية النقاط لم تُختبر كلها بعد |
| تشغيل فعلي للـCLI | `bin/nawat.ts` | لم أشغّله (الـ help/profiles/boot غير مُختبَر فعلياً) |
| LLM حقيقي | `OllamaBackend` | لا يوجد نموذج محلي؛ الاختبار الحقيقي معلّق |

---

## 4. المتبقي (Remaining)

1. ~~**ربط حقيقي للنواة العليا/هيرمس في المستضيف** — `bootloader.initializeKernel` يبني حالياً «أشباحاً» (stubs) لـ`agentKernel`/`hermes`/`editor` بدل ربط `HermesKernel`/`AgentKernel` الحقيقية (راجع §5-أ).~~ **تم** — ربط `HermesKernel` + نواة وكيل حقيقية (LLMCore/ToolRegistry/SessionManager) في `initializeKernel` (§5-أ).
2. ~~**VFS وظيفية في المستضيف** — `host/vfs.ts` mount/dispose فقط؛ VFS الحقيقية في `system/vfs` غير موصولة.~~ **تم** — `host/vfs.ts` أصبح مدعوماً بـ`SafeStorageEngine` (write/read/exists/delete) (§5-هـ).
3. **Ollama حقيقي** — `OllamaBackend.chat` يرد بمحاكاة وليس عبر `fetch` إلى ollama؛ تعطيل المحاكاة عند توفر نموذج.
 4. ~~اختبارات E2E~~ **✅ عولج** — `e2e-server.test.ts` (9، mirror داخل العملية) + `e2e-blackbox.test.ts` (14، تشغيل `server.ts` الفعلي) + `nawat-cli.test.ts` (4).
 5. **محرر كامل** — `editor` في البروفايلات مجرد اسم؛ لا قدرات محرر فعلية. (المرحلة 5)
 6. ~~**واجهة فاتحة**~~ **✅ عولج** — نسخة `Web OS Station` (KDE Breeze/Dolphin) فاتحة (slate-100) بتقويم/ساعة/زر إيقاف/قائمة برامج.
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
| ل | ~~لا اختبار آلي لـ`server.ts`/`bin/nawat.ts`~~ **✅ عولج** (نسخة archive) — E2E mirror + E2E أسود حقيقي + CLI | `tests/e2e-server.test.ts` + `e2e-blackbox.test.ts` + `nawat-cli.test.ts` | **تم** — blackbox: 401/200/403 · أمر echo · arch allowed+blocked (مطلق ونسبي `..`) · serve/train · chat (شكل OpenAI) · scan (tampered/ok/unregistered/hidden/backdoor/outside_link) · خط أساس دائم عبر الجلسات · audit ✓ |
| م | `ExecutionSandboxEngine.execute` لا يزال رسالة جاهزة | `system/engine/execution-sandbox.ts:76-97` | إعادة توجيهه إلى `LinuxArchExecutionLayer` (التنفيذ الفعلي أصبح فيها) |
| ن | ~~**TOCTOU** بين `inspectPath` و`execFile`: يُفحص المسار ثم يُنفَّذ بمسار قد يتغير~~ **✅ عولج** (نسخة archive) — إعادة تحقق فورية قبل spawn: `realpathSync` (تبديل symlink/استبدال مسار) + `stat` (اختفاء/تبدل/فقدان بت التنفيذ) + فحص `authorizedSignatures` (قائمة SHA-256) | `linux-arch-execution-layer.ts:306-327` | **تم** — اختباران (بصمة مخوّلة تنفّذ ✓ · محتوى غير مأذون محجوب ✓) + اختبار رابط-حقيقي ✓ |
| س | ~~لا عزل نظامي في التنفيذ الأرشي~~ **✅ عولج** — عزل بجذر تنفيذ إلزامي (فجوة س): `enforceExecRoot` افتراضي `true` — root = `execRoot`/cwd/جذر العمل؛ cwd خارج الجذر → رفض؛ أهداف مطلقة خارج الجذر (`cat /etc/hostname`، `touch /etc/x`) → `ESECURITY`؛ بلا cwd يُنفَّذ داخل الجذر؛ `parseCommand` يعالج المطلق كـ target لا subCommand + هروب نسبي `..` عبر `resolve(cwd, target)` | `linux-arch-execution-layer.ts` + `server.ts` (execRoot=project dir) | **تم** — اختبارات (pwd داخل الجذر · cwd خارج مرفوض · /etc مرفوض حتى للمعدوم · نسبي يعمل) · E2E: cat /etc/hostname→denied ✓ · cat ../../etc/hostname→denied ✓ |
| ش | ~~**توقيع ELF سطحي** — يُقبل بأربعة بايتات magic فقط دون فحص `e_ident`/`e_type` ودون موافقة توقيع مخوّل~~ **✅ عولج** (نسخة archive) — `inspectElfHeader` يفحص e_ident/e_type ويرفض غير ET_EXEC/ET_DYN بذكر السبب (`elfInfo.reason`) + `authorizedSignatures` (SHA-256) | `file-type-detector.ts` + `linux-arch-execution-layer.ts` | **تم** — اختبار ET_REL محجوب بسببه رغم بت التنفيذ ✓ (أصلحنا قناع `executable && isValid` في نسخة archive) |
| ص | ~~**`syncToDisk()` في `PersistentIndexer` دمية (no-op)** — الفهرس لا يُحفظ فعلياً؛ يفقد خط الأساس عند إعادة التشغيل فلا يمكن تتبّع المزروع/المعبث عبر الجلسات~~ **✅ عولج** — نسخة archive كان فيها حفظ JSON خام بلا غلاف؛ أعدنا تحصينه: حفظ ذرّي (tmp+rename) + غلاف بصمة SHA-256 + `loadFromDisk` يرفض العبث بـ`EINTEGRITY` ويعيد بناء الفهرس والعداد؛ خادم الفحص يحمّل الخط الأساس الدائم تلقائياً ويحفظه بعد كل مسح | `system/vfs/persistent-indexer.ts` + `server.ts` scan route | **تم** — اختباران (حفظ/تحميل عبر الجلسات ✓ · snapshot معبث → EINTEGRITY ✓) + E2E: مسح ثانٍ بلا registered يكتشف التغيير tampered ✓ |
| ض | ~~**`file-type-detector` يقرأ 64 بايتاً بينما طبقة الأرش تقرأ 512** — تغطية قراءة غير موحّدة (كشف متناقض محتمل للثنائيات التي magic بعد 64)~~ **✅ عولج** (نسخة archive) — قراءة موحّدة 512 بايت في الجهتين | `system/vfs/file-type-detector.ts` + `linux-arch-execution-layer.ts` | **تم** — كشف ELF/shebang على 512 بايت متطابق |
| طـ | **`PersistentIndexer` يسجّل `symlink` كعقدة دون تتبّع هدفها** — لا فحص هروب/إعادة توجيه داخل الفهرس (الماسح يعوّضه بـ`outside_link` لكن الفهرس نفسه يبقى ساذجاً) | `system/vfs/persistent-indexer.ts:6` | تخزين `linkTarget` + فحصه عند التسجيل |
| ع | ~~لا رفض صريح لـ`setuid/setgid` في `LinuxArchExecutionLayer`~~ **✅ عولج** — رفض `ESECURITY` عند اكتشاف `(mode & 0o6000)` في `inspectPath` قبل أي تنفيذ | `linux-arch-execution-layer.ts` | **تم** — 3 اختبارات (SUID/SGID مرفوضان + عادي يعمل) · E2E curl: `denied ESECURITY ... 0o104755` ✓ |
| غ | ~~`/api/projects/scan` و`/api/arch/*` بلا مصادقة على `0.0.0.0`~~ **✅ عولج** — مفتاح `X-API-Key` إلزامي لكل `/api` (يُولَّد تلقائياً أو `NAWAT_API_KEY`) + تقييد جذور الفحص (`NAWAT_SCAN_ROOTS`) + تدقيق `[AUDIT]` + `/api/audit`. **ملاحظة**: نسخة archive أعادت `0.0.0.0` الافتراضي → أعدنا تحصينه إلى `127.0.0.1` افتراضياً + `PORT` من البيئة | `server.ts` | **تم** — E2E: بلا مفتاح 401 · خارج الجذر 403 · داخل الجذر يعمل · تنفيذ+تدقيق ✓ |
| ف | ~~**checksum الماسح FNV-1a غير تشفيري** — كشف العبث مضمون الحوادث (collision) لا مضمون التشفير~~ **✅ عولج** (نسخة archive) — `bytesChecksum` في الماسح/الفهرس/الخادم SHA-256 موحّد | `system/vfs/project-scanner.ts` + `persistent-indexer.ts` + `server.ts` | **تم** — E2E: خط أساس معبث → `tampered` ✓ · خط أساس دائم عبر الجلسات ✓ |

---

## 6. خط الإنجاز (Rolling Checkpoint)

| التاريخ | ما تحقق | الاختبارات |
|---|---|---|
| اليوم | **اعتماد نسخة `archive` كأساس** (واجهة Web OS Station + حلول الطرف بجذورها) ثم إعادة التحصين: ① `PORT` من البيئة + ربط `127.0.0.1` افتراضياً (archive كان `0.0.0.0` ثابتاً) · ② إصلاح خطأ تسجيل المعيار في `/api/projects/scan` (كان يمرر بصمة checksum كـ content فيصبح كل ملف معبثاً) + إحياء بصمة العميل + خط أساس دائم يُحمَّل ويُحفظ تلقائياً · ③ `PersistentIndexer` حفظ ذرّي + غلاف SHA-256 + `EINTEGRITY` عند التحميل (archive كان JSON خاماً) · ④ إصلاح قناع `executable && isValid` الذي يخفي سبب رفض ELF غير القابل للتنفيذ · ⑤ E2E أسود حقيقي `e2e-blackbox.test.ts` (14) يُقلع `server.ts` الفعلي + اختبارات فهرس/أرش | `tsc` نظيف · `build` نظيف · **230/230** · blackbox: 401/403/200 · arch مطلق ونسبي blocked · scan tampered/خط أساس دائم عبر الجلسات ✓ · audit ✓ |
| اليوم | مراجعة التحديثات · تحديث `kernel.md` للهيكل الجديد · توثيق الحالة | `tsc` نظيف · `build` نظيف · **127/127** |
| اليوم | طبقة `LinuxArchExecutionLayer` (تنفيذ حقيقي + بوابات أرش) · دعم الملفات المجهولة (shebang/ثنائي مجهول) · تحصين الملفات المخفية (جذر realpath · Unicode · devices · dotfiles) | `tsc` نظيف · **166/166** |
| اليوم | دمج الطبقة في `server.ts`: `/api/arch/execute` + `/api/arch/history` + `/api/arch/status` + تبويب لوحة (RTL) — اختُبرت E2E بالـcurl | `tsc` نظيف · `build` نظيف · curl: allowed/blocked/audit ✓ |
| اليوم | **دمج مراجعة الطرف الخارجي فوق تحصيناتنا** — إصلاح الوعود غير المعالجة (`donePromise.catch` + `isCanceled`) · `executeSyscall` حقيقي عبر الطابور وسجل الأوامر + `syscall:executed` · جسر Tool↔Command · ربط Session↔Quota · VFS مدعوم بـ`SafeStorageEngine` · `/api/v1/chat/completions` + `/api/hermes/serve` + `/api/hermes/train` + حدث `arch:command_executed` — مع **الإبقاء على الحماية** (127.0.0.1 + X-API-Key + جذور فحص + تدقيق + رفض setuid + عزل جذر التنفيذ) · أصلحنا `LLMCore` الخاطئ في endpoint الطرف الخارجي (chat بدل generateResponse) | `tsc` نظيف · `build` نظيف · **187/187** · E2E: 401 بلا مفتاح ✓ · completion ✓ · serve ✓ · train ✓ · scan /etc→403 ✓ · cat /etc→denied ✓ |
| اليوم | **تبنّي فكرة حل الطرف الخارجي (لا نسخته)** — ① خيارات عزل مُسمّاة: `rejectSetuidSetgid`/`isolateAbsoluteTargets` (افتراضي true) منفصلة عن `enforceExecRoot` · ② دلالات العنصر المسحوب فعلياً في `executeSyscall`: تنفيذ بـ`sysName`/`sysPayload`/`currentSyscall.id` لا بمتغيرات الإغلاق (لا تداخل دلالي بين استدعاءات متزامنة) · ③ `agentKernel.storage = SafeStorageEngine` · ④ `hermes.serveText` يستخرج النص/الحالة من `SymbolicLoop` بأمان · مع بقاء رفض setuid الافتراضي والـ`LLMCore.chat` الصحيح (أُنجزا سابقاً) | `tsc` نظيف · **194/194** · اختبارات: خيارا العزل (مُفعّل/مُعطّل) · 8 استدعاءات متزامنة بهويات مستقلة ✓ · `storage`/`serveText` ✓ |
| اليوم | **تدقيق أعمق لكشف أخطاء إجابة الطرف (وجدنا خطأين لم يذكراهما)** — ① **هروب نسبي عبر `..`** خارج الجذر: عزل الأهداف كان يغطي المطلقة فقط؛ `cat ../.../etc/hostname` من داخل الجذر يفلت (ويصنّف `parseCommand` المَسارات كـ subCommand لا target) → عولج: `parseCommand` يعامل أي رمز يحوي `/` كـ target، و`isolateAbsoluteTargets` يحسب `resolve(cwd, target)` ويرفض أي هروب نسبي أو مطلق خارج الجذر · ② **تسرّب `pendingSyscalls`** عند اختلاف هوية العنصر المسحوب عن المسجَّل: يُحذف المفتاحان (`currentSyscall.id` + `syscall.id`) في النجاح والفشل | `tsc` نظيف · **197/197** · E2E: `cat ../../etc/hostname` من داخل الجذر → blocked ✓ · `cat package.json` → allowed ✓ · 401 ✓ · completion ✓ · serve ✓ · اختبارا هروب نسبي + لا تسرّب ✓ |
| اليوم | **ربط حقيقي للنواة العليا/هيرمس في المستضيف** — استبدال الأشباح في `bootloader.initializeKernel`: `HermesKernel` حقيقي (enableHermes) + نواة وكيل عبر `LLMCore`/`ToolRegistry`/`SessionManager` (enableAgentKernel)؛ الأوامر `hermes.learn`/`agent.llm.chat` توصل النواة الحقيقية | `tsc` نظيف · **182/182** · اختباران: `instanceof HermesKernel` + serve/learn/chat عبر نواة حقيقية |
| اليوم | **ماسح المشروع الخارجي** `scanProject` (مخفي/قابل تنفيذ/setuid/هروب/مزروع/معبث/مفقود) + `/api/projects/scan` + تبويب لوحة — E2E بالـcurl ✓ · سُجّلت فجوات أمنية §5 (ن→ف) | `tsc` نظيف · `build` نظيف · **172/172** · curl: 6 فئات إيجابية + baseline tampered ✓ |
