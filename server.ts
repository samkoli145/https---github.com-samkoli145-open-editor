import express from 'express';
import cors from 'cors';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import {
  bootNawat,
  PROFILES,
  LinuxArchExecutionLayer,
  PersistentIndexer,
  scanProject,
  createToken,
  localize,
  type LocalizedString,
  type Extension
} from './src/index';

const PORT = 3000;
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

  const byteChecksum = (buf: Uint8Array): string => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < buf.length; i++) {
      hash ^= buf[i];
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };

  let indexer: PersistentIndexer | undefined;
  if (Array.isArray(registered) && registered.length > 0) {
    indexer = new PersistentIndexer(realRoot);
    for (const item of registered) {
      const rel = typeof item === 'string' ? item : item?.path;
      if (typeof rel !== 'string') continue;
      const abs = path.join(realRoot, rel);
      try {
        const st = statSync(abs);
        if (!st.isFile()) continue;
        const buf = readFileSync(abs);
        const checksum = typeof item === 'object' && typeof item.checksum === 'string'
          ? item.checksum
          : byteChecksum(buf);
        indexer.registerFile(abs, buf, checksum, st.mode);
      } catch {
        // skip unreadable registered paths
      }
    }
  }

  const report = scanProject(realRoot, indexer);
  res.json({
    root: report.root,
    scannedFiles: report.scannedFiles,
    scannedDirs: report.scannedDirs,
    elapsedMs: report.elapsedMs,
    counts: report.counts,
    hidden: report.hidden,
    executables: report.executables,
    outsideLinks: report.outsideLinks,
    findings: report.findings
  });
});

