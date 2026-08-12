# بنية النواة — الحالة الحالية (Architecture Snapshot)

> **وثيقة الحالة الجارية.** تُحدَّث مع كل تغيير هيكلي، ولا تحفظ التاريخ (التاريخ في `docs/changelog.md`). `PLAN.md` = مؤشر (index) فقط.
> آخر تحديث: جلسة «النواة العليا المستقلة» — اقرأ من الأسفل إلى الأعلى (الحديث فوق).

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

**الحالة الراهنة (إلى حين تنفيذ §4-0):** `bootloader.ts:126-151` لا يزال يبني **كائن تجميعي** باسم `agentKernel` (llm/tools/sessions/quota/storage) — الفئة `AgentKernel` جاهزة (17 اختباراً ✓) لكن **لم تُربط بعد** في المستضيف. لا توجد نواتان فعليتان في البوت لودر بعد — النواة العليا موجودة كفئة مستقلة باختباراتها.

## 3. النواة العليا (AgentKernel) — الطبقة الخامسة

- **مستقلة قائمة بذاتها**: تملك llm/tools/registry/quota/session/storage — ليست جزءاً من المستضيف ولا من نواة P.
- **بوابة الصلاحيات** `AccessManager`: `checkCommand`/`checkTool` → EPERM عند `deniedTools`/`deniedCommands`؛ إنكار تلقائي عند غياب السياسة.
- **المجدول** `AgentScheduler`: RR (افتراضي) / serial، `submit/awaitDone/stats`.
- **عقد الأوامر** `AGENT_KERNEL_COMMANDS` (12): registry/access/quota/session/storage/engine/kernel + llm/tool/scheduler/models/health.
- **مسار التنفيذ**: `executeSyscall` → أثر (ensureAgent) → بوابة الصلاحيات → مسار سريع (إدارة) أو مجدول (بيانات).
- **attach(kernel)** يسجّل أوامر `agent.*` في نواة P؛ **registerEngine** يدير محركات (هيرمس/سنجبول/محرر/لانشر) كوحدات داخلية.
- `LLMCore` أُضيف له `availableModels()`/`health()` (إضافي آمن، لم يمس `mcp-*`).

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

> ⚠️ **ثغرة مفتوحة [CVE-internal] §5-0**: المسار الحاوي على `/` يتجاوز allowlist ويُقبل بفحص ELF فقط — `binaryPath` اعتباطي من `/api/launcher/*` (افتراضي `/bin/bash`). **أولوية قصوى.** الإصلاح: (أ) allowlist على `basename`، (ب) حظر المفسِّرات العامة (bash/sh/python/perl/node).

## 5. المكونات المترابطة

| الوحدة | الموقع | الحالة |
|---|---|---|
| هيرمس | `host/bootloader.ts` (HermesKernel) | **مربوطة** فعلياً (serve/learn/chat) |
| العقل الموجّه | `host/editor-manager.ts` + `host/lsp-adapter.ts` | **مربوطة** (اكتشاف 12 أداة + LSP) |
| كرة الثلج | `host/snowball/` | **مربوطة** (مسارات §7-1 عولجت) |
| اللانشر | `host/launcher/` | منقولة كما هي، معالجة مؤجلة §7 (ثغرة §5-0 أعلاه) |

## 6. التحقق

- `tsc --noEmit` نظيف · `npm test` **286/287** (الفاشل الوحيد بيئي: Firefox في `launch-desktop-command`).
- `tests/agent-kernel-upper.test.ts` — 17/17.
- **قيود بيئة التشغيل**: `bun test` يُسقط بتّات setuid (bun يُقنع `0o777`) — المرجع المعتمد **node/vitest** عبر `npm test`.
