// src/host/launcher/desktop-scanner.ts
import { Result, ok, err } from '../../kernel/core/result';
import { LinuxArchExecutionLayer } from '../../agent-kernel/linux-arch-execution-layer';

export interface DesktopApplication {
  readonly id: string;
  readonly name: string;
  readonly genericName?: string;
  readonly exec: string;
  readonly binaryName: string;
  readonly icon?: string;
  readonly categories: string[];
  readonly mimeTypes: string[];
  readonly comment?: string;
  readonly desktopFilePath?: string;
  readonly isInternetApp: boolean;
  readonly internetCategory?: 'browser' | 'email' | 'chat' | 'web-tool' | 'other';
  readonly isWebEmbeddable: boolean;
  readonly defaultPort?: number;
}

export interface DesktopScannerConfig {
  readonly scanPaths?: string[];
  readonly fallbackBinaries?: string[];
}

export class DesktopEntryScanner {
  private static readonly DEFAULT_XDG_PATHS = [
    '/usr/share/applications',
    '/usr/local/share/applications',
    '~/.local/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snap/desktop/applications'
  ];

  private static readonly INTERNET_CATEGORIES = new Set([
    'network',
    'webbrowser',
    'email',
    'chat',
    'ircclient',
    'feed',
    'news',
    'webdevelopment',
    'instantmessaging',
    'p2p',
    'remoteaccess',
    'filetransfer'
  ]);

  private static readonly BROWSER_BINARIES = new Set([
    'firefox',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'brave',
    'brave-browser',
    'microsoft-edge',
    'microsoft-edge-stable',
    'opera',
    'epiphany',
    'zen-browser',
    'tor-browser',
    'falkon',
    'midori',
    'code-server'
  ]);

  private discoveredApps = new Map<string, DesktopApplication>();

  constructor(
    private executionLayer?: LinuxArchExecutionLayer,
    private config?: DesktopScannerConfig
  ) {}

  /**
   * مسح وتعرف تلقائي على جميع التطبيقات المثبتة في ليونكس وتصنيف تطبيقات الإنترنت والويب
   */
  async scanApplications(): Promise<Result<DesktopApplication[], Error>> {
    try {
      this.discoveredApps.clear();

      // 1. مسح المجلدات القياسية لـ XDG Desktop Entries (.desktop)
      if (this.executionLayer) {
        await this.scanXdgDirectories();
      }

      // 2. فحص البرامج الثنائية الأساسية للإنترنت المتوفرة عبر النظام (Fallback Command Check)
      await this.scanKnownSystemInternetBinaries();

      const appsList = Array.from(this.discoveredApps.values());
      return ok(appsList);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * الحصول فقط على تطبيقات الإنترنت والويب المستكشفة
   */
  getInternetApplications(): DesktopApplication[] {
    return Array.from(this.discoveredApps.values()).filter(app => app.isInternetApp);
  }

  /**
   * تحليل محتوى ملف .desktop مفرد بأسلوب INI
   */
  public parseDesktopEntry(content: string, filePath?: string): DesktopApplication | null {
    const lines = content.split('\n');
    let inDesktopSection = false;
    const entryData: Record<string, string> = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      if (trimmed.startsWith('[')) {
        inDesktopSection = trimmed === '[Desktop Entry]';
        continue;
      }

      if (inDesktopSection) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.substring(0, eqIdx).trim();
          const value = trimmed.substring(eqIdx + 1).trim();
          entryData[key] = value;
        }
      }
    }

    if (entryData['Type'] && entryData['Type'] !== 'Application') {
      return null;
    }

    if (entryData['NoDisplay'] === 'true' || entryData['Hidden'] === 'true') {
      return null;
    }

    const name = entryData['Name'] || entryData['Name[ar]'] || 'تطبيق بدون اسم';
    const rawExec = entryData['Exec'] || '';
    if (!rawExec) return null;

    // تنظيف أوساط التشغيل الخاص بـ Freedesktop مثل %u, %F, %f
    const cleanedExec = rawExec.replace(/%[fFuUiIcKk]/g, '').trim();
    const binaryName = cleanedExec.split(' ')[0].split('/').pop() || cleanedExec;

    const categories = (entryData['Categories'] || '')
      .split(';')
      .map(c => c.trim().toLowerCase())
      .filter(Boolean);

    const mimeTypes = (entryData['MimeType'] || '')
      .split(';')
      .map(m => m.trim().toLowerCase())
      .filter(Boolean);

    const isInternetApp = this.checkIsInternetApp(binaryName, categories, mimeTypes);
    const internetCategory = isInternetApp
      ? this.classifyInternetApp(binaryName, categories, mimeTypes)
      : undefined;

    const id = filePath
      ? filePath.split('/').pop()?.replace('.desktop', '') || binaryName
      : binaryName;

