import path from 'node:path';
import { Result, ok, err } from '../../kernel/core/result';
import { EventBus } from '../../kernel/core/event-bus';
import { CommandRegistry } from '../../kernel/command-registry';
import { LinuxArchExecutionLayer } from '../../agent-kernel/linux-arch-execution-layer';
import { ProcessLauncher } from './process-launcher';
import { WindowEmbedder } from './window-embedder';
import { WebEmbedder } from './web-embedder';
import { DesktopEntryScanner, DesktopApplication } from './desktop-scanner';
import { DesktopEntryScanner as DesktopDiscoveryScanner, DesktopEntryInfo } from '../discovery/desktop-entry-scanner';
import { ProgramCatalog, ProgramCategory, CatalogStats } from '../discovery/program-catalog';
import { MimeResolver } from '../discovery/mime-resolver';
import { SafeSystemStorageEngine, ISystemStorageEngine } from '../../system/storage';
import { LaunchRequest, LaunchResult, ProcessInfo } from './types';

export class LauncherManager {
  private processLauncher: ProcessLauncher;
  private windowEmbedder: WindowEmbedder;
  private webEmbedder: WebEmbedder;
  private desktopScanner: DesktopEntryScanner;
  private discoveryScanner: DesktopDiscoveryScanner;
  private catalog: ProgramCatalog;
  private mimeResolver: MimeResolver;

  constructor(
    private eventBus: EventBus,
    private commandRegistry: CommandRegistry,
    private executionLayer: LinuxArchExecutionLayer,
    storage?: ISystemStorageEngine
  ) {
    const sysStorage = storage || new SafeSystemStorageEngine('/vfs/launcher-storage');
    this.processLauncher = new ProcessLauncher(executionLayer, eventBus);
    this.windowEmbedder = new WindowEmbedder(executionLayer);
    this.webEmbedder = new WebEmbedder(executionLayer, eventBus);
    this.desktopScanner = new DesktopEntryScanner(executionLayer);
    this.discoveryScanner = new DesktopDiscoveryScanner(executionLayer, eventBus);
    this.catalog = new ProgramCatalog(this.discoveryScanner, sysStorage, eventBus);
    this.mimeResolver = new MimeResolver(executionLayer, this.catalog);

    this.registerCommands();
  }

  /**
   * اكتشاف جميع البرامج المثبتة
   */
  async discoverPrograms(): Promise<Result<CatalogStats, Error>> {
    return this.catalog.buildCatalog();
  }

  /**
   * البحث عن برامج
   */
  async searchPrograms(query: string): Promise<Result<DesktopEntryInfo[], Error>> {
    return this.catalog.search(query);
  }

  /**
   * تشغيل برنامج بالمعرف
   */
  async launchById(programId: string, args?: string[]): Promise<Result<LaunchResult, Error>> {
    const program = this.catalog.getProgram(programId);
    if (!program) {
      return err(new Error(`Program not found: ${programId}`));
    }

    const execCommand = this.discoveryScanner.getExecCommand(program);
    const parts = execCommand.split(' ').filter(Boolean);
    const binaryPath = parts[0] || program.exec;
    const initialArgs = parts.slice(1);

    return this.launch({
      programId: program.id,
      binaryPath,
      args: [...initialArgs, ...(args || [])],
      mode: 'managed'
    });
  }

  /**
   * إصلاح §5-0: استيفاء binaryPath شرعي من الكتالوج المكتشف — لا يُقبل افتراضي
   * خطير (/bin/bash سابقاً). يعيد undefined إن لم يُعرف البرنامج.
   */
  resolveProgramBinary(programId: string): string | undefined {
    const program = this.catalog.getProgram(programId);
    if (!program) return undefined;
    const execCommand = this.discoveryScanner.getExecCommand(program);
    const parts = execCommand.split(' ').filter(Boolean);
    return parts[0] || program.exec;
  }

