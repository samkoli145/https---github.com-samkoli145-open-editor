# سجل التغييرات (Changelog)

> **تراكمي، لا يُعاد كتابته.** الأحدث أولاً. `PLAN.md` = مؤشر (index) + §8 سجل تجربة الطبقة الخامسة. الحالة الجارية في `docs/architecture.md`.
> بدأ النقل من أحدث نقطة زمنية (§6 في PLAN.md) دون إعادة كتابة التاريخ الأقدم.

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
