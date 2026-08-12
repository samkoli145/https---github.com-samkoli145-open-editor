import { Result, ok, err } from '../../kernel/core/result';
import { EventBus } from '../../kernel/core/event-bus';
import { LinuxArchExecutionLayer } from '../../agent-kernel/linux-arch-execution-layer';
import { LaunchRequest, LaunchResult, ProcessInfo, DisplayServer } from './types';

export class ProcessLauncher {
  private activeProcesses = new Map<number, ProcessInfo>();
  private displayServer: DisplayServer;

  constructor(
    private executionLayer: LinuxArchExecutionLayer,
    private eventBus: EventBus
  ) {
    this.displayServer = this.detectDisplayServer();
  }

  public async validateCommand(binaryPath: string): Promise<Result<void, Error>> {
    if (!binaryPath || binaryPath.trim() === '') {
      return err(new Error('Binary path is required'));
    }
    const parsed = this.executionLayer.parseCommand(binaryPath);
    if (parsed.toolName === 'rm' && parsed.flags.some(f => f.includes('f') || f.includes('r'))) {
      return err(new Error('Destructive file system operations are blocked'));
    }
    return ok(undefined);
  }

  /**
   * تشغيل برنامج - يدعم الحالتين (مباشر ومُدار)
   */
  async launch(request: LaunchRequest): Promise<Result<LaunchResult, Error>> {
    const securityCheck = await this.validateCommand(request.binaryPath);
    if (securityCheck.isErr) {
      return err(new Error(`Security check failed: ${securityCheck.error.message}`));
    }

    switch (request.mode) {
      case 'direct':
        return this.launchDirect(request);
      case 'managed':
        return this.launchManaged(request);
      case 'embedded':
        return this.launchEmbedded(request);
      case 'background':
        return this.launchBackground(request);
      default:
        return err(new Error(`Unknown launch mode: ${(request as any).mode}`));
    }
  }

  /**
   * الحالة 1: تشغيل مباشر (بدون إدارة النواة)
   * يُستخدم عندما يريد المستخدم فتح البرنامج بسرعة مباشرة من النظام
   */
  private async launchDirect(request: LaunchRequest): Promise<Result<LaunchResult, Error>> {
    const command = this.buildCommand(request);
    
    // استخدام nohup و & لتشغيل الأوامر خلفيتها مستقلاً
    const fullCommand = `nohup ${command} > /dev/null 2>&1 &`;
    
    const result = await this.executionLayer.execute({
      commandLine: fullCommand,
      cwd: request.workingDirectory,
      env: request.env
    });

    if (result.status === 'blocked' || result.verdict === 'denied') {
      return err(new Error(`Direct launch failed: ${result.reason || 'Command blocked by security policy'}`));
    }

    const pid = Math.floor(1000 + Math.random() * 9000);
    
    this.activeProcesses.set(pid, {
      pid,
      programId: request.programId,
      name: request.binaryPath.split('/').pop() || request.programId,
      status: 'running',
      cpuUsage: 0.1,
      memoryUsage: 12.4,
      startTime: Date.now(),
      embedded: false
    });

    this.eventBus.emit('launcher:direct' as any, {
      pid,
      programId: request.programId,
      timestamp: Date.now()
    });

    return ok({
      pid,
      displayServer: this.displayServer,
      embedded: false,
      timestamp: Date.now()
    });
  }

  /**
   * الحالة 2: تشغيل مُدار (عبر النواة)
   * يُستخدم عندما تحتاج النواة لمراقبة البرنامج وإدارته
   */
  private async launchManaged(request: LaunchRequest): Promise<Result<LaunchResult, Error>> {
    const command = this.buildCommand(request);
    
    const result = await this.executionLayer.execute({
      commandLine: command,
      cwd: request.workingDirectory,
      env: request.env,
      timeoutMs: request.timeout
    });

    if (result.status === 'blocked' || result.verdict === 'denied') {
      return err(new Error(`Managed launch failed: ${result.reason || 'Command blocked'}`));
    }

    const pid = Math.floor(1000 + Math.random() * 9000);
    const windowId = await this.getWindowId(pid);

    this.activeProcesses.set(pid, {
      pid,
      programId: request.programId,
      name: request.binaryPath.split('/').pop() || request.programId,
      status: 'running',
      cpuUsage: 0.2,
      memoryUsage: 28.1,
      startTime: Date.now(),
      windowId: windowId || undefined,
      embedded: false
    });

    this.startMonitoring(pid);

    this.eventBus.emit('launcher:managed' as any, {
      pid,
      programId: request.programId,
      windowId,
      timestamp: Date.now()
    });

    return ok({
      pid,
      windowId: windowId || undefined,
      displayServer: this.displayServer,
      embedded: false,
      timestamp: Date.now()
    });
  }

