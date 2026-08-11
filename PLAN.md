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

bin/nawat.ts (71) · server.ts (703) · tests/ (10 ملفات · 166 اختباراً)
```

**الحالة المثبتة اليوم (آخر تحقق):**
- `bun install` ناجح · `tsc --noEmit` **نظيف** · `bun run build` **نظيف** (dist/server.cjs 67KB) · **166/166 اختباراً أخضر** (10 ملفات، ~1.3s).

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

1. **ربط حقيقي للنواة العليا/هيرمس في المستضيف** — `bootloader.initializeKernel` يبني حالياً «أشباحاً» (stubs) لـ`agentKernel`/`hermes`/`editor` بدل ربط `HermesKernel`/`AgentKernel` الحقيقية (راجع §5-أ).
2. **VFS وظيفية في المستضيف** — `host/vfs.ts` mount/dispose فقط؛ VFS الحقيقية في `system/vfs` غير موصولة.
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
| أ | المستضيف يبني أشباحاً بدل الأنظمة الحقيقية: `chat: async (msg) => \`Agent response to: ${msg}\`` | `host/bootloader.ts:114-139` | ربط `HermesKernel`/`ToolRegistry`/`SessionManager` الحقيقية في `initializeKernel` وتفعيلها عبر الأنماط |
| ب | `signalingLatencyMs` مُرمَّز 0.8 (ثابت) | `host/runtime.ts:111` | قياس فعلي (performance.now حول syscall/executeCommand) |
| ج | `OllamaBackend.chat` محاكاة لا اتصال | `agent-kernel/llm-core.ts:42-56` | `fetch` حقيقي إلى `{baseUrl}/api/chat`، والمحاكاة fallback فقط عند فشل الاتصال |
| د | `SafeStorageEngine.save` يكتب المفتاح مرتين (خام + مُنقّى) | `system/storage.ts:74-75` | كتابة المفتاح المُنقّى فقط + تحديث `exists/delete/load` عليه |
| هـ | `host/vfs.ts` فارغ (mount/dispose فقط) | `host/vfs.ts` | دمجه مع `system/vfs` (path-sanitizer + indexer) ليصبح مرجعاً واحداً |
| و | `ExecutionSandboxEngine.execute` يرجع رسالة جاهزة لا تنفيذاً | `system/engine/execution-sandbox.ts:76-97` | **تم على مستوى أرش:** `LinuxArchExecutionLayer` ينفّذ فعلياً (بوابات + حصص + ELF/shebang). الباقي: إعادة توجيه `ExecutionSandboxEngine` إلى الطبقة، أو استبداله بها |
| ز | أداة `calc` تستخدم `new Function` | `agent-kernel/tools.ts:125` | محلِّل حسابي خاص (shunting-yard) بلا eval |
| ح | `SessionInstance.emitStream` يبتلع أخطاء المستمعين صامتاً | `agent-kernel/session.ts:55-61` | توجيهها إلى `EventBus`/onError بدل `// Safe listener logging` |
| ط | `@google/genai` في dependencies وغير مستخدم إطلاقاً | `package.json:28` | حذفه (المشروع محلي بلا سحابة) |
| ي | نقاط REST تسمح بتسجيل أوامر/إضافات بلا مصادقة على `0.0.0.0` — **وأصبح أخطر**: `/api/arch/execute` ينفّذ أوامر نظام (مقيّدة بالبوابات لكنها منفذة فعلاً) | `server.ts:180,242` + `/api/arch/execute` | فتحها محلياً فقط (`127.0.0.1`) أو إضافة مفتاح/تقييد + تسجيل تدقيق إلزامي |
| ك | `estimateTokens` تقدير خام (طول/4) | `agent-kernel/intelligence/context-model.ts:43` | عدّاد توكنات معياري قابل للحقن |
| ل | لا اختبار آلي لـ`server.ts`/`bin/nawat.ts` | `tests/` | اختبارات تكاملية (boot → serve → learn → save/load). جرّبت `/api/arch/*` يدوياً (curl) ✓ |
| م | `ExecutionSandboxEngine.execute` لا يزال رسالة جاهزة | `system/engine/execution-sandbox.ts:76-97` | إعادة توجيهه إلى `LinuxArchExecutionLayer` (التنفيذ الفعلي أصبح فيها) |
| ن | **TOCTOU** بين `inspectPath` و`execFile`: يُفحص المسار ثم يُنفَّذ بمسار قد يتغير | `linux-arch-execution-layer.ts` | تنفيذ قائم على الواصف `openat`/`execveat` (محدود في Node) أو إعادة فحص `lstat` بعد التنفيذ + تسجيل تحذير |
| س | **لا عزل نظامي** في التنفيذ الأرشي (لا seccomp/bubblewrap/Landlock) — أمر مصرّح يمكنه الوصول لملفات النظام بعيداً عن جذر التنفيذ | `linux-arch-execution-layer.ts` | عزل `bubblewrap`/`landlock` أو جذر تنفيذ إلزامي عند التنفيذ الفعلي |
| ش | **توقيع ELF سطحي** — يُقبل بأربعة بايتات magic فقط دون فحص `e_ident`/`e_type` ودون موافقة توقيع مخوّل | `linux-arch-execution-layer.ts` + `file-type-detector.ts` | فحص `e_type` (executable/shared) + قائمة توقيعات مخوّلة |
| ص | **`syncToDisk()` في `PersistentIndexer` دمية (no-op)** — الفهرس لا يُحفظ فعلياً؛ يفقد خط الأساس عند إعادة التشغيل فلا يمكن تتبّع المزروع/المعبث عبر الجلسات | `system/vfs/persistent-indexer.ts:237-243` | حفظ snapshot ذرّي حقيقي (JSON+checksum) وتحميله عند الإقلاع؛ **الماسح يحتاج خط أساس دائماً ليُقارن به** |
| ض | **`file-type-detector` يقرأ 64 بايتاً بينما طبقة الأرش تقرأ 512** — تغطية قراءة غير موحّدة (كشف متناقض محتمل للثنائيات التي magic بعد 64) | `system/vfs/file-type-detector.ts` + `linux-arch-execution-layer.ts` | توحيد حجم القراءة (512) في الجهتين |
| طـ | **`PersistentIndexer` يسجّل `symlink` كعقدة دون تتبّع هدفها** — لا فحص هروب/إعادة توجيه داخل الفهرس (الماسح يعوّضه بـ`outside_link` لكن الفهرس نفسه يبقى ساذجاً) | `system/vfs/persistent-indexer.ts:6` | تخزين `linkTarget` + فحصه عند التسجيل |
| ع | **لا رفض صريح لـ`setuid/setgid` في `LinuxArchExecutionLayer`** — تنفيذ برنامج ببت 4/2 من مشروع = تصعيد صلاحيات محتمل | `linux-arch-execution-layer.ts` | رفض `ESECURITY` عند اكتشاف `(mode & 0o6000)` |
| غ | ~~`/api/projects/scan` و`/api/arch/*` بلا مصادقة على `0.0.0.0`~~ **✅ عولج** — ربط `127.0.0.1` افتراضياً (`NAWAT_HOST`) + مفتاح `X-API-Key` إلزامي لكل `/api` (يُولَّد تلقائياً أو `NAWAT_API_KEY`) + تقييد جذور الفحص بجذر العمل (`NAWAT_SCAN_ROOTS`) + تدقيق `[AUDIT]` + `/api/audit` | `server.ts` | **تم** — E2E: بلا مفتاح 401 · خارج الجذر 403 · داخل الجذر يعمل · تنفيذ+تدقيق ✓ |
| ف | **checksum الماسح FNV-1a غير تشفيري** — كشف العبث مضمون الحوادث (collision) لا مضمون التشفير | `system/vfs/project-scanner.ts` | ترقية إلى SHA-256 (`node:crypto`) مع خط أساس مُوقّع |