// Web UI Dashboard Endpoint
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>النواة الذكية — Open Editor Kernel Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Alexandria:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Alexandria', sans-serif; }
    code, pre { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen flex flex-col">
  <!-- Header -->
  <header class="border-b border-slate-800 bg-slate-950/80 backdrop-blur sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center font-bold text-slate-950 text-xl shadow-lg shadow-emerald-500/20">
          ن
        </div>
        <div>
          <h1 class="text-lg font-bold text-white flex items-center gap-2">
            النواة الذكية <span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">v0.1.0</span>
          </h1>
          <p class="text-xs text-slate-400">Open Editor Kernel — Nawat Core Subsystem</p>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <span id="status-badge" class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          النواة جاهزة (Booted)
        </span>
        <button onclick="refreshData()" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition flex items-center gap-1.5">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          تحديث
        </button>
      </div>
    </div>
  </header>

  <!-- Content Container -->
  <main class="max-w-7xl mx-auto px-4 py-6 flex-grow w-full space-y-6">

    <!-- Key Metrics Grid -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="p-4 rounded-xl bg-slate-800/60 border border-slate-700/50">
        <div class="text-xs text-slate-400 mb-1">الأوامر المسجلة</div>
        <div id="metric-commands" class="text-2xl font-bold text-white font-mono">0</div>
        <div class="text-[10px] text-slate-500 mt-1">CommandRegistry</div>
      </div>
      <div class="p-4 rounded-xl bg-slate-800/60 border border-slate-700/50">
        <div class="text-xs text-slate-400 mb-1">الأحداث الممررة</div>
        <div id="metric-events" class="text-2xl font-bold text-teal-400 font-mono">0</div>
        <div class="text-[10px] text-slate-500 mt-1">EventBus History</div>
      </div>
      <div class="p-4 rounded-xl bg-slate-800/60 border border-slate-700/50">
        <div class="text-xs text-slate-400 mb-1">الإضافات النشطة</div>
        <div id="metric-extensions" class="text-2xl font-bold text-emerald-400 font-mono">0</div>
        <div class="text-[10px] text-slate-500 mt-1">ExtensionManager</div>
      </div>
      <div class="p-4 rounded-xl bg-slate-800/60 border border-slate-700/50">
        <div class="text-xs text-slate-400 mb-1">المؤقتات والمهام</div>
        <div id="metric-scheduler" class="text-2xl font-bold text-amber-400 font-mono">0</div>
        <div class="text-[10px] text-slate-500 mt-1">Scheduler Timers</div>
      </div>
    </div>

    <!-- Navigation Tabs -->
    <div class="border-b border-slate-800 flex gap-2 overflow-x-auto text-sm font-medium">
      <button onclick="switchTab('commands')" id="tab-commands" class="px-4 py-2 border-b-2 border-emerald-400 text-emerald-400 transition">الأوامر والتنفيذ</button>
      <button onclick="switchTab('events')" id="tab-events" class="px-4 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition">حافلة الأحداث (EventBus)</button>
      <button onclick="switchTab('extensions')" id="tab-extensions" class="px-4 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition">الإضافات (Extensions)</button>
      <button onclick="switchTab('scheduler')" id="tab-scheduler" class="px-4 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition">المجدول (Scheduler)</button>
      <button onclick="switchTab('i18n')" id="tab-i18n" class="px-4 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition">التوطين (i18n)</button>
      <button onclick="switchTab('arch')" id="tab-arch" class="px-4 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition">الطبقة الأرشية (Arch)</button>
     <button onclick="switchTab('scan')" id="tab-scan" class="px-4 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition">فحص المشروع (Scan)</button>
    </div>

    <!-- TAB 1: Commands -->
    <div id="view-commands" class="space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <!-- Command List -->
        <div class="md:col-span-1 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-base font-semibold text-white">الأوامر المتاحة</h2>
            <button onclick="showRegisterModal()" class="text-xs px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border border-emerald-500/30">+ أمر جديد</button>
          </div>
          <div id="command-list" class="space-y-2 max-h-[500px] overflow-y-auto pr-1">
            <div class="text-xs text-slate-500">جاري التحميل...</div>
          </div>
        </div>

        <!-- Command Exec Console -->
        <div class="md:col-span-2 space-y-4">
          <h2 class="text-base font-semibold text-white">مُشغّل الأوامر (Console)</h2>
          <div class="p-4 rounded-xl bg-slate-800/80 border border-slate-700 space-y-4">
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">معرّف الأمر المختار</label>
              <input type="text" id="exec-command-id" readonly class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-emerald-400 font-mono" placeholder="اختر أمراً من القائمة..." />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">الحمولة (Payload - JSON أو نص)</label>
              <textarea id="exec-payload" rows="3" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500" placeholder='{"key": "value"}'></textarea>
            </div>
            <button onclick="executeCommand()" class="w-full py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold rounded-lg text-sm transition">تنفيذ الأمر الآن</button>

            <div>
              <label class="block text-xs font-medium text-slate-300 mb-1">نتيجة التنفيذ (Output Result)</label>
              <pre id="exec-result" class="p-3 bg-slate-950 rounded-lg text-xs font-mono text-emerald-300 border border-slate-800 overflow-x-auto min-h-[120px]">لم يتم تنفيذ أي أمر بعد.</pre>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 2: Events -->
    <div id="view-events" class="hidden space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
        <!-- Event Emitter Form -->
        <div class="p-4 rounded-xl bg-slate-800/80 border border-slate-700 space-y-4">
          <h2 class="text-base font-semibold text-white">إطلاق حدث يدوي (Emit Event)</h2>
          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1">اسم الحدث (Event Name)</label>
            <input type="text" id="emit-event-name" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white" placeholder="user:login أو file:saved" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1">بيانات الحدث (Payload JSON)</label>
            <textarea id="emit-event-payload" rows="3" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200" placeholder='{"userId": 101, "action": "save"}'></textarea>
          </div>
          <button onclick="emitEvent()" class="w-full py-2 bg-teal-500 hover:bg-teal-600 text-slate-950 font-bold rounded-lg text-sm transition">إطلاق الحدث عبر EventBus</button>
        </div>

        <!-- Event History Log -->
        <div class="space-y-2">
          <h2 class="text-base font-semibold text-white">سجل الأحداث الأخيرة (History)</h2>
          <div id="events-log" class="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-xs text-slate-300 max-h-[400px] overflow-y-auto space-y-2">
            <div class="text-slate-500">جاري تحميل الأحداث...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 3: Extensions -->
    <div id="view-extensions" class="hidden space-y-6">
      <div class="flex items-center justify-between">
        <h2 class="text-base font-semibold text-white">قائمة الإضافات (ExtensionManager)</h2>
        <button onclick="showAddExtModal()" class="text-xs px-3 py-1.5 rounded bg-emerald-500 text-slate-950 font-bold hover:bg-emerald-400">+ تفعيل إضافة جديدة</button>
      </div>
      <div id="extensions-list" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <!-- Extensions rendered here -->
      </div>
    </div>

    <!-- TAB 4: Scheduler -->
    <div id="view-scheduler" class="hidden space-y-6">
      <div class="p-4 rounded-xl bg-slate-800/80 border border-slate-700 space-y-4 max-w-xl">
        <h2 class="text-base font-semibold text-white">اختبار تأجيل المهام (Debounce Task)</h2>
        <p class="text-xs text-slate-400">يقوم بتسجيل مهمة تتأخر في التنفيذ بمقدار الملي ثانية المحدد.</p>
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">معرّف المهمة (Task ID)</label>
          <input type="text" id="sched-task-id" value="task.autosave" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white" />
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">التأخير الملي ثانية (ms)</label>
          <input type="number" id="sched-ms" value="1500" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white" />
        </div>
        <button onclick="triggerDebounce()" class="w-full py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold rounded-lg text-sm transition">جدولة مهمة Debounce</button>
        <div id="sched-result" class="text-xs text-amber-300 font-mono"></div>
      </div>
    </div>

    <!-- TAB 5: i18n -->
    <div id="view-i18n" class="hidden space-y-6">
      <div class="p-4 rounded-xl bg-slate-800/80 border border-slate-700 space-y-4 max-w-xl">
        <h2 class="text-base font-semibold text-white">اختبار دالة التوطين LocalizedString</h2>
        <div class="space-y-2">
          <label class="block text-xs text-slate-300">النص بالعربية (ar)</label>
          <input type="text" id="i18n-ar" value="النواة الذكية متصلة بنجاح" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white" />
          <label class="block text-xs text-slate-300">النص بالإنجليزية (en)</label>
          <input type="text" id="i18n-en" value="Smart Kernel connected successfully" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white" />
        </div>
        <div class="flex gap-3">
          <button onclick="testI18n('ar')" class="flex-1 py-2 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-lg text-xs font-bold hover:bg-emerald-500/30">عرض بالعربية (ar)</button>
          <button onclick="testI18n('en')" class="flex-1 py-2 bg-teal-500/20 text-teal-300 border border-teal-500/30 rounded-lg text-xs font-bold hover:bg-teal-500/30">عرض بالإنجليزية (en)</button>
        </div>
        <div class="p-3 bg-slate-950 rounded-lg text-sm font-semibold text-emerald-400 border border-slate-800 text-center" id="i18n-output">
          اضغط على أحد الزرين للاختبار
        </div>
      </div>
    </div>

    <!-- TAB 6: Arch Layer -->
    <div id="view-arch" class="hidden space-y-6">
      <div class="p-4 rounded-xl bg-slate-800/80 border border-slate-700 space-y-4 max-w-2xl">
        <h2 class="text-base font-semibold text-white">طبقة تنفيذ أرش (LinuxArchExecutionLayer)</h2>
        <p class="text-xs text-slate-400">تنفيذ أوامر النظام/ELF/سكربتات عبر بوابات إلزامية: code-domain → allowlist → quota → جذر تنفيذ → ELF/shebang.</p>
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">سطر الأمر (commandLine)</label>
          <input type="text" id="arch-command" value="echo hello-arch" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1">مجلد العمل (cwd - اختياري)</label>
            <input type="text" id="arch-cwd" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white" placeholder="/home/sam2/projects/00/kernel-project" />
          </div>
          <div>
            <label class="block text-xs font-medium text-slate-300 mb-1">المهلة بالـms (timeoutMs)</label>
            <input type="number" id="arch-timeout" value="10000" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white" />
          </div>
        </div>
        <button onclick="executeArch()" class="w-full py-2 bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold rounded-lg text-sm transition">تنفيذ عبر النواة الأرشية</button>
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">النتيجة</label>
          <pre id="arch-result" class="p-3 bg-slate-950 rounded-lg text-xs font-mono text-emerald-300 border border-slate-800 overflow-x-auto min-h-[120px] whitespace-pre-wrap">لم يُنفَّذ أي أمر بعد.</pre>
        </div>
      </div>
      <div class="p-4 rounded-xl bg-slate-800/80 border border-slate-700 space-y-3 max-w-2xl">
        <h2 class="text-base font-semibold text-white">سجل التدقيق (Audit)</h2>
        <div id="arch-history" class="space-y-2 max-h-[280px] overflow-y-auto font-mono text-[11px]">
          <div class="text-slate-500">لا يوجد سجل بعد.</div>
        </div>
      </div>
    </div>

    <!-- TAB 7: Project Scanner -->
    <div id="view-scan" class="hidden space-y-6">
      <div class="p-4 rounded-xl bg-slate-800/80 border border-slate-700 space-y-4 max-w-2xl">
        <h2 class="text-base font-semibold text-white">ماسح المشروع الخارجي (Project Scanner)</h2>
        <p class="text-xs text-slate-400">فحص مجلد مشروع من الخارج: ملفات مخفية (نقطية/Unicode) · قابلة للتنفيذ · setuid/backdoor · روابط خارجة عن الشجرة · مزروعة/معبث بها/مفقودة مقابل الفهرس.</p>
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">مسار المشروع المطلق (root)</label>
          <input type="text" id="scan-root" value="${process.cwd()}" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white" />
        </div>
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">قاعدة خط الأساس (registered: مسارات أو {path, checksum} مفصولة بفاصلة — اختياري)</label>
          <input type="text" id="scan-registered" value="src/main.py,README.md" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white" />
        </div>
        <button onclick="runScan()" class="w-full py-2 bg-rose-500 hover:bg-rose-600 text-slate-950 font-bold rounded-lg text-sm transition">فحص المشروع</button>
        <div>
          <label class="block text-xs font-medium text-slate-300 mb-1">تقرير</label>
          <pre id="scan-result" class="p-3 bg-slate-950 rounded-lg text-xs font-mono text-rose-200 border border-slate-800 overflow-x-auto min-h-[200px] whitespace-pre-wrap">لم يُفحص أي مشروع بعد.</pre>
        </div>
      </div>
    </div>
  </main>

  <script>
    // يُحقن مفتاح الـ API محلياً في اللوحة (اللوحة لا تصل إليها إلا محلياً) لكل fetch تلقائياً
    const __nawatFetch = window.fetch;
    window.fetch = function (url, opts) {
      return __nawatFetch(url, Object.assign({}, opts, {
        headers: Object.assign({ 'X-API-Key': '${API_KEY}' }, (opts && opts.headers) || {})
      }));
    };

    let currentTab = 'commands';
    let commandsData = [];

    function switchTab(tab) {
      ['commands', 'events', 'extensions', 'scheduler', 'i18n', 'arch', 'scan'].forEach(t => {
        document.getElementById('view-' + t).classList.add('hidden');
        document.getElementById('tab-' + t).className = 'px-4 py-2 border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition';
      });
      document.getElementById('view-' + tab).classList.remove('hidden');
      document.getElementById('tab-' + tab).className = 'px-4 py-2 border-b-2 border-emerald-400 text-emerald-400 transition';
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
        <div onclick="selectCommand('\${c.id}')" class="p-3 rounded-lg bg-slate-800 hover:bg-slate-700/80 border border-slate-700/60 cursor-pointer transition">
          <div class="font-mono text-xs text-emerald-400 font-bold">\${c.id}</div>
          <div class="text-xs font-medium text-white mt-0.5">\${c.title?.ar || c.title?.en || ''}</div>
          <div class="text-[10px] text-slate-400 truncate mt-1">\${c.description?.ar || c.description?.en || ''}</div>
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
        try {
          payload = JSON.parse(payloadStr);
        } catch {
          payload = payloadStr;
        }
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
        logEl.innerHTML = '<div class="text-slate-500">لا توجد أحداث مسجلة حتى الآن</div>';
        return;
      }
      logEl.innerHTML = data.history.reverse().map(e => \`
        <div class="p-2 rounded bg-slate-900 border border-slate-800">
          <div class="flex justify-between text-[11px] text-teal-400 font-bold">
            <span>⚡ \${e.name}</span>
            <span class="text-slate-500">\${new Date(e.timestamp).toLocaleTimeString('ar')}</span>
          </div>
          <div class="text-[10px] text-slate-400 mt-1">Payload: \${JSON.stringify(e.payload)}</div>
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
        <div class="p-4 rounded-xl bg-slate-800/80 border border-slate-700 flex flex-col justify-between space-y-3">
          <div>
            <div class="text-xs font-mono text-emerald-400">\${ext.id}</div>
            <div class="text-sm font-bold text-white mt-1">\${ext.name?.ar || ext.name?.en || ext.id}</div>
            <div class="text-xs text-slate-400 mt-0.5">الإصدار: \${ext.version}</div>
          </div>
          <button onclick="deactivateExtension('\${ext.id}')" class="px-3 py-1 bg-red-500/20 text-red-300 border border-red-500/30 rounded text-xs hover:bg-red-500/30">إلغاء التفعيل</button>
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
          (data.reason ? '\nreason: ' + data.reason : '') +
          (data.warnings && data.warnings.length ? '\nwarnings:\n' + data.warnings.join('\n') : '') +
          '\nstdout:\n' + data.stdout +
          '\nstderr:\n' + data.stderr +
          '\nsummary.ar: ' + (data.summary?.ar || '');
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
        el.innerHTML = '<div class="text-slate-500">لا يوجد سجل بعد.</div>';
        return;
      }
      el.innerHTML = data.records.map(r => \`
        <div class="p-2 rounded bg-slate-900 border border-slate-800">
          <div class="flex justify-between text-emerald-400">
            <span class="font-bold">\${r.parsedTool?.toolName || '?'}</span>
            <span>\${r.status} · \${r.verdict}</span>
          </div>
          <div class="text-slate-300 mt-1">\${r.request.commandLine}</div>
          \${r.reason ? '<div class="text-red-400 text-[10px] mt-0.5">' + r.reason + '</div>' : ''}
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
        document.getElementById('scan-result').innerText = lines.join('\n');
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

    // Initial Load
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