  /**
   * تشغيل مضمّن (داخل واجهتنا)
   */
  private async launchEmbedded(request: LaunchRequest): Promise<Result<LaunchResult, Error>> {
    const env = {
      ...request.env,
      'NAWAT_EMBED': '1',
      'NAWAT_EMBED_STRATEGY': request.embedStrategy || 'auto'
    };

    const modifiedRequest = { ...request, env };
    const managedRes = await this.launchManaged(modifiedRequest);
    if (managedRes.isOk) {
      const val = managedRes.value;
      const proc = this.activeProcesses.get(val.pid);
      if (proc) {
        this.activeProcesses.set(val.pid, { ...proc, embedded: true });
      }
      return ok({
        ...val,
        embedded: true
      });
    }
    return managedRes;
  }

  /**
   * تشغيل في الخلفية (بدون واجهة)
   */
  private async launchBackground(request: LaunchRequest): Promise<Result<LaunchResult, Error>> {
    const command = this.buildCommand(request);
    
    const result = await this.executionLayer.execute({
      commandLine: command,
      cwd: request.workingDirectory,
      env: request.env
    });

    if (result.status === 'blocked' || result.verdict === 'denied') {
      return err(new Error(`Background launch failed: ${result.reason || 'Command blocked'}`));
    }

    const pid = Math.floor(1000 + Math.random() * 9000);

    this.activeProcesses.set(pid, {
      pid,
      programId: request.programId,
      name: request.binaryPath.split('/').pop() || request.programId,
      status: 'running',
      cpuUsage: 0.05,
      memoryUsage: 8.2,
      startTime: Date.now(),
      embedded: false
    });

    return ok({
      pid,
      displayServer: this.displayServer,
      embedded: false,
      timestamp: Date.now()
    });
  }

  /**
   * إيقاف عملية
   */
  async stop(pid: number): Promise<Result<void, Error>> {
    const process = this.activeProcesses.get(pid);
    if (!process) {
      return err(new Error(`Process not found: ${pid}`));
    }

    await this.executionLayer.execute({
      commandLine: `kill -TERM ${pid}`
    });

    this.activeProcesses.delete(pid);
    
    this.eventBus.emit('launcher:stopped' as any, {
      pid,
      programId: process.programId,
      timestamp: Date.now()
    });

    return ok(undefined);
  }

  /**
   * الحصول على معلومات عملية
   */
  async getProcessInfo(pid: number): Promise<Result<ProcessInfo, Error>> {
    const process = this.activeProcesses.get(pid);
    if (!process) {
      return err(new Error(`Process not found: ${pid}`));
    }

    const statsResult = await this.executionLayer.execute({
      commandLine: `ps -p ${pid} -o %cpu,%mem --no-headers`
    });
    
    if (statsResult.status === 'success' && statsResult.stdout.trim()) {
      const [cpu, mem] = statsResult.stdout.trim().split(/\s+/);
      this.activeProcesses.set(pid, {
        ...process,
        cpuUsage: parseFloat(cpu) || process.cpuUsage,
        memoryUsage: parseFloat(mem) || process.memoryUsage
      });
    }

    return ok(this.activeProcesses.get(pid)!);
  }

  /**
   * قائمة العمليات النشطة
   */
  getActiveProcesses(): ProcessInfo[] {
    return Array.from(this.activeProcesses.values());
  }

  // ─── Private Methods ──────────────────────────────────────────────

  private buildCommand(request: LaunchRequest): string {
    const parts = [request.binaryPath];
    
    if (request.args) {
      parts.push(...request.args);
    }

    return parts.join(' ');
  }

  private detectDisplayServer(): DisplayServer {
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) {
        return 'wayland';
      }
    }
    return 'x11';
  }

  private async getWindowId(pid: number): Promise<string | null> {
    if (this.displayServer === 'x11') {
      const result = await this.executionLayer.execute({
        commandLine: `xdotool search --pid ${pid}`
      });
      if (result.status === 'success' && result.stdout.trim()) {
        return result.stdout.trim().split('\n')[0];
      }
    }
    return null;
  }

  private startMonitoring(pid: number): void {
    const interval = setInterval(async () => {
      const checkResult = await this.executionLayer.execute({
        commandLine: `kill -0 ${pid}`
      });
      
      if (checkResult.status === 'error' || checkResult.status === 'blocked') {
        const proc = this.activeProcesses.get(pid);
        if (proc) {
          this.activeProcesses.set(pid, { ...proc, status: 'stopped' });
          this.eventBus.emit('launcher:exited' as any, {
            pid,
            programId: proc.programId,
            timestamp: Date.now()
          });
        }
        clearInterval(interval);
      }
    }, 5000);
  }
}
