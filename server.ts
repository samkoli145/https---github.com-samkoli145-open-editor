import express from 'express';
import cors from 'cors';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import {
  bootNawat,
  PROFILES,
  LinuxArchExecutionLayer,
  PersistentIndexer,
  scanProject,
  bytesChecksum,
  createToken,
  localize,
  HermesAdapter,
  HermesKernel,
  LLMCore,
  DeterministicBackend,
  type LocalizedString,
  type Extension
} from './src/index';

const PORT = Number(process.env.PORT) || 3000;
// أمنياً: يُربط محلياً فقط (127.0.0.1) افتراضياً؛ يمكن تجاوزه بـ NAWAT_HOST لأغراض تطويرية.
const HOST = process.env.NAWAT_HOST || '127.0.0.1';
// مفتاح API إلزامي لكل /api — يُولَّد عشوائياً عند غياب NAWAT_API_KEY ويُطبع عند الإقلاع.
const API_KEY = process.env.NAWAT_API_KEY || randomBytes(24).toString('hex');
// جذور الفحص المسموحة — افتراضياً مجلد العمل الحالي فقط (بلا قراءة أي مسار مطلق على الجهاز).
const SCAN_ROOTS: string[] = (process.env.NAWAT_SCAN_ROOTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (SCAN_ROOTS.length === 0) {
  SCAN_ROOTS.push(process.cwd());
}

async function startServer() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Boot Kernel via Host Bootloader
  const bootResult = await bootNawat({ profile: 'editor' });
  if (!bootResult.isOk) {
    throw bootResult.error;
  }
  const runtime = bootResult.value;
  const kernel = runtime.kernel;
  const context = kernel.getContext();

  // LinuxArchExecutionLayer — تنفيذ أوامر أرش/ELF/سكربتات عبر بوابات النواة (عزل إلزامي داخل جذر المشروع)
  const archLayer = new LinuxArchExecutionLayer({ defaultAgentId: 'web-arch', execRoot: process.cwd() });

  // Middleware guard for API readiness
  app.use('/api', (_req, res, next) => {
    if (!runtime || runtime.getState() !== 'running') {
      return res.status(503).json({ error: 'Kernel not ready' });
    }
    next();
  });

  // المصادقة الإلزامية: كل مسار /api يتطلب X-API-Key (يمنع الوصول الشبكي الخارجي حتى لو رُبط على 0.0.0.0)
  app.use('/api', (req, res, next) => {
    if (req.path === '/health') {
      return next();
    }
    if (req.headers['x-api-key'] !== API_KEY) {
      return res.status(401).json({ error: 'E401: missing or invalid X-API-Key' });
    }
    next();
  });

  // سجل تدقيق (قرص/ذاكرة) للأفعال الحساسة
  const auditLog: Array<{ ts: number; action: string; detail: string }> = [];
  const audit = (action: string, detail: string): void => {
    const rec = { ts: Date.now(), action, detail };
    auditLog.push(rec);
    if (auditLog.length > 200) auditLog.shift();
    console.log(`[AUDIT] ${action}: ${detail}`);
  };

  // التحقق من أن الجذر المطلوب فحصه يقع ضمن جذور الفحص المسموحة
  const isAllowedScanRoot = (root: string): boolean => {
    const r = root.endsWith('/') ? root : `${root}/`;
    return SCAN_ROOTS.some((allowed) => {
      let ar: string;
      try {
        ar = realpathSync(allowed);
      } catch {
        return false;
      }
      const base = ar.endsWith('/') ? ar : `${ar}/`;
      return root === ar || root.startsWith(base);
    });
  };

// Register Default System Commands
context.commands.register({
  id: 'system.echo',
  title: { ar: 'طباعة النص', en: 'Echo Text' },
  category: { ar: 'النظام', en: 'System' },
  description: { ar: 'إعادة إرجاع الحمولة الممررة', en: 'Returns the provided payload' },
  handler: (payload) => payload ?? 'Hello from Nawat Kernel!'
});

context.commands.register({
  id: 'system.time',
  title: { ar: 'الوقت الحالي', en: 'Current Time' },
  category: { ar: 'النظام', en: 'System' },
  description: { ar: 'إرجاع التوقيت الحالي بتنسيق ISO وشامل الطوابع الزمنية', en: 'Returns current ISO timestamp and epoch ms' },
  handler: () => ({
    iso: new Date().toISOString(),
    timestamp: Date.now(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  })
});

context.commands.register({
  id: 'kernel.info',
  title: { ar: 'معلومات النواة', en: 'Kernel Information' },
  category: { ar: 'النواة', en: 'Kernel' },
  description: { ar: 'عرض حالة مكونات النواة والإحصائيات الحالية', en: 'Show state and statistics of all kernel modules' },
  handler: () => ({
    name: 'Nawat Kernel',
    version: '0.1.0',
    commandsCount: context.commands.list().length,
    activeExtensionsCount: context.extensions.getActiveCount(),
    eventsCount: context.events.recent().length,
    activeSchedulerCount: context.scheduler.getActiveCount()
  })
});

context.commands.register({
  id: 'i18n.translate',
  title: { ar: 'ترجمة نص موطّن', en: 'Translate Localized String' },
  category: { ar: 'التوطين', en: 'i18n' },
  description: { ar: 'اختبار دالة التوطين للغتين العربية والإنجليزية', en: 'Test localization for Arabic and English' },
  handler: (payload: any) => {
    const obj: LocalizedString = payload?.string || { ar: 'مرحباً بالنواة الذكية', en: 'Hello Smart Kernel' };
    const lang: 'ar' | 'en' = payload?.lang || 'ar';
    return {
      result: localize(obj, lang),
      original: obj,
      lang
    };
  }
});

// Register Default Core Service
const SYSTEM_INFO_TOKEN = createToken<{ appName: string; bootedAt: number }>('SystemInfoService');
context.services.register(SYSTEM_INFO_TOKEN, {
  appName: 'Nawat Kernel',
  bootedAt: Date.now()
});

// Default Extension
const demoExtension: Extension = {
  id: 'ext.analytics',
  name: { ar: 'إضافة التحليلات', en: 'Analytics Extension' },
  version: '1.0.0',
  activate: () => {
    context.events.emit('extension:activated', { id: 'ext.analytics', time: Date.now() });
  },
  deactivate: () => {
    context.events.emit('extension:deactivated', { id: 'ext.analytics', time: Date.now() });
  }
};
await context.extensions.activate(demoExtension);

// REST API Endpoints

// Health Check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    kernelReady: true,
    runtimeState: runtime.getState(),
    timestamp: Date.now(),
    uptimeSeconds: process.uptime()
  });
});

// Kernel Status
app.get('/api/kernel', (_req, res) => {
  res.json({
    isReady: true,
    profile: runtime.profile.name,
    runtimeState: runtime.getState(),
    metrics: runtime.getMetrics(),
    bootedAt: context.services.get(SYSTEM_INFO_TOKEN).isOk
      ? (context.services.get(SYSTEM_INFO_TOKEN) as any).value.bootedAt
      : null,
    commandsCount: context.commands.list().length,
    activeExtensionsCount: context.extensions.getActiveCount(),
    activeSchedulerCount: context.scheduler.getActiveCount(),
    recentEventsCount: context.events.recent().length,
    handlerErrorsCount: context.events.getHandlerErrors().length
  });
});

// Host Bootloader Status
app.get('/api/host', (_req, res) => {
  res.json({
    profile: runtime.profile,
    profilesAvailable: Object.values(PROFILES),
    runtimeState: runtime.getState(),
    metrics: runtime.getMetrics()
  });
});

// Commands
app.get('/api/commands', (_req, res) => {
  const commands = context.commands.list().map(cmd => ({
    id: cmd.id,
    title: cmd.title,
    category: cmd.category,
    description: cmd.description,
    shortcut: cmd.shortcut
  }));
  res.json({
    commands,
    executionLog: context.commands.getLog()
  });
});

app.post('/api/commands/execute', async (req, res) => {
  const { id, payload } = req.body;
  if (!id) {
    return res.status(400).json({ error: 'Command id is required' });
  }
  const result = await context.commands.execute(id, payload);
  if (result.isOk) {
    return res.json({ success: true, value: result.value });
  } else {
    return res.status(400).json({ success: false, error: result.error.message });
  }
});