  /**
   * فتح ملف بالبرنامج المناسب
   */
  async openFile(filePath: string): Promise<Result<string, Error>> {
    const resolution = await this.mimeResolver.resolve(filePath);
    if (resolution.isErr) {
      return err(resolution.error);
    }

    const { defaultProgram, availablePrograms } = resolution.value;

    if (defaultProgram) {
      return this.mimeResolver.openWith(filePath, defaultProgram);
    }

    if (availablePrograms.length > 0) {
      return this.mimeResolver.openWith(filePath, availablePrograms[0]);
    }

    return this.mimeResolver.openWithDefault(filePath);
  }

  /**
   * المسارات المسموح بها لملفات .desktop في النظام
   */
  public static readonly ALLOWED_DESKTOP_DIRS: string[] = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
    `${process.env.HOME || '/root'}/.local/share/applications`
  ];

  /**
   * التحقق من أمان وصحة مسار ملف .desktop وضمان وجوده ضمن المسارات المسموح بها
   */
  public isValidDesktopFilePath(filePath: string): boolean {
    if (!filePath || typeof filePath !== 'string') return false;

    const normalized = path.normalize(filePath);
    if (!normalized.endsWith('.desktop')) return false;

    const isAllowedDir = LauncherManager.ALLOWED_DESKTOP_DIRS.some(allowedDir => {
      const normAllowed = path.normalize(allowedDir);
      return normalized === normAllowed || normalized.startsWith(normAllowed + '/');
    }) || (/^\/home\/[^/]+\/\.local\/share\/applications\//.test(normalized));

    return isAllowedDir;
  }

  /**
   * تشغيل برنامج عبر مسار ملف .desktop باستخدام xdg-open بعد التحقق الأمن للمسار
   */
  async launchDesktopFile(filePath: string): Promise<Result<string, Error>> {
    if (!this.isValidDesktopFilePath(filePath)) {
      return err(new Error(`Unauthorized or invalid desktop file path: ${filePath}`));
    }

    if (!this.executionLayer) {
      return err(new Error('No execution layer available'));
    }

    const normalized = path.normalize(filePath);
    const result = await this.executionLayer.execute({
      commandLine: `xdg-open "${normalized}" &`
    });

    if (result.status === 'success') {
      this.eventBus.emit('snowball:interaction' as any, {
        type: 'command_executed',
        source: 'launcher-manager',
        payload: { action: 'launchDesktopFile', filePath: normalized },
        timestamp: Date.now()
      });
      return ok(`Successfully launched desktop file with xdg-open: ${normalized}`);
    }

    return err(new Error(result.reason || `Failed to execute xdg-open for ${normalized}`));
  }

  /**
   * الحصول على الفئات
   */
  getCategories(): ProgramCategory[] {
    return this.catalog.getCategories();
  }

  /**
   * الحصول على برامج فئة معينة
   */
  getProgramsByCategory(categoryId: string): DesktopEntryInfo[] {
    return this.catalog.getByCategory(categoryId);
  }

  /**
   * استكشاف برامج الإنترنت والويب المثبتة على ليونكس
   */
  async scanInternetApps(): Promise<Result<DesktopApplication[], Error>> {
    return this.desktopScanner.scanApplications();
  }

  /**
   * الحصول على البرامج المكتشفة
   */
  getInternetApps(): DesktopApplication[] {
    return this.desktopScanner.getInternetApplications();
  }

  /**
   * تشغيل برنامج (الواجهة الموحدة)
   */
  async launch(request: LaunchRequest): Promise<Result<LaunchResult, Error>> {
    // تسجيل التفاعل مع Snowball
    this.eventBus.emit('snowball:interaction' as any, {
      type: 'command_executed',
      source: 'launcher-manager',
      payload: { programId: request.programId, mode: request.mode },
      timestamp: Date.now()
    });

    return this.processLauncher.launch(request);
  }

  /**
   * تشغيل وتضمين في نفس الوقت
   */
  async launchAndEmbed(
    request: LaunchRequest,
    containerId: string
  ): Promise<Result<{ launch: LaunchResult; embedHtml: string }, Error>> {
    // تشغيل البرنامج
    const launchResult = await this.launch(request);
    if (launchResult.isErr) {
      return err(launchResult.error);
    }

    const launch = launchResult.value;
    let embedHtml = '';

    // إذا كان برنامج رسومي، حاول تضمين النافذة
    if (launch.windowId) {
      const embedResult = await this.windowEmbedder.embedWindow(
        launch.windowId,
        containerId,
        request.embedStrategy
      );

      if (embedResult.isOk) {
        embedHtml = this.generateEmbedHtml(containerId, 'window', launch.windowId);
      }
    }
    
    // إذا كان سيرفر ويب، ضمّن عبر iframe
    else if (launch.port) {
      const webResult = await this.webEmbedder.embedWebApp({
        url: `http://127.0.0.1:${launch.port}`,
        port: launch.port,
        containerId
      });

      if (webResult.isOk) {
        embedHtml = webResult.value.iframeHtml;
      }
    }

    return ok({ launch, embedHtml });
  }

  /**
   * إيقاف برنامج
   */
  async stop(pid: number): Promise<Result<void, Error>> {
    return this.processLauncher.stop(pid);
  }

  /**
   * قائمة العمليات
   */
  getProcesses(): ProcessInfo[] {
    return this.processLauncher.getActiveProcesses();
  }

  public getProcessLauncher(): ProcessLauncher {
    return this.processLauncher;
  }

  public getWindowEmbedder(): WindowEmbedder {
    return this.windowEmbedder;
  }

  public getWebEmbedder(): WebEmbedder {
    return this.webEmbedder;
  }

  // ─── Private Methods ──────────────────────────────────────────────

  private registerCommands(): void {
    // أمر التشغيل
    this.commandRegistry.register({
      id: 'launcher.launch',
      title: { ar: 'تشغيل برنامج', en: 'Launch Program' },
      handler: async (payload: unknown) => {
        return this.launch(payload as LaunchRequest);
      }
    });

    // أمر الإيقاف
    this.commandRegistry.register({
      id: 'launcher.stop',
      title: { ar: 'إيقاف برنامج', en: 'Stop Program' },
      handler: async (payload: unknown) => {
        const { pid } = (payload || {}) as { pid: number };
        return this.stop(pid);
      }
    });

    // أمر القائمة
    this.commandRegistry.register({
      id: 'launcher.list',
      title: { ar: 'قائمة العمليات', en: 'List Processes' },
      handler: async () => {
        return ok(this.getProcesses());
      }
    });

    // أمر تشغيل ملف .desktop بـ xdg-open مع التثبت الأمن للمسار
    this.commandRegistry.register({
      id: 'launcher.launchDesktopFile',
      title: { ar: 'تشغيل ملف تطبيق بـ xdg-open', en: 'Launch Desktop File via xdg-open' },
      handler: async (payload: unknown) => {
        const { filePath } = (payload || {}) as { filePath: string };
        return this.launchDesktopFile(filePath);
      }
    });
  }

  private generateEmbedHtml(
    containerId: string,
    type: 'window' | 'web',
    target: string
  ): string {
    if (type === 'web') {
      return `
        <div id="${containerId}" class="embed-container bg-white border border-slate-200 rounded-lg p-2 shadow-sm">
          <iframe src="${target}" style="width:100%;height:100%;border:none;" class="bg-white"></iframe>
        </div>
      `.trim();
    }
    
    // لنافذة X11 (ثيم فاتح أبيض ورمادي ناصع مريح للعين)
    return `
      <div id="${containerId}" class="embed-container x11-embed bg-slate-50 border border-slate-200 rounded-lg p-4 text-slate-800 shadow-sm">
        <div class="embed-placeholder text-center space-y-1">
          <p class="font-medium text-sm text-slate-800">نافذة مضمنة: <span class="font-mono text-blue-600">${target}</span></p>
          <p class="text-xs text-slate-500">استخدم x11vnc للعرض الكامل في الواجهة الفاتحة</p>
        </div>
      </div>
    `.trim();
  }
}
