import { Result, ok, err } from '../../kernel/core/result';
import { LinuxArchExecutionLayer } from '../../agent-kernel/linux-arch-execution-layer';
import { EventBus } from '../../kernel/core/event-bus';

export interface WebEmbedConfig {
  readonly url: string;
  readonly port: number;
  readonly containerId: string;
  readonly width?: number;
  readonly height?: number;
}

export interface WebEmbedResult {
  readonly success: boolean;
  readonly containerId: string;
  readonly url: string;
  readonly port: number;
  readonly iframeHtml: string;
}

export class WebEmbedder {
  private activeEmbeds = new Map<string, WebEmbedConfig>();

  constructor(
    private executionLayer: LinuxArchExecutionLayer,
    private eventBus: EventBus
  ) {}

  /**
   * تضمين تطبيق ويب يعمل على سيرفر (مثل OpenCPDE, Jupyter, VS Code Server)
   */
  async embedWebApp(config: WebEmbedConfig): Promise<Result<WebEmbedResult, Error>> {
    const checkResult = await this.checkServer(config.port);
    if (checkResult.isErr) {
      return err(new Error(`Server not running on port ${config.port}`));
    }

    const iframeHtml = this.generateIframeHtml(config);
    this.activeEmbeds.set(config.containerId, config);

    this.eventBus.emit('webembed:created' as any, {
      containerId: config.containerId,
      url: config.url,
      port: config.port,
      timestamp: Date.now()
    });

    return ok({
      success: true,
      containerId: config.containerId,
      url: config.url,
      port: config.port,
      iframeHtml
    });
  }

  /**
   * بدء سيرفر وتضمينه
   */
  async startAndEmbed(
    serverCommand: string,
    port: number,
    containerId: string,
    workingDirectory?: string
  ): Promise<Result<WebEmbedResult, Error>> {
    const launchResult = await this.executionLayer.execute({
      commandLine: serverCommand,
      cwd: workingDirectory,
      env: { 'PORT': port.toString() }
    });

    if (launchResult.status === 'blocked' || launchResult.status === 'error') {
      return err(new Error(`Failed to start server: ${launchResult.reason || launchResult.stderr || 'Execution failed'}`));
    }

    const isReady = await this.waitForServer(port, 10000);
    if (!isReady) {
      return err(new Error(`Server did not start within timeout`));
    }

    return this.embedWebApp({
      url: `http://127.0.0.1:${port}`,
      port,
      containerId
    });
  }

  /**
   * توليد HTML للتضمين (بثيم فاتح أنيق خفيف بدقة)
   */
  public generateIframeHtml(config: WebEmbedConfig): string {
    const width = config.width ? `${config.width}px` : '100%';
    const height = config.height ? `${config.height}px` : '100%';
    
    return `
      <div id="${config.containerId}" class="web-embed-container bg-white border border-slate-200 rounded-lg overflow-hidden shadow-sm flex flex-col" 
           style="width: ${width}; height: ${height}; min-height: 400px;">
        <div class="embed-bar bg-slate-100 border-b border-slate-200 px-3 py-1.5 flex items-center justify-between text-xs text-slate-600">
          <div class="flex items-center space-x-2 space-x-reverse font-mono">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
            <span>Server Web App (Port: ${config.port})</span>
          </div>
          <span class="text-slate-400 font-mono text-[11px]">${config.url}</span>
        </div>
        <iframe 
          src="${config.url}" 
          class="w-full flex-1 border-none bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          allow="clipboard-read; clipboard-write"
        ></iframe>
      </div>
    `.trim();
  }

  /**
   * توليد HTML لنافذة مضمنة (X11) بثيم فاتح
   */
  public generateX11EmbedHtml(windowId: string, containerId: string): string {
    return `
      <div id="${containerId}" class="x11-embed-container bg-slate-50 border border-slate-200 rounded-lg p-3 text-slate-700">
        <div class="text-xs font-semibold mb-2 text-slate-800">تضمين X11 عبر العرض الرسومي الفاتح</div>
        <iframe 
          src="http://127.0.0.1:5900/vnc.html?window=${windowId}" 
          class="w-full h-96 border border-slate-300 rounded bg-white shadow-inner"
        ></iframe>
      </div>
    `.trim();
  }

  /**
   * إزالة التضمين
   */
  async removeEmbed(containerId: string): Promise<Result<void, Error>> {
    this.activeEmbeds.delete(containerId);
    
    this.eventBus.emit('webembed:removed' as any, {
      containerId,
      timestamp: Date.now()
    });

    return ok(undefined);
  }

  /**
   * الحصول على التضمينات النشطة
   */
  getActiveEmbeds(): WebEmbedConfig[] {
    return Array.from(this.activeEmbeds.values());
  }

  // ─── Private Methods ──────────────────────────────────────────────

  private async checkServer(port: number): Promise<Result<void, Error>> {
    const result = await this.executionLayer.execute({
      commandLine: `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${port}`
    });
    
    if (result.status === 'success' && (result.stdout.trim() === '200' || result.stdout.trim() === '302' || result.stdout.trim() === '401')) {
      return ok(undefined);
    }
    
    return err(new Error(`Server not responding on port ${port}`));
  }

  private async waitForServer(port: number, timeout: number): Promise<boolean> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const checkResult = await this.checkServer(port);
      if (checkResult.isOk) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    return false;
  }
}