app.post('/api/commands/register', (req, res) => {
  const { id, titleAr, titleEn, categoryAr, categoryEn, descriptionAr, descriptionEn, responseText } = req.body;
  if (!id || !titleAr || !titleEn) {
    return res.status(400).json({ error: 'id, titleAr, titleEn are required' });
  }
  try {
    context.commands.register({
      id,
      title: { ar: titleAr, en: titleEn },
      category: { ar: categoryAr || 'مخصص', en: categoryEn || 'Custom' },
      description: { ar: descriptionAr || '', en: descriptionEn || '' },
      handler: (p) => ({
        output: responseText || `Command ${id} executed successfully.`,
        payload: p,
        executedAt: new Date().toISOString()
      })
    });
    context.events.emit('command:registered', { id, timestamp: Date.now() });
    res.json({ success: true, message: `Command ${id} registered.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Events
app.get('/api/events', (_req, res) => {
  res.json({
    history: context.events.recent(),
    handlerErrors: context.events.getHandlerErrors()
  });
});

app.post('/api/events/emit', (req, res) => {
  const { name, payload } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Event name is required' });
  }
  context.events.emit(name, payload ?? {});
  res.json({ success: true, message: `Event '${name}' emitted.` });
});

// Services
app.get('/api/services', (_req, res) => {
  res.json({
    systemInfo: context.services.get(SYSTEM_INFO_TOKEN).isOk
      ? (context.services.get(SYSTEM_INFO_TOKEN) as any).value
      : null
  });
});

// Extensions
app.get('/api/extensions', (_req, res) => {
  res.json({
    activeCount: context.extensions.getActiveCount(),
    extensions: context.extensions.list().map(ext => ({
      id: ext.id,
      name: ext.name,
      version: ext.version
    }))
  });
});

app.post('/api/extensions/activate', async (req, res) => {
  const { id, nameAr, nameEn, version } = req.body;
  if (!id) return res.status(400).json({ error: 'Extension id required' });
  
  const ext: Extension = {
    id,
    name: { ar: nameAr || id, en: nameEn || id },
    version: version || '1.0.0',
    activate: () => {
      context.events.emit('extension:activated', { id, time: Date.now() });
    },
    deactivate: () => {
      context.events.emit('extension:deactivated', { id, time: Date.now() });
    }
  };
  
  const result = await context.extensions.activate(ext);
  if (result.isOk) {
    res.json({ success: true, message: `Extension ${id} activated.` });
  } else {
    res.status(400).json({ error: result.error.message });
  }
});

app.post('/api/extensions/deactivate', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Extension id required' });
  const result = await context.extensions.deactivate(id);
  if (result.isOk) {
    res.json({ success: true, message: `Extension ${id} deactivated.` });
  } else {
    res.status(400).json({ error: result.error.message });
  }
});

// Scheduler
app.get('/api/scheduler', (_req, res) => {
  res.json({
    activeTimersCount: context.scheduler.getActiveCount()
  });
});

app.post('/api/scheduler/debounce', (req, res) => {
  const { taskId, ms, eventPayload } = req.body;
  if (!taskId || !ms) return res.status(400).json({ error: 'taskId and ms required' });

  context.scheduler.debounce({
    id: taskId,
    run: () => {
      context.events.emit('scheduler:task_executed', { taskId, type: 'debounce', payload: eventPayload, time: Date.now() });
    }
  }, Number(ms));

  res.json({ success: true, message: `Debounce task '${taskId}' scheduled for ${ms}ms` });
});

// LinuxArchExecutionLayer — تنفيذ أوامر أرش/ELF عبر بوابات النواة
app.post('/api/arch/execute', async (req, res) => {
  const { commandLine, cwd, timeoutMs, agentId } = req.body ?? {};
  if (!commandLine || typeof commandLine !== 'string' || !commandLine.trim()) {
    return res.status(400).json({ error: 'commandLine (string) is required' });
  }
  const result = await archLayer.execute({
    commandLine,
    cwd: typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined,
    timeoutMs: timeoutMs != null ? Number(timeoutMs) : undefined,
    agentId: typeof agentId === 'string' && agentId ? agentId : undefined
  });
  audit('arch.execute', `command='${commandLine}' verdict=${result.verdict} status=${result.status}`);

  // إشعار EventBus لكل تنفيذ أرش (قبول/رفض) — يظهر في سجل اللوحة
  context.events.emit('arch:command_executed', {
    commandLine,
    verdict: result.verdict,
    status: result.status,
    exitCode: result.exitCode,
    executionTimeMs: result.executionTimeMs,
    timestamp: Date.now()
  });

  res.json({
    command: result.command,
    status: result.status,
    verdict: result.verdict,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    executionTimeMs: result.executionTimeMs,
    reason: result.reason,
    warnings: result.warnings,
    quota: result.quota,
    summary: result.summary
  });
});

app.get('/api/arch/history', (_req, res) => {
  const records = archLayer.getRecords();
  res.json({ count: records.length, records: records.reverse().slice(0, 50) });
});

app.get('/api/arch/status', (_req, res) => {
  const usage = archLayer.getQuotaGuard().getUsage('web-arch');
  res.json({ enabled: true, defaultAgentId: 'web-arch', syscallCount: usage.syscallCount, errorCount: usage.errorCount });
});

// OpenAI-Compatible Chat Completions & Hermes Integration
app.post('/api/v1/chat/completions', async (req, res) => {
  try {
    const { model = 'hermes-3-llama-3.1-8b', messages } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const lastMessage = messages[messages.length - 1];
    const userPrompt = lastMessage?.content || 'Hello';

    let content: string;
    const hermesInstance: HermesKernel = runtime.hermes?.hermesKernel || new HermesKernel();
    const serveRes = await hermesInstance.serve(userPrompt);
    if (serveRes.isOk) {
      content = serveRes.value.result !== undefined
        ? String(serveRes.value.result)
        : `Hermes executed: ${userPrompt}`;
    } else {
      // Fallback عبر LLMCore الحقيقي (chat — لا generateResponse)
      const llm = runtime.agentKernel?.llmCore ||
        new LLMCore({ backends: [new DeterministicBackend()] });
      const llmRes = await llm.chat([{ role: 'user', content: userPrompt }]);
      content = llmRes.isOk ? llmRes.value.content : `Response to: ${userPrompt}`;
    }

    const response = HermesAdapter.formatOpenAIResponse(model, content);
    audit('hermes.chat.completions', `model='${model}' prompt='${userPrompt}'`);
    res.json(response);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to process completion' });
  }
});

app.post('/api/hermes/serve', async (req, res) => {
  const { input, toolName, toolArgs } = req.body ?? {};
  if (!input) return res.status(400).json({ error: 'input string required' });
  const hermesInstance: HermesKernel = runtime.hermes?.hermesKernel || new HermesKernel();
  const result = await hermesInstance.serve(input, toolName, toolArgs);
  if (result.isOk) {
    res.json({ success: true, data: result.value });
  } else {
    res.status(400).json({ success: false, error: result.error.message });
  }
});

app.post('/api/hermes/train', async (req, res) => {
  const { topic, title, content, sessionId = 'web-session' } = req.body ?? {};
  if (!topic && !content) return res.status(400).json({ error: 'topic or content required' });
  const hermesInstance: HermesKernel = runtime.hermes?.hermesKernel || new HermesKernel();
  const text = content || topic;
  const result = await hermesInstance.learn({
    sessionId,
    materials: [{
      id: `mat_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: 'fact',
      content: `${title ? title + ': ' : ''}${text}`,
      priority: 'normal'
    }]
  });
  if (result.isOk) {
    audit('hermes.train', `session='${sessionId}' material='${title || topic}'`);
    res.json({ success: true, report: result.value });
  } else {
    res.status(400).json({ success: false, error: result.error.message });
  }
});

app.get('/api/audit', (_req, res) => {
  res.json({ count: auditLog.length, records: auditLog.slice().reverse() });
});

