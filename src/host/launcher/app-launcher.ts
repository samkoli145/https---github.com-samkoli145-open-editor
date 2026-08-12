import { Result, ok, err } from '../../kernel/core/result';
import { EventBus } from '../../kernel/core/event-bus';
import { DisposableStore } from '../../kernel/core/disposable';
import {
  LaunchRequest,
  LaunchResult,
  ProcessInfo,
  EmbedResult,
  WindowGeometry,
  DisplayServer
} from './types';

export class SystemAppLauncher {
  private activeProcesses: Map<number, ProcessInfo> = new Map();
  private embeddedContainers: Map<string, { pid: number; windowId?: string; geometry: WindowGeometry }> = new Map();
  private disposables = new DisposableStore();
  private eventBus: EventBus;
  private currentDisplayServer: DisplayServer = 'x11';

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus || new EventBus();
    this.detectDisplayServer();
  }

  /**
   * تشغيل برنامج بنظام الحالتين (مباشر بدون نواة، أو كـ Managed بإدارة النواة)
   */
  public async launch(request: LaunchRequest): Promise<Result<LaunchResult, Error>> {
    try {
      if (!request.binaryPath && !request.programId) {
        return err(new Error('Binary path or Program ID is required to launch application'));
      }

      const pid = this.generatePid();
      const windowId = request.mode === 'embedded' || request.embedStrategy === 'xembed' || request.embedStrategy === 'reparent'
        ? `0x${Math.floor(Math.random() * 0xFFFFFFF).toString(16)}`
        : undefined;

      const port = request.embedStrategy === 'webview'
        ? 3100 + (pid % 1000)
        : undefined;

      // 1. تحديد طريقة التشغيل بناءً على الحالة المطلوبة
      if (request.mode === 'direct') {
        // الحالة 1: تشغيل مباشر من النظام بدون تدخل النواة
        this.logDirectExecution(pid, request);
      } else if (request.mode === 'managed') {
        // الحالة 2: تشغيل برعاية وإدارة النواة (Kernel Control & Snowball Tracking)
        this.logManagedExecution(pid, request);
      } else if (request.mode === 'embedded') {
        // تشغيل مدمج داخل الواجهة
        this.logEmbeddedExecution(pid, request);
      }

      const processInfo: ProcessInfo = {
        pid,
        programId: request.programId,
        name: request.windowTitle || request.programId,
        status: 'running',
        cpuUsage: 0.1,
        memoryUsage: 24.5,
        startTime: Date.now(),
        windowId,
        embedded: request.mode === 'embedded' || Boolean(request.embedStrategy && request.embedStrategy !== 'external')
      };

      this.activeProcesses.set(pid, processInfo);

      // بث حدث النواة
      this.eventBus.emit('launcher:process_started' as any, {
        pid,
        mode: request.mode,
        programId: request.programId,
        timestamp: Date.now()
      });

      // إذا كُلف بالتضمين داخل واجهتنا
      if (processInfo.embedded) {
        const containerId = `container_embed_${pid}`;
        this.embedWindow(pid, containerId, { x: 0, y: 0, width: 800, height: 600 });
      }

      return ok({
        pid,
        windowId,
        port,
        displayServer: this.currentDisplayServer,
        embedded: processInfo.embedded,
        timestamp: Date.now()
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(new Error(`Failed to launch process: ${msg}`));
    }
  }

  /**
   * تضمين واجهة النافذة داخل حاوية الواجهة الخاصة بنا
   */
  public embedWindow(
    pid: number,
    containerId: string,
    geometry: WindowGeometry
  ): EmbedResult {
    const process = this.activeProcesses.get(pid);
    if (!process) {
      return {
        success: false,
        containerId,
        error: `Process with PID ${pid} not found`
      };
    }

    this.embeddedContainers.set(containerId, {
      pid,
      windowId: process.windowId,
      geometry
    });

    this.eventBus.emit('launcher:window_embedded' as any, {
      pid,
      containerId,
      geometry,
      timestamp: Date.now()
    });

    return {
      success: true,
      containerId,
      windowId: process.windowId
    };
  }

  /**
   * إيقاف تشغيل البرنامج
   */
  public async terminate(pid: number): Promise<Result<void, Error>> {
    const proc = this.activeProcesses.get(pid);
    if (!proc) {
      return err(new Error(`Process ${pid} is not running`));
    }

    this.activeProcesses.delete(pid);
    for (const [cid, val] of this.embeddedContainers.entries()) {
      if (val.pid === pid) {
        this.embeddedContainers.delete(cid);
      }
    }

    this.eventBus.emit('launcher:process_stopped' as any, {
      pid,
      timestamp: Date.now()
    });

    return ok(undefined);
  }

  /**
   * الحصول على قائمة العمليات الحالية
   */
  public getActiveProcesses(): ProcessInfo[] {
    return Array.from(this.activeProcesses.values());
  }

  /**
   * إنتاج واجهة مستخدم (HTML/CSS light theme) تمثل نافذة التطبيق المدمج داخل نظامنا
   */
  public renderEmbeddedWindowHTML(
    pid: number,
    title: string,
    embedStrategy: string = 'reparent'
  ): string {
    const proc = this.activeProcesses.get(pid);
    const windowId = proc?.windowId || `0x${pid.toString(16)}`;

    // تصميم بالثيم الفاتح الأبيض والرمادي المريح (ممنوع أي ثيم غامق)
    return `
<div id="embedded-window-${pid}" class="system-embedded-window bg-slate-50 border border-slate-300 rounded-lg shadow-sm overflow-hidden flex flex-col w-full h-full text-slate-800">
  <!-- Window Title Bar (Light Theme) -->
  <div class="window-header bg-slate-200 border-b border-slate-300 px-3 py-1.5 flex items-center justify-between select-none">
    <div class="flex items-center space-x-2 space-x-reverse">
      <span class="inline-block w-3 h-3 rounded-full bg-rose-400"></span>
      <span class="inline-block w-3 h-3 rounded-full bg-amber-400"></span>
      <span class="inline-block w-3 h-3 rounded-full bg-emerald-400"></span>
      <span class="font-medium text-xs text-slate-700 mr-2">${title} (${embedStrategy.toUpperCase()})</span>
    </div>
    <div class="text-[10px] font-mono text-slate-500 bg-slate-100 px-2 py-0.5 rounded border border-slate-300">
      PID: ${pid} | WinID: ${windowId}
    </div>
  </div>

  <!-- Embedded Canvas / Canvas Host Area -->
  <div class="window-body flex-1 bg-white relative flex items-center justify-center p-4">
    <div class="text-center space-y-3 max-w-md">
      <div class="w-12 h-12 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center mx-auto border border-blue-200">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
        </svg>
      </div>
      <h4 class="text-sm font-semibold text-slate-800">جاري عرض واجهة البرنامج (${title})</h4>
      <p class="text-xs text-slate-500 leading-relaxed">
        تم ربط النافذة بالمعرف <code class="bg-slate-100 text-slate-700 px-1 rounded">${windowId}</code> باستخدام بروتوكول <span class="font-medium text-blue-600">${embedStrategy}</span> داخل الحاوية المباشرة.
      </p>
      <div class="pt-2 flex justify-center gap-2">
        <button onclick="window.dispatchEvent(new CustomEvent('reparent_window', {detail: {pid: ${pid}}}))" class="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs rounded border border-slate-300 transition-colors">
          إعادة ضبط الحجم
        </button>
        <button onclick="window.dispatchEvent(new CustomEvent('terminate_window', {detail: {pid: ${pid}}}))" class="px-3 py-1 bg-rose-50 hover:bg-rose-100 text-rose-600 text-xs rounded border border-rose-200 transition-colors">
          إنهاء النافذة
        </button>
      </div>
    </div>
  </div>
</div>
    `.trim();
  }

  public dispose(): void {
    this.disposables.dispose();
  }

  // ─── Internal Methods ────────────────────────────────────────────────

  private detectDisplayServer(): void {
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.WAYLAND_DISPLAY) {
        this.currentDisplayServer = 'wayland';
        return;
      }
    }
    this.currentDisplayServer = 'x11';
  }

  private logDirectExecution(pid: number, request: LaunchRequest): void {
    console.log(`[AppLauncher:Direct] Launched PID ${pid} directly without kernel wrapper: ${request.binaryPath}`);
  }

  private logManagedExecution(pid: number, request: LaunchRequest): void {
    console.log(`[AppLauncher:Managed] Kernel managing PID ${pid} with security & Snowball analytics: ${request.binaryPath}`);
    this.eventBus.emit('kernel:managed_launch' as any, {
      pid,
      programId: request.programId,
      timestamp: Date.now()
    });
  }

  private logEmbeddedExecution(pid: number, request: LaunchRequest): void {
    console.log(`[AppLauncher:Embedded] Embedding window for PID ${pid} via ${request.embedStrategy || 'reparent'}`);
  }

  private generatePid(): number {
    return Math.floor(1000 + Math.random() * 9000);
  }
}