    return {
      id,
      name,
      genericName: entryData['GenericName'],
      exec: cleanedExec,
      binaryName,
      icon: entryData['Icon'] || this.getIconForApp(binaryName, isInternetApp),
      categories,
      mimeTypes,
      comment: entryData['Comment'],
      desktopFilePath: filePath,
      isInternetApp,
      internetCategory,
      isWebEmbeddable: binaryName === 'code-server' || categories.includes('webdevelopment') || mimeTypes.includes('text/html'),
      defaultPort: binaryName === 'code-server' ? 8080 : undefined
    };
  }

  // ─── Private Methods ──────────────────────────────────────────────

  private async scanXdgDirectories(): Promise<void> {
    if (!this.executionLayer) return;

    const searchPaths = this.config?.scanPaths || DesktopEntryScanner.DEFAULT_XDG_PATHS;
    const cmd = `find ${searchPaths.join(' ')} -name "*.desktop" 2>/dev/null | head -n 100`;

    const result = await this.executionLayer.execute({ commandLine: cmd });
    if (result.status !== 'success' || !result.stdout) return;

    const files = result.stdout.split('\n').map(f => f.trim()).filter(Boolean);
    for (const filePath of files) {
      const catResult = await this.executionLayer.execute({ commandLine: `cat "${filePath}"` });
      if (catResult.status === 'success' && catResult.stdout) {
        const parsed = this.parseDesktopEntry(catResult.stdout, filePath);
        if (parsed) {
          this.discoveredApps.set(parsed.id, parsed);
        }
      }
    }
  }

  private async scanKnownSystemInternetBinaries(): Promise<void> {
    const knownList = [
      { id: 'firefox', name: 'Mozilla Firefox', binary: 'firefox', cat: 'browser' as const, icon: '🌐' },
      { id: 'chrome', name: 'Google Chrome', binary: 'google-chrome', cat: 'browser' as const, icon: '🌐' },
      { id: 'chromium', name: 'Chromium Web Browser', binary: 'chromium', cat: 'browser' as const, icon: '🌐' },
      { id: 'brave', name: 'Brave Browser', binary: 'brave-browser', cat: 'browser' as const, icon: '🦁' },
      { id: 'code-server', name: 'VS Code Web Server', binary: 'code-server', cat: 'web-tool' as const, icon: '⚡', isEmbed: true, port: 8080 },
      { id: 'thunderbird', name: 'Mozilla Thunderbird Mail', binary: 'thunderbird', cat: 'email' as const, icon: '📧' },
      { id: 'filezilla', name: 'FileZilla FTP Client', binary: 'filezilla', cat: 'other' as const, icon: '📁' }
    ];

    for (const app of knownList) {
      let isInstalled = true;
      if (this.executionLayer) {
        const check = await this.executionLayer.execute({ commandLine: `which ${app.binary} 2>/dev/null` });
        isInstalled = check.status === 'success' && check.stdout.trim().length > 0;
      }

      if (isInstalled && !this.discoveredApps.has(app.id)) {
        this.discoveredApps.set(app.id, {
          id: app.id,
          name: app.name,
          exec: app.binary,
          binaryName: app.binary,
          icon: app.icon,
          categories: ['network', 'webbrowser'],
          mimeTypes: ['text/html', 'x-scheme-handler/http', 'x-scheme-handler/https'],
          isInternetApp: true,
          internetCategory: app.cat,
          isWebEmbeddable: !!app.isEmbed,
          defaultPort: app.port
        });
      }
    }
  }

  private checkIsInternetApp(binaryName: string, categories: string[], mimeTypes: string[]): boolean {
    if (DesktopEntryScanner.BROWSER_BINARIES.has(binaryName.toLowerCase())) {
      return true;
    }

    const hasInternetCategory = categories.some(cat => DesktopEntryScanner.INTERNET_CATEGORIES.has(cat.toLowerCase()));
    if (hasInternetCategory) return true;

    const hasWebMime = mimeTypes.some(m => 
      m.includes('http') || m.includes('https') || m.includes('html') || m.includes('mailto')
    );
    return hasWebMime;
  }

  private classifyInternetApp(
    binaryName: string,
    categories: string[],
    mimeTypes: string[]
  ): 'browser' | 'email' | 'chat' | 'web-tool' | 'other' {
    const bName = binaryName.toLowerCase();
    if (DesktopEntryScanner.BROWSER_BINARIES.has(bName) || categories.includes('webbrowser') || mimeTypes.some(m => m.includes('http'))) {
      return 'browser';
    }
    if (categories.includes('email') || mimeTypes.some(m => m.includes('mailto'))) {
      return 'email';
    }
    if (categories.includes('chat') || categories.includes('ircclient') || categories.includes('instantmessaging')) {
      return 'chat';
    }
    if (categories.includes('webdevelopment') || bName === 'code-server') {
      return 'web-tool';
    }
    return 'other';
  }

  private getIconForApp(binaryName: string, isInternet: boolean): string {
    const b = binaryName.toLowerCase();
    if (b.includes('firefox') || b.includes('chrome') || b.includes('browser') || b.includes('chromium')) return '🌐';
    if (b.includes('thunderbird') || b.includes('mail')) return '📧';
    if (b.includes('chat') || b.includes('discord') || b.includes('telegram')) return '💬';
    if (b.includes('code') || b.includes('server')) return '📝';
    return isInternet ? '🌐' : '📦';
  }
}