// Project Scanner — فحص مجلد مشروع خارجي: مخفي/قابل تنفيذ/backdoor/هروب/مزروع/معبث
app.post('/api/projects/scan', (req, res) => {
  const { root, registered } = req.body ?? {};
  if (!root || typeof root !== 'string' || !root.trim()) {
    return res.status(400).json({ error: 'root (absolute project path) is required' });
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root.trim());
  } catch {
    return res.status(400).json({ error: `root does not exist: ${root}` });
  }

  if (!isAllowedScanRoot(realRoot)) {
    audit('projects.scan.denied', `root='${realRoot}' (outside allowed roots)`);
    return res.status(403).json({
      error: `E403: root is not within allowed scan roots: ${SCAN_ROOTS.join(', ')}`
    });
  }

  audit('projects.scan', `root='${realRoot}'`);

  let indexer: PersistentIndexer | undefined;
  const baselinePath = path.join(realRoot, '.nawat-index.json');
  if (Array.isArray(registered) && registered.length > 0) {
    indexer = new PersistentIndexer(realRoot);
    for (const item of registered) {
      const rel = typeof item === 'string' ? item : item?.path;
      if (typeof rel !== 'string') continue;
      const abs = path.join(realRoot, rel);
      try {
        const st = statSync(abs);
        if (!st.isDirectory()) {
          const buf = readFileSync(abs);
          // بصمة المعيار المزروعة من العميل إن حُدّدت، وإلا SHA-256 حقيقي للمحتوى الحالي
          const baselineSum = typeof item === 'object' && typeof item.checksum === 'string'
            ? item.checksum
            : bytesChecksum(buf);
          indexer.registerFile(rel, buf, baselineSum);
        }
      } catch {
        // ignore missing baseline file during registration
      }
    }
  } else if (existsSync(baselinePath)) {
    // خط أساس دائم من فحص سابق (يُحمَّل عبر مُنشئ PersistentIndexer من `.nawat-index.json`)
    indexer = new PersistentIndexer(realRoot);
  }

  const report = scanProject(realRoot, indexer);
  // احفظ الخط الأساس للمسح الحالي كخط أساس دائم للمسوح القادمة
  indexer?.syncToDisk();
  res.json(report);
});