---

## 6. خط الإنجاز (Rolling Checkpoint)

| التاريخ | ما تحقق | الاختبارات |
|---|---|---|
| اليوم | مراجعة التحديثات · تحديث `kernel.md` للهيكل الجديد · توثيق الحالة | `tsc` نظيف · `build` نظيف · **127/127** |
| اليوم | طبقة `LinuxArchExecutionLayer` (تنفيذ حقيقي + بوابات أرش) · دعم الملفات المجهولة (shebang/ثنائي مجهول) · تحصين الملفات المخفية (جذر realpath · Unicode · devices · dotfiles) | `tsc` نظيف · **166/166** |
| اليوم | دمج الطبقة في `server.ts`: `/api/arch/execute` + `/api/arch/history` + `/api/arch/status` + تبويب لوحة (RTL) — اختُبرت E2E بالـcurl | `tsc` نظيف · `build` نظيف · curl: allowed/blocked/audit ✓ |
| اليوم | **ماسح المشروع الخارجي** `scanProject` (مخفي/قابل تنفيذ/setuid/هروب/مزروع/معبث/مفقود) + `/api/projects/scan` + تبويب لوحة — E2E بالـcurl ✓ · سُجّلت فجوات أمنية §5 (ن→ف) | `tsc` نظيف · `build` نظيف · **172/172** · curl: 6 فئات إيجابية + baseline tampered ✓ |