// Web UI Dashboard Endpoint
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>نظام تشغيل نواة المطور — Nawat Web OS Station</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Alexandria:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Alexandria', sans-serif; }
    code, pre { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="bg-slate-100 text-slate-800 min-h-screen flex flex-col selection:bg-emerald-100 selection:text-emerald-900">

  <!-- KDE Breeze Header Window Toolbar -->
  <header class="border-b border-slate-200 bg-slate-100/90 backdrop-blur sticky top-0 z-40 shadow-xs">
    <div class="max-w-7xl mx-auto px-4 py-2 flex flex-wrap items-center justify-between gap-3">
      
      <!-- Dolphin Window Controls & Breadcrumbs -->
      <div class="flex items-center gap-2 text-xs text-slate-700">
        <button onclick="toggleLauncherMenu()" class="w-8 h-8 rounded-lg bg-emerald-600 hover:bg-emerald-700 flex items-center justify-center font-bold text-white text-base shadow-xs transition active:scale-95" title="قائمة البرامج والنظام (KDE Kickoff Launcher)">
          ن
        </button>
        <div class="flex items-center gap-1 bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-slate-600 shadow-2xs font-mono">
          <span class="text-slate-400">&lt;</span>
          <span class="text-slate-400">&gt;</span>
          <span class="text-slate-300 px-1">|</span>
          <span class="text-emerald-700 font-bold">projects</span>
          <span class="text-slate-400">&gt;</span>
          <span class="text-slate-700 font-medium">00</span>
          <span class="text-slate-400">&gt;</span>
          <span class="text-slate-900 font-semibold truncate max-w-[200px]">github-open-editor — Dolphin</span>
        </div>
      </div>

      <!-- Window Actions & Live Clock -->
      <div class="flex items-center gap-2">
        <div id="os-clock" class="hidden sm:block text-xs font-mono font-semibold px-2.5 py-1 rounded-md bg-white text-slate-700 border border-slate-200 shadow-2xs">
          --:--:--
        </div>

        <div id="status-badge" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
          <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span>النواة نشطة (Booted)</span>
        </div>

        <button id="power-btn" onclick="toggleKernelPower()" class="px-2.5 py-1 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold transition flex items-center gap-1 shadow-2xs">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
          <span id="power-btn-text">Shutdown</span>
        </button>

        <div class="flex items-center gap-1 text-slate-400 border-r border-slate-300 pr-2 mr-1">
          <span class="hover:text-slate-700 cursor-pointer text-xs font-bold px-1">_</span>
          <span class="hover:text-slate-700 cursor-pointer text-xs font-bold px-1">□</span>
          <span class="hover:text-rose-600 cursor-pointer text-xs font-bold px-1">✕</span>
        </div>
      </div>

    </div>
  </header>

  <!-- KDE Kickoff Start Menu Drawer (Pop-up Launcher Modal) -->
  <div id="kickoff-menu" class="hidden fixed bottom-14 right-4 z-50 w-full max-w-2xl bg-white/98 backdrop-blur-md rounded-2xl border border-slate-300 shadow-2xl p-4 space-y-3 transition-all duration-200">
    <!-- Top Search Input -->
    <div class="relative">
      <input type="text" id="kickoff-search" onkeyup="filterKickoffApps()" placeholder="Search..." class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 pl-10 text-xs text-slate-800 focus:bg-white focus:outline-none focus:border-emerald-600 font-mono shadow-inner" />
      <span class="absolute left-3.5 top-3 text-slate-400 text-xs">🔍</span>
    </div>

    <div class="grid grid-cols-3 gap-3 min-h-[320px]">
      <!-- Left Category Sidebar -->
      <div class="col-span-1 border-l border-slate-100 pl-2 space-y-1 text-xs font-medium text-slate-600">
        <button onclick="selectKickoffCategory('all')" class="w-full text-right px-3 py-2 rounded-lg bg-emerald-50 text-emerald-800 font-bold flex items-center justify-between">
          <span>All Applications</span>
          <span>📱</span>
        </button>
        <button onclick="selectKickoffCategory('dev')" class="w-full text-right px-3 py-2 rounded-lg hover:bg-slate-100 flex items-center justify-between">
          <span>Development</span>
          <span>💻</span>
        </button>
        <button onclick="selectKickoffCategory('system')" class="w-full text-right px-3 py-2 rounded-lg hover:bg-slate-100 flex items-center justify-between">
          <span>System Tools</span>
          <span>🛠️</span>
        </button>
        <button onclick="selectKickoffCategory('security')" class="w-full text-right px-3 py-2 rounded-lg hover:bg-slate-100 flex items-center justify-between">
          <span>Security</span>
          <span>🛡️</span>
        </button>
        <button onclick="selectKickoffCategory('utilities')" class="w-full text-right px-3 py-2 rounded-lg hover:bg-slate-100 flex items-center justify-between">
          <span>Utilities</span>
          <span>🧰</span>
        </button>
        <button onclick="selectKickoffCategory('help')" class="w-full text-right px-3 py-2 rounded-lg hover:bg-slate-100 flex items-center justify-between">
          <span>Help & Docs</span>
          <span>📖</span>
        </button>
      </div>

      <!-- Right App Items Pane -->
      <div class="col-span-2 space-y-1.5 max-h-[300px] overflow-y-auto pr-1" id="kickoff-app-list">
        <div onclick="launchApp('dolphin')" class="p-2.5 rounded-xl bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 cursor-pointer transition flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-sky-100 text-sky-700 flex items-center justify-center font-bold text-base">📁</div>
          <div>
            <div class="text-xs font-bold text-slate-800">Dolphin File Manager</div>
            <div class="text-[11px] text-slate-500">Browse project files and directory tree</div>
          </div>
        </div>

        <div onclick="launchApp('arch')" class="p-2.5 rounded-xl bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 cursor-pointer transition flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold text-base">💻</div>
          <div>
            <div class="text-xs font-bold text-slate-800">Arch Execution Layer</div>
            <div class="text-[11px] text-slate-500">POSIX Command Enforcer & ELF Verification</div>
          </div>
        </div>

        <div onclick="launchApp('commands')" class="p-2.5 rounded-xl bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 cursor-pointer transition flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-amber-100 text-amber-800 flex items-center justify-center font-bold text-base">⚡</div>
          <div>
            <div class="text-xs font-bold text-slate-800">Commands Registry</div>
            <div class="text-[11px] text-slate-500">Register and execute kernel command handlers</div>
          </div>
        </div>

        <div onclick="launchApp('scan')" class="p-2.5 rounded-xl bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 cursor-pointer transition flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-800 flex items-center justify-center font-bold text-base">🛡️</div>
          <div>
            <div class="text-xs font-bold text-slate-800">Security Project Scanner</div>
            <div class="text-[11px] text-slate-500">Scan project files for unicode exploits</div>
          </div>
        </div>

        <div onclick="launchApp('extensions')" class="p-2.5 rounded-xl bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 cursor-pointer transition flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-purple-100 text-purple-800 flex items-center justify-center font-bold text-base">🧩</div>
          <div>
            <div class="text-xs font-bold text-slate-800">Extensions Manager</div>
            <div class="text-[11px] text-slate-500">Enable and configure kernel extensions</div>
          </div>
        </div>

        <div onclick="launchApp('events')" class="p-2.5 rounded-xl bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 cursor-pointer transition flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-teal-100 text-teal-800 flex items-center justify-center font-bold text-base">📡</div>
          <div>
            <div class="text-xs font-bold text-slate-800">EventBus Console</div>
            <div class="text-[11px] text-slate-500">Emit and monitor system events</div>
          </div>
        </div>

        <div onclick="launchApp('help')" class="p-2.5 rounded-xl bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 cursor-pointer transition flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-slate-200 text-slate-800 flex items-center justify-center font-bold text-base">📖</div>
          <div>
            <div class="text-xs font-bold text-slate-800">Help & User Manual</div>
            <div class="text-[11px] text-slate-500">Operating guide and documentation</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Kickoff Bottom Control Bar -->
    <div class="border-t border-slate-200 pt-2.5 flex items-center justify-between text-xs font-medium text-slate-600">
      <div class="flex items-center gap-3">
        <button class="px-3 py-1 rounded-lg bg-emerald-50 text-emerald-700 font-bold">Applications</button>
        <button onclick="launchApp('dolphin')" class="hover:text-slate-900">Places</button>
      </div>
      <div class="flex items-center gap-2">
        <button onclick="toggleKernelPower()" class="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold flex items-center gap-1">
          <span>Restart</span>
        </button>
        <button onclick="toggleKernelPower()" class="px-3 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 text-xs font-bold flex items-center gap-1">
          <span>Shut Down</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Main Desktop Canvas -->
  <main class="max-w-7xl mx-auto px-4 py-4 flex-grow w-full space-y-4 mb-16">

    <!-- Top System Metrics Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="p-3.5 rounded-xl bg-white border border-slate-200 shadow-xs flex items-center justify-between">
        <div>
          <div class="text-xs text-slate-500 font-medium">الأوامر المسجلة</div>
          <div id="metric-commands" class="text-xl font-bold text-slate-900 font-mono mt-0.5">0</div>
        </div>
        <div class="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center justify-center font-bold text-base">⚡</div>
      </div>
      <div class="p-3.5 rounded-xl bg-white border border-slate-200 shadow-xs flex items-center justify-between">
        <div>
          <div class="text-xs text-slate-500 font-medium">الأحداث الممررة</div>
          <div id="metric-events" class="text-xl font-bold text-teal-700 font-mono mt-0.5">0</div>
        </div>
        <div class="w-9 h-9 rounded-xl bg-teal-50 text-teal-600 border border-teal-100 flex items-center justify-center font-bold text-base">📡</div>
      </div>
      <div class="p-3.5 rounded-xl bg-white border border-slate-200 shadow-xs flex items-center justify-between">
        <div>
          <div class="text-xs text-slate-500 font-medium">الإضافات النشطة</div>
          <div id="metric-extensions" class="text-xl font-bold text-indigo-700 font-mono mt-0.5">0</div>
        </div>
        <div class="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100 flex items-center justify-center font-bold text-base">🧩</div>
      </div>
      <div class="p-3.5 rounded-xl bg-white border border-slate-200 shadow-xs flex items-center justify-between">
        <div>
          <div class="text-xs text-slate-500 font-medium">المؤقتات والجدولة</div>
          <div id="metric-scheduler" class="text-xl font-bold text-amber-700 font-mono mt-0.5">0</div>
        </div>
        <div class="w-9 h-9 rounded-xl bg-amber-50 text-amber-600 border border-amber-100 flex items-center justify-center font-bold text-base">⏱️</div>
      </div>
    </div>

    <!-- TAB 0: Dolphin File Manager (Default View) -->
    <div id="view-dolphin" class="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
      <!-- Dolphin Toolbar Header -->
      <div class="bg-slate-50 p-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div class="flex items-center gap-2">
          <span class="font-bold text-slate-800 flex items-center gap-1">
            <span class="text-sky-600 text-base">📁</span> Dolphin File Browser
          </span>
          <span class="text-slate-400">|</span>
          <div class="bg-white border border-slate-200 rounded-lg px-3 py-1 font-mono text-slate-600 flex items-center gap-1.5 shadow-2xs">
            <span class="text-slate-400">/</span>
            <span>projects</span>
            <span class="text-slate-400">/</span>
            <span>00</span>
            <span class="text-slate-400">/</span>
            <span class="text-emerald-700 font-semibold">nawat-os-kernel</span>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <button class="px-2.5 py-1 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg text-slate-700 font-semibold flex items-center gap-1 shadow-2xs">
            <span>Split View</span>
          </button>
          <input type="text" placeholder="Search files..." class="bg-white border border-slate-200 rounded-lg px-2.5 py-1 text-xs text-slate-800 focus:outline-none focus:border-emerald-600" />
        </div>
      </div>

      <!-- Dolphin Main Explorer Area -->
      <div class="grid grid-cols-1 md:grid-cols-4 min-h-[380px]">
        <!-- Left Places Sidebar -->
        <div class="col-span-1 bg-slate-50/70 border-l border-slate-200 p-3 space-y-3">
          <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-2">Places</div>
          <div class="space-y-1 text-xs font-medium text-slate-700">
            <div class="px-2.5 py-2 rounded-lg bg-sky-100/70 text-sky-900 font-bold flex items-center gap-2">
              <span>🏠</span> Home
            </div>
            <div class="px-2.5 py-2 rounded-lg hover:bg-slate-200/60 flex items-center gap-2 cursor-pointer">
              <span>🖥️</span> Desktop
            </div>
            <div class="px-2.5 py-2 rounded-lg hover:bg-slate-200/60 flex items-center gap-2 cursor-pointer">
              <span>📄</span> Documents
            </div>
            <div class="px-2.5 py-2 rounded-lg hover:bg-slate-200/60 flex items-center gap-2 cursor-pointer">
              <span>⬇️</span> Downloads
            </div>
            <div class="px-2.5 py-2 rounded-lg hover:bg-slate-200/60 flex items-center gap-2 cursor-pointer">
              <span>📂</span> Projects
            </div>
          </div>

          <div class="border-t border-slate-200 pt-3">
            <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-2 mb-1">Kernel Shortcuts</div>
            <div class="space-y-1 text-xs font-medium text-slate-700">
              <div onclick="switchTab('arch')" class="px-2.5 py-1.5 rounded-lg hover:bg-emerald-50 text-emerald-800 flex items-center gap-2 cursor-pointer">
                <span>💻</span> Arch Layer
              </div>
              <div onclick="switchTab('scan')" class="px-2.5 py-1.5 rounded-lg hover:bg-indigo-50 text-indigo-800 flex items-center gap-2 cursor-pointer">
                <span>🛡️</span> Security Scanner
              </div>
            </div>
          </div>
        </div>

        <!-- Right Directory File Icons Grid -->
        <div class="col-span-3 p-5">
          <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            <!-- Folder Items -->
            <div onclick="alert('فتح المجلد bin')" class="p-3 rounded-xl border border-slate-200 hover:border-sky-300 hover:bg-sky-50/50 cursor-pointer transition text-center space-y-1.5 group">
              <div class="w-12 h-12 mx-auto bg-sky-100 rounded-xl flex items-center justify-center text-2xl group-hover:scale-105 transition">📁</div>
              <div class="text-xs font-bold text-slate-800 font-mono">bin</div>
            </div>

            <div onclick="alert('فتح المجلد src')" class="p-3 rounded-xl border border-slate-200 hover:border-sky-300 hover:bg-sky-50/50 cursor-pointer transition text-center space-y-1.5 group">
              <div class="w-12 h-12 mx-auto bg-sky-100 rounded-xl flex items-center justify-center text-2xl group-hover:scale-105 transition">📁</div>
              <div class="text-xs font-bold text-slate-800 font-mono">src</div>
            </div>

            <div onclick="alert('فتح المجلد tests')" class="p-3 rounded-xl border border-slate-200 hover:border-sky-300 hover:bg-sky-50/50 cursor-pointer transition text-center space-y-1.5 group">
              <div class="w-12 h-12 mx-auto bg-sky-100 rounded-xl flex items-center justify-center text-2xl group-hover:scale-105 transition">📁</div>
              <div class="text-xs font-bold text-slate-800 font-mono">tests</div>
            </div>

            <!-- Core Code File Items (Matching Purple Badge in KDE Dolphin image) -->
            <div onclick="switchTab('arch')" class="p-3 rounded-xl border border-slate-200 hover:border-purple-300 hover:bg-purple-50/50 cursor-pointer transition text-center space-y-1.5 group">
              <div class="w-12 h-12 mx-auto bg-purple-100 rounded-xl flex items-center justify-center text-purple-700 font-bold text-lg group-hover:scale-105 transition">{}</div>
              <div class="text-xs font-semibold text-slate-800 font-mono">server.ts</div>
            </div>

            <div onclick="alert('ملف تهيئة المخرجات metadata.json')" class="p-3 rounded-xl border border-slate-200 hover:border-purple-300 hover:bg-purple-50/50 cursor-pointer transition text-center space-y-1.5 group">
              <div class="w-12 h-12 mx-auto bg-purple-100 rounded-xl flex items-center justify-center text-purple-700 font-bold text-lg group-hover:scale-105 transition">{}</div>
              <div class="text-xs font-semibold text-slate-800 font-mono">metadata.json</div>
            </div>

            <div onclick="alert('ملف الحزم package.json')" class="p-3 rounded-xl border border-slate-200 hover:border-purple-300 hover:bg-purple-50/50 cursor-pointer transition text-center space-y-1.5 group">
              <div class="w-12 h-12 mx-auto bg-purple-100 rounded-xl flex items-center justify-center text-purple-700 font-bold text-lg group-hover:scale-105 transition">{}</div>
              <div class="text-xs font-semibold text-slate-800 font-mono">package.json</div>
            </div>

            <div onclick="alert('ملف الإعدادات tsconfig.json')" class="p-3 rounded-xl border border-slate-200 hover:border-purple-300 hover:bg-purple-50/50 cursor-pointer transition text-center space-y-1.5 group">
              <div class="w-12 h-12 mx-auto bg-purple-100 rounded-xl flex items-center justify-center text-purple-700 font-bold text-lg group-hover:scale-105 transition">{}</div>
              <div class="text-xs font-semibold text-slate-800 font-mono">tsconfig.json</div>
            </div>

            <div onclick="switchTab('help')" class="p-3 rounded-xl border border-slate-200 hover:border-emerald-300 hover:bg-emerald-50/50 cursor-pointer transition text-center space-y-1.5 group">
              <div class="w-12 h-12 mx-auto bg-emerald-100 rounded-xl flex items-center justify-center text-emerald-700 font-bold text-lg group-hover:scale-105 transition">📖</div>
              <div class="text-xs font-semibold text-slate-800 font-mono">kernel.md</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Application Launcher Bar (KDE / Android PC style) -->
    <div id="launcher-bar" class="bg-white rounded-xl border border-slate-200 shadow-xs p-3.5 space-y-2">
      <div class="flex items-center justify-between px-1">
        <div class="text-xs font-bold text-slate-700 flex items-center gap-1.5">
          <svg class="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/></svg>
          <span>قائمة برامج وتطبيقات النواة (Kernel Application Launcher)</span>
        </div>
        <span class="text-[11px] text-slate-400 font-mono">Select App to Open</span>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-2">
        <button onclick="switchTab('arch')" id="tab-arch" class="p-2.5 rounded-lg border text-right transition flex flex-col items-center justify-center text-center gap-1 bg-emerald-50 border-emerald-300 text-emerald-800 font-bold shadow-xs">
          <span class="text-lg">💻</span>
          <span class="text-xs">منفذ Arch</span>
        </button>

        <button onclick="switchTab('commands')" id="tab-commands" class="p-2.5 rounded-lg border text-right transition flex flex-col items-center justify-center text-center gap-1 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span class="text-lg">⚡</span>
          <span class="text-xs">الأوامر</span>
        </button>

        <button onclick="switchTab('scan')" id="tab-scan" class="p-2.5 rounded-lg border text-right transition flex flex-col items-center justify-center text-center gap-1 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span class="text-lg">🛡️</span>
          <span class="text-xs">الفاحص الأمني</span>
        </button>

        <button onclick="switchTab('extensions')" id="tab-extensions" class="p-2.5 rounded-lg border text-right transition flex flex-col items-center justify-center text-center gap-1 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span class="text-lg">🧩</span>
          <span class="text-xs">الإضافات</span>
        </button>

        <button onclick="switchTab('events')" id="tab-events" class="p-2.5 rounded-lg border text-right transition flex flex-col items-center justify-center text-center gap-1 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span class="text-lg">📡</span>
          <span class="text-xs">الأحداث</span>
        </button>

        <button onclick="switchTab('scheduler')" id="tab-scheduler" class="p-2.5 rounded-lg border text-right transition flex flex-col items-center justify-center text-center gap-1 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span class="text-lg">⏱️</span>
          <span class="text-xs">الجدولة</span>
        </button>

        <button onclick="switchTab('i18n')" id="tab-i18n" class="p-2.5 rounded-lg border text-right transition flex flex-col items-center justify-center text-center gap-1 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span class="text-lg">🌐</span>
          <span class="text-xs">التوطين i18n</span>
        </button>

        <button onclick="switchTab('help')" id="tab-help" class="p-2.5 rounded-lg border text-right transition flex flex-col items-center justify-center text-center gap-1 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span class="text-lg">📖</span>
          <span class="text-xs">الدليل والمساعدة</span>
        </button>
      </div>
    </div>

    <!-- WINDOW WORKSPACE VIEWS -->

    <!-- TAB 1: Arch Layer Exec -->
    <div id="view-arch" class="space-y-4">
      <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-4">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <h2 class="text-sm font-bold text-slate-900 flex items-center gap-2">
            <span class="text-base">💻</span> منفذ أوامر النواة (LinuxArchExecutionLayer)
          </h2>
          <span class="text-[11px] bg-emerald-50 text-emerald-800 px-2.5 py-0.5 rounded-full font-mono border border-emerald-200">POSIX & ELF Safety Enforcer</span>
        </div>
        <p class="text-xs text-slate-600 leading-relaxed">
          تشغيل أوامر النظام والمشاريع من خلال النواة مع التحقق المزدوج من صيغة ELF وسلسلة الأوامر المسموحة وحماية TOCTOU.
        </p>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div class="md:col-span-2">
            <label class="block text-xs font-semibold text-slate-700 mb-1">سطر الأمر (commandLine)</label>
            <input type="text" id="arch-command" value="echo hello-nawat-kernel" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 focus:bg-white focus:outline-none focus:border-emerald-600" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1">المهلة (timeoutMs)</label>
            <input type="number" id="arch-timeout" value="10000" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 focus:bg-white focus:outline-none focus:border-emerald-600" />
          </div>
        </div>

        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">مسار مجلد العمل (cwd - اختياري)</label>
          <input type="text" id="arch-cwd" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 focus:bg-white focus:outline-none focus:border-emerald-600" placeholder="مثال: /home/user/project" />
        </div>

        <button onclick="executeArch()" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs transition shadow-xs flex items-center justify-center gap-2">
          <span>تنفيذ عبر النواة الأرشية</span>
        </button>

        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">مخرجات التنفيذ (Execution Console Light Output)</label>
          <pre id="arch-result" class="p-3 bg-slate-50 rounded-lg text-xs font-mono text-slate-800 border border-slate-300 min-h-[120px] max-h-[260px] overflow-auto whitespace-pre-wrap">لم يتم تنفيذ أي أمر بعد.</pre>
        </div>
      </div>

      <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
        <h3 class="text-xs font-bold text-slate-800 flex items-center gap-2">
          <span>📜</span> سجل التدقيق والتنفيذ المباشر (Audit Logs)
        </h3>
        <div id="arch-history" class="space-y-2 max-h-[220px] overflow-y-auto font-mono text-[11px]">
          <div class="text-slate-400">لا يوجد سجل تنفيذي بعد.</div>
        </div>
      </div>
    </div>

    <!-- TAB 2: Commands -->
    <div id="view-commands" class="hidden space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="md:col-span-1 bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-xs font-bold text-slate-900">سجل الأوامر المتاحة</h2>
            <button onclick="showRegisterModal()" class="text-xs px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 font-bold">+ أمر جديد</button>
          </div>
          <div id="command-list" class="space-y-2 max-h-[420px] overflow-y-auto pr-1">
            <div class="text-xs text-slate-400">جاري التحميل...</div>
          </div>
        </div>

        <div class="md:col-span-2 bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
          <h2 class="text-xs font-bold text-slate-900">مشغّل الأوامر برمجياً (Command Execution Window)</h2>
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1">الأمر المختار</label>
            <input type="text" id="exec-command-id" readonly class="w-full bg-slate-100 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-emerald-700 font-bold" placeholder="اختر أمراً من القائمة..." />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1">المعطيات (Payload JSON)</label>
            <textarea id="exec-payload" rows="3" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-800 focus:bg-white focus:outline-none focus:border-emerald-600" placeholder='{"key": "value"}'></textarea>
          </div>
          <button onclick="executeCommand()" class="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs transition">تنفيذ الأمر المختار</button>
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1">النتيجة</label>
            <pre id="exec-result" class="p-3 bg-slate-50 rounded-lg text-xs font-mono text-slate-800 border border-slate-300 min-h-[100px] overflow-auto">لم يتم تنفيذ أي أمر بعد.</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 3: Project Scanner -->
    <div id="view-scan" class="hidden space-y-4">
      <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-4">
        <h2 class="text-sm font-bold text-slate-900 flex items-center gap-2">
          <span>🛡️</span> فاحص المشاريع الخارجي والأمن (Security Project Scanner)
        </h2>
        <p class="text-xs text-slate-600">
          فحص مجلدات وتراكيب الأكواد للكشف عن أي ملفات مخفية بأحرف غير مرئية، أو ملفات تنفيذية مشبوهة، أو ثغرات الروابط الخرجية.
        </p>

        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">مسار المشروع المطلق (Root Directory)</label>
          <input type="text" id="scan-root" value="${process.cwd()}" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 focus:bg-white focus:outline-none focus:border-emerald-600" />
        </div>

        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">قائمة خط الأساس للمقارنة (مفصولة بفاصلة)</label>
          <input type="text" id="scan-registered" value="src/main.py,README.md" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 focus:bg-white focus:outline-none focus:border-emerald-600" />
        </div>

        <button onclick="runScan()" class="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg text-xs transition">بدء الفحص الأمني للمشروع</button>

        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">تقرير الفحص الأمني (Scanner Light Console)</label>
          <pre id="scan-result" class="p-3 bg-slate-50 rounded-lg text-xs font-mono text-slate-800 border border-slate-300 min-h-[160px] overflow-auto whitespace-pre-wrap">لم يُفحص أي مشروع بعد.</pre>
        </div>
      </div>
    </div>

    <!-- TAB 4: Extensions -->
    <div id="view-extensions" class="hidden space-y-4">
      <div class="flex items-center justify-between bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
        <h2 class="text-xs font-bold text-slate-900">مدير الإضافات والنواة (Extension Manager)</h2>
        <button onclick="showAddExtModal()" class="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-bold hover:bg-emerald-700 shadow-xs">+ تفعيل إضافة جديدة</button>
      </div>
      <div id="extensions-list" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <!-- Extensions rendered here -->
      </div>
    </div>

    <!-- TAB 5: Events -->
    <div id="view-events" class="hidden space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
          <h2 class="text-xs font-bold text-slate-900">إطلاق حدث عبر حافلة النظام (EventBus Emit)</h2>
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1">اسم الحدث</label>
            <input type="text" id="emit-event-name" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900 focus:bg-white focus:outline-none focus:border-teal-600" placeholder="user:login أو app:start" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1">بيانات الحدث (JSON Payload)</label>
            <textarea id="emit-event-payload" rows="3" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs font-mono text-slate-900 focus:bg-white focus:outline-none focus:border-teal-600" placeholder='{"userId": 101}'></textarea>
          </div>
          <button onclick="emitEvent()" class="w-full py-2 bg-teal-600 hover:bg-teal-700 text-white font-bold rounded-lg text-xs transition">إطلاق الحدث الان</button>
        </div>

        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-2">
          <h2 class="text-xs font-bold text-slate-900">سجل الأحداث الممررة (Event Log History)</h2>
          <div id="events-log" class="p-3 rounded-lg bg-slate-50 border border-slate-300 font-mono text-xs text-slate-800 max-h-[320px] overflow-y-auto space-y-2">
            <div class="text-slate-400">جاري تحميل الأحداث...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 6: Scheduler -->
    <div id="view-scheduler" class="hidden space-y-4">
      <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-3 max-w-xl">
        <h2 class="text-sm font-bold text-slate-900">جدولة المهام وتأجيل التنفيذ (Debounce Scheduler)</h2>
        <p class="text-xs text-slate-600">تسجيل وتأجيل تنفيذ المهام تلقائياً عبر محرك المجدول المدمج للنواة.</p>
        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">معرّف المهمة (Task ID)</label>
          <input type="text" id="sched-task-id" value="task.autosave" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900" />
        </div>
        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">مدة التأخير (ملي ثانية - ms)</label>
          <input type="number" id="sched-ms" value="1500" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900" />
        </div>
        <button onclick="triggerDebounce()" class="w-full py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-lg text-xs transition">جدولة المهمة الان</button>
        <div id="sched-result" class="text-xs font-bold text-amber-700 font-mono"></div>
      </div>
    </div>

    <!-- TAB 7: i18n Engine -->
    <div id="view-i18n" class="hidden space-y-4">
      <div class="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-3 max-w-xl">
        <h2 class="text-sm font-bold text-slate-900">محرك التوطين والترجمة متعدد اللغات (i18n)</h2>
        <div class="space-y-2">
          <label class="block text-xs font-semibold text-slate-700">النص العربي (ar)</label>
          <input type="text" id="i18n-ar" value="النواة الذكية متصلة وتعمل بنجاح" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900" />
          <label class="block text-xs font-semibold text-slate-700">النص الإنجليزي (en)</label>
          <input type="text" id="i18n-en" value="Smart Kernel connected and running successfully" class="w-full bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-900" />
        </div>
        <div class="flex gap-2">
          <button onclick="testI18n('ar')" class="flex-1 py-2 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg text-xs font-bold hover:bg-emerald-100">عرض بالعربية (ar)</button>
          <button onclick="testI18n('en')" class="flex-1 py-2 bg-teal-50 text-teal-700 border border-teal-200 rounded-lg text-xs font-bold hover:bg-teal-100">عرض بالإنجليزية (en)</button>
        </div>
        <div class="p-3 bg-slate-50 rounded-lg text-xs font-bold text-emerald-800 border border-emerald-200 text-center" id="i18n-output">
          اختر اللغة للاختبار
        </div>
      </div>
    </div>

    <!-- TAB 8: Help Guide (دليل المساعدة وتسهيل التشغيل) -->
    <div id="view-help" class="hidden space-y-4">
      <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-xs space-y-5">
        <div class="flex items-center justify-between border-b border-slate-100 pb-3">
          <div class="flex items-center gap-2">
            <span class="text-xl">📖</span>
            <h2 class="text-base font-bold text-slate-900">دليل تشغيل النواة والمساعدة المباشرة</h2>
          </div>
          <span class="text-xs bg-emerald-50 text-emerald-700 px-3 py-1 rounded-full font-semibold border border-emerald-200">Nawat OS Documentation</span>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <h3 class="text-xs font-bold text-slate-800 flex items-center gap-1.5">
              <span>🚀</span> 1. تشغيل وإيقاف النواة (Boot & Power Control)
            </h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              يمكنك التحكم بوضعية تشغيل النواة عبر زر [إغلاق النواة / تشغيل النواة] في الشريط العلوي. تحافظ النواة على حالة الأحداث المسجلة والمحركات دون إفساد ملفات النظام.
            </p>
          </div>

          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <h3 class="text-xs font-bold text-slate-800 flex items-center gap-1.5">
              <span>💻</span> 2. منفذ أوامر Arch (Linux Exec Layer)
            </h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              يوفر هذا المنفذ بيئة آمنة معزولة لتنفيذ أوامر POSIX مع التحقق التلقائي من توقيع ملفات ELF والتحقق المزدوج للحد من ثغرات الحقن الأمنية.
            </p>
          </div>

          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <h3 class="text-xs font-bold text-slate-800 flex items-center gap-1.5">
              <span>🛡️</span> 3. الفاحص الأمني للمشاريع (Security Scanner)
            </h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              يقوم بمسح شجرة المجلدات بدقة فائقة للكشف عن الملفات المخفية بأحرف يونيكود غير مرئية، والملفات التنفيذية المشبوهة، والتأكد من عدم تسريب مسارات خارجية.
            </p>
          </div>

          <div class="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
            <h3 class="text-xs font-bold text-slate-800 flex items-center gap-1.5">
              <span>⚡</span> 4. سجل الأوامر والإضافات (Registry & Extensions)
            </h3>
            <p class="text-xs text-slate-600 leading-relaxed">
              تتيح لك النواة إضافة وتفعيل برمجيات جديدة برمجياً عبر محرك الإضافات، بالإضافة لتنفيذ الأوامر المسجلة مع إرسال المعطيات بصيغة JSON.
            </p>
          </div>
        </div>

        <div class="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 space-y-1">
          <div class="font-bold flex items-center gap-1.5">
            <span>💡</span> نصيحة سريعة لتسهيل الاستخدام:
          </div>
          <p>
            تتميز الواجهة بتصميم ناصع فاتح 100% يضمن وضوح القراءة والسهولة، ويمكنك التنقل بين التطبيقات بسهولة عبر قائمة البرامج العلوية أو مفاتيح الاختصار.
          </p>
        </div>
      </div>
    </div>

  </main>

  <!-- CachyOS KDE Plasma Bottom Taskbar Panel -->
  <footer class="fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur border-t border-slate-200 shadow-lg px-4 py-1.5 flex items-center justify-between">
    <div class="flex items-center gap-2">
      <!-- CachyOS / KDE Kickoff Launcher Button -->
      <button onclick="toggleLauncherMenu()" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-bold text-xs flex items-center gap-2 shadow-xs transition active:scale-95">
        <span class="text-sm">ن</span>
        <span>Applications</span>
      </button>

      <!-- Active Taskbar Windows Buttons -->
      <div class="flex items-center gap-1 overflow-x-auto py-0.5">
        <button onclick="switchTab('dolphin')" id="tab-dolphin" class="px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-sky-50 border-sky-300 text-sky-800">
          <span>📁</span>
          <span>Dolphin</span>
        </button>
        <button onclick="switchTab('arch')" id="tab-arch" class="px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span>💻</span>
          <span>Arch Exec</span>
        </button>
        <button onclick="switchTab('commands')" id="tab-commands" class="px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span>⚡</span>
          <span>Commands</span>
        </button>
        <button onclick="switchTab('scan')" id="tab-scan" class="px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span>🛡️</span>
          <span>Scanner</span>
        </button>
        <button onclick="switchTab('extensions')" id="tab-extensions" class="px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span>🧩</span>
          <span>Extensions</span>
        </button>
        <button onclick="switchTab('events')" id="tab-events" class="px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span>📡</span>
          <span>Events</span>
        </button>
        <button onclick="switchTab('scheduler')" id="tab-scheduler" class="px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span>⏱️</span>
          <span>Scheduler</span>
        </button>
        <button onclick="switchTab('i18n')" id="tab-i18n" class="px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span>🌐</span>
          <span>i18n</span>
        </button>
        <button onclick="switchTab('help')" id="tab-help" class="px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100">
          <span>📖</span>
          <span>Help</span>
        </button>
      </div>
    </div>

    <!-- Right Taskbar Tray -->
    <div class="flex items-center gap-3 text-xs font-mono text-slate-700">
      <div class="hidden md:flex items-center gap-1.5 bg-slate-100 px-2.5 py-1 rounded-md border border-slate-200">
        <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
        <span class="text-[11px] font-bold">CachyOS KDE Plasma</span>
      </div>
      <div id="tray-clock" class="font-bold">--:--:--</div>
    </div>
  </footer>

  <script>
    const __nawatFetch = window.fetch;
    window.fetch = function (url, opts) {
      return __nawatFetch(url, Object.assign({}, opts, {
        headers: Object.assign({ 'X-API-Key': '${API_KEY}' }, (opts && opts.headers) || {})
      }));
    };

    let currentTab = 'dolphin';
    let isKernelBooted = true;
    let commandsData = [];

    function updateClock() {
      const clockEl = document.getElementById('os-clock');
      const trayClockEl = document.getElementById('tray-clock');
      const now = new Date();
      const timeStr = now.toLocaleTimeString('ar-SA', { hour12: false });
      if (clockEl) clockEl.innerText = timeStr;
      if (trayClockEl) trayClockEl.innerText = timeStr;
    }
    setInterval(updateClock, 1000);
    updateClock();

    function toggleLauncherMenu() {
      const bar = document.getElementById('kickoff-menu');
      if (bar) {
        bar.classList.toggle('hidden');
      }
    }

    function launchApp(tab) {
      const kickoff = document.getElementById('kickoff-menu');
      if (kickoff) kickoff.classList.add('hidden');
      switchTab(tab);
    }

    function filterKickoffApps() {
      const query = (document.getElementById('kickoff-search')?.value || '').toLowerCase();
      const list = document.getElementById('kickoff-app-list');
      if (!list) return;
      const items = list.querySelectorAll('div[onclick]');
      items.forEach(item => {
        const text = item.innerText.toLowerCase();
        item.style.display = text.includes(query) ? 'flex' : 'none';
      });
    }

    function selectKickoffCategory(cat) {
      // visual feedback for category selection
    }

    function toggleKernelPower() {
      isKernelBooted = !isKernelBooted;
      const statusBadge = document.getElementById('status-badge');
      const powerBtnText = document.getElementById('power-btn-text');
      
      if (isKernelBooted) {
        if (statusBadge) {
          statusBadge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
          statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span>النواة نشطة (Booted)</span>';
        }
        if (powerBtnText) powerBtnText.innerText = 'Shutdown';
      } else {
        if (statusBadge) {
          statusBadge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-200 text-slate-700 border border-slate-300';
          statusBadge.innerHTML = '<span class="w-2 h-2 rounded-full bg-slate-400"></span><span>النواة متوقفة (Stopped)</span>';
        }
        if (powerBtnText) powerBtnText.innerText = 'Boot Kernel';
      }
    }

    function switchTab(tab) {
      const allTabs = ['dolphin', 'arch', 'commands', 'scan', 'extensions', 'events', 'scheduler', 'i18n', 'help'];
      allTabs.forEach(t => {
        const viewEl = document.getElementById('view-' + t);
        if (viewEl) viewEl.classList.add('hidden');
        const tabEl = document.getElementById('tab-' + t);
        if (tabEl) {
          tabEl.className = 'px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100';
        }
      });

      const activeView = document.getElementById('view-' + tab);
      if (activeView) activeView.classList.remove('hidden');
      const activeTabBtn = document.getElementById('tab-' + tab);
      if (activeTabBtn) {
        if (tab === 'dolphin') {
          activeTabBtn.className = 'px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-sky-50 border-sky-300 text-sky-800 font-bold shadow-xs';
        } else {
          activeTabBtn.className = 'px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 bg-emerald-50 border-emerald-300 text-emerald-800 font-bold shadow-xs';
        }
      }

      currentTab = tab;
      refreshData();
    }

    async function refreshData() {
      try {
        const kRes = await fetch('/api/kernel');
        const kData = await kRes.json();
        document.getElementById('metric-commands').innerText = kData.commandsCount;
        document.getElementById('metric-events').innerText = kData.recentEventsCount;
        document.getElementById('metric-extensions').innerText = kData.activeExtensionsCount;
        document.getElementById('metric-scheduler').innerText = kData.activeSchedulerCount;

        if (currentTab === 'commands') loadCommands();
        if (currentTab === 'events') loadEvents();
        if (currentTab === 'extensions') loadExtensions();
        if (currentTab === 'arch') loadArchHistory();
      } catch (err) {
        console.error('Refresh error:', err);
      }
    }

    async function loadCommands() {
      const res = await fetch('/api/commands');
      const data = await res.json();
      commandsData = data.commands;
      const listEl = document.getElementById('command-list');
      listEl.innerHTML = commandsData.map(c => \`
        <div onclick="selectCommand('\${c.id}')" class="p-2.5 rounded-lg bg-slate-50 hover:bg-emerald-50 border border-slate-200 cursor-pointer transition">
          <div class="font-mono text-xs text-emerald-700 font-bold">\${c.id}</div>
          <div class="text-xs font-semibold text-slate-800 mt-0.5">\${c.title?.ar || c.title?.en || ''}</div>
          <div class="text-[10px] text-slate-500 truncate mt-0.5">\${c.description?.ar || c.description?.en || ''}</div>
        </div>
      \`).join('');
    }

    function selectCommand(id) {
      document.getElementById('exec-command-id').value = id;
    }

    async function executeCommand() {
      const id = document.getElementById('exec-command-id').value;
      if (!id) return alert('الرجاء اختيار أمر أولاً');
      let payload = null;
      const payloadStr = document.getElementById('exec-payload').value.trim();
      if (payloadStr) {
        try { payload = JSON.parse(payloadStr); } catch { payload = payloadStr; }
      }
      try {
        const res = await fetch('/api/commands/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, payload })
        });
        const data = await res.json();
        document.getElementById('exec-result').innerText = JSON.stringify(data, null, 2);
        refreshData();
      } catch (err) {
        document.getElementById('exec-result').innerText = 'خطأ: ' + err.message;
      }
    }

    async function loadEvents() {
      const res = await fetch('/api/events');
      const data = await res.json();
      const logEl = document.getElementById('events-log');
      if (data.history.length === 0) {
        logEl.innerHTML = '<div class="text-slate-400">لا توجد أحداث مسجلة حتى الآن</div>';
        return;
      }
      logEl.innerHTML = data.history.reverse().map(e => \`
        <div class="p-2 rounded bg-slate-950 border border-slate-800">
          <div class="flex justify-between text-[11px] text-teal-400 font-bold">
            <span>⚡ \${e.name}</span>
            <span class="text-slate-500">\${new Date(e.timestamp).toLocaleTimeString('ar')}</span>
          </div>
          <div class="text-[10px] text-slate-400 mt-0.5">Payload: \${JSON.stringify(e.payload)}</div>
        </div>
      \`).join('');
    }

    async function emitEvent() {
      const name = document.getElementById('emit-event-name').value.trim();
      if (!name) return alert('أدخل اسم الحدث');
      let payload = {};
      const payloadStr = document.getElementById('emit-event-payload').value.trim();
      if (payloadStr) {
        try { payload = JSON.parse(payloadStr); } catch { payload = { raw: payloadStr }; }
      }
      await fetch('/api/events/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, payload })
      });
      document.getElementById('emit-event-name').value = '';
      loadEvents();
      refreshData();
    }

    async function loadExtensions() {
      const res = await fetch('/api/extensions');
      const data = await res.json();
      const listEl = document.getElementById('extensions-list');
      if (data.extensions.length === 0) {
        listEl.innerHTML = '<div class="text-slate-500 text-xs">لا توجد إضافات نشطة.</div>';
        return;
      }
      listEl.innerHTML = data.extensions.map(ext => \`
        <div class="p-3.5 rounded-xl bg-white border border-slate-200 shadow-xs flex flex-col justify-between space-y-2">
          <div>
            <div class="text-xs font-mono text-emerald-700 font-bold">\${ext.id}</div>
            <div class="text-xs font-bold text-slate-900 mt-1">\${ext.name?.ar || ext.name?.en || ext.id}</div>
            <div class="text-[11px] text-slate-500 mt-0.5">الإصدار: \${ext.version}</div>
          </div>
          <button onclick="deactivateExtension('\${ext.id}')" class="px-2.5 py-1 bg-rose-50 text-rose-700 border border-rose-200 rounded text-xs hover:bg-rose-100 font-bold">إلغاء التفعيل</button>
        </div>
      \`).join('');
    }

    async function deactivateExtension(id) {
      await fetch('/api/extensions/deactivate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      loadExtensions();
      refreshData();
    }

    async function triggerDebounce() {
      const taskId = document.getElementById('sched-task-id').value;
      const ms = document.getElementById('sched-ms').value;
      const res = await fetch('/api/scheduler/debounce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, ms })
      });
      const data = await res.json();
      document.getElementById('sched-result').innerText = data.message;
      refreshData();
    }

    async function testI18n(lang) {
      const ar = document.getElementById('i18n-ar').value;
      const en = document.getElementById('i18n-en').value;
      const res = await fetch('/api/commands/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'i18n.translate', payload: { string: { ar, en }, lang } })
      });
      const data = await res.json();
      document.getElementById('i18n-output').innerText = data.value?.result || 'خطأ';
    }

    async function executeArch() {
      const commandLine = document.getElementById('arch-command').value.trim();
      if (!commandLine) return alert('أدخل سطر أمر أولاً');
      const body = { commandLine };
      const cwd = document.getElementById('arch-cwd').value.trim();
      if (cwd) body.cwd = cwd;
      const timeout = document.getElementById('arch-timeout').value;
      if (timeout) body.timeoutMs = Number(timeout);
      try {
        const res = await fetch('/api/arch/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        const text =
          'verdict: ' + data.verdict + '  |  status: ' + data.status + '  |  exitCode: ' + data.exitCode +
          '  |  time: ' + data.executionTimeMs + 'ms' +
          (data.reason ? '\\nreason: ' + data.reason : '') +
          (data.warnings && data.warnings.length ? '\\nwarnings:\\n' + data.warnings.join('\\n') : '') +
          '\\nstdout:\\n' + data.stdout +
          '\\nstderr:\\n' + data.stderr +
          '\\nsummary.ar: ' + (data.summary?.ar || '');
        document.getElementById('arch-result').innerText = text;
        loadArchHistory();
      } catch (err) {
        document.getElementById('arch-result').innerText = 'خطأ: ' + err.message;
      }
    }

    async function loadArchHistory() {
      const res = await fetch('/api/arch/history');
      const data = await res.json();
      const el = document.getElementById('arch-history');
      if (!data.records || data.records.length === 0) {
        el.innerHTML = '<div class="text-slate-400">لا يوجد سجل تنفيذي بعد.</div>';
        return;
      }
      el.innerHTML = data.records.map(r => \`
        <div class="p-2 rounded bg-slate-900 border border-slate-800 text-white">
          <div class="flex justify-between text-emerald-400">
            <span class="font-bold">\${r.parsedTool?.toolName || '?'}</span>
            <span>\${r.status} · \${r.verdict}</span>
          </div>
          <div class="text-slate-300 mt-0.5">\${r.request.commandLine}</div>
          \${r.reason ? '<div class="text-rose-400 text-[10px] mt-0.5">' + r.reason + '</div>' : ''}
        </div>
      \`).join('');
    }

    function showRegisterModal() {
      const id = prompt('أدخل معرّف الأمر الجديد (مثال: custom.greet):', 'custom.greet');
      if (!id) return;
      const titleAr = prompt('عنوان الأمر بالعربية:', 'الترحيب بالمستخدم');
      const titleEn = prompt('عنوان الأمر بالإنجليزية:', 'Greet User');
      fetch('/api/commands/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, titleAr, titleEn, categoryAr: 'مخصص', categoryEn: 'Custom' })
      }).then(() => {
        loadCommands();
        refreshData();
      });
    }

    async function runScan() {
      const root = document.getElementById('scan-root').value.trim();
      if (!root) return alert('أدخل مسار المشروع');
      const registeredRaw = document.getElementById('scan-registered').value.trim();
      const registered = [];
      if (registeredRaw) {
        for (const part of registeredRaw.split(',')) {
          const p = part.trim();
          if (!p) continue;
          if (p.includes(':')) {
            const idx = p.indexOf(':');
            registered.push({ path: p.slice(0, idx), checksum: p.slice(idx + 1) });
          } else {
            registered.push(p);
          }
        }
      }
      try {
        const res = await fetch('/api/projects/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root, registered })
        });
        const data = await res.json();
        if (data.error) {
          document.getElementById('scan-result').innerText = 'خطأ: ' + data.error;
          return;
        }
        const badge = (n) => n > 0 ? n : 0;
        const lines = [
          'root: ' + data.root,
          'scanned: ' + data.scannedFiles + ' files / ' + data.scannedDirs + ' dirs  |  ' + data.elapsedMs + 'ms',
          '',
          'counts: ok=' + badge(data.counts.ok) +
            '  hidden=' + badge(data.counts.hidden) +
            '  executable=' + badge(data.counts.executable) +
            '  backdoor=' + badge(data.counts.backdoor) +
            '  outside_link=' + badge(data.counts.outside_link) +
            '  unregistered=' + badge(data.counts.unregistered) +
            '  tampered=' + badge(data.counts.tampered) +
            '  missing=' + badge(data.counts.missing),
          '',
          'hidden:'
        ];
        lines.push.apply(lines, data.hidden.map(p => '  ⚠ ' + p));
        lines.push('');
        lines.push('executables:');
        lines.push.apply(lines, data.executables.map(e => '  ▶ ' + e.path + ' (' + e.kind + ')'));
        lines.push('');
        lines.push('outside links (escape):');
        lines.push.apply(lines, data.outsideLinks.map(p => '  ⧉ ' + p));
        lines.push('');
        lines.push('detail findings (backdoor/tampered/unregistered/missing):');
        for (const f of data.findings) {
          if (f.kind === 'ok' || f.kind === 'hidden' || f.kind === 'executable' || f.kind === 'outside_link') continue;
          lines.push('  [' + f.kind + '] ' + f.path + ' — ' + f.detail);
        }
        document.getElementById('scan-result').innerText = lines.join('\\n');
      } catch (err) {
        document.getElementById('scan-result').innerText = 'خطأ: ' + err.message;
      }
    }

    function showAddExtModal() {
      const id = prompt('أدخل معرّف الإضافة:', 'ext.plugin_' + Math.floor(Math.random() * 1000));
      if (!id) return;
      fetch('/api/extensions/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, nameAr: 'إضافة مخصصة (' + id + ')', nameEn: 'Custom Extension' })
      }).then(() => {
        loadExtensions();
        refreshData();
      });
    }

    refreshData();
  </script>
</body>
</html>`);
});

  app.listen(PORT, HOST, () => {
    console.log(`[Nawat Kernel] Server running on http://${HOST}:${PORT}`);
    console.log(`[Nawat Kernel] API key: ${API_KEY}  (set NAWAT_API_KEY to pin it)`);
    console.log(`[Nawat Kernel] Allowed scan roots: ${SCAN_ROOTS.join(', ')}`);
  });
}

startServer().catch((err) => {
  console.error('[Nawat Kernel] Server failed to start:', err);
});
