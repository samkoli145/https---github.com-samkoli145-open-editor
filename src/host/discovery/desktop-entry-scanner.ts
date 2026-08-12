// src/host/discovery/desktop-entry-scanner.ts
import { Result, ok, err } from '../../kernel/core/result';
import { EventBus } from '../../kernel/core/event-bus';
import { LinuxArchExecutionLayer } from '../../agent-kernel/linux-arch-execution-layer';
import { INIParser } from './ini-parser';

export interface DesktopEntryInfo {
  readonly id: string;              // اسم الملف بدون .desktop
  readonly filePath: string;
  readonly name: string;
  readonly nameAr: string;
  readonly genericName: string;
  readonly comment: string;
  readonly commentAr: string;
  readonly exec: string;            // أمر التشغيل
  readonly icon: string;
  readonly terminal: boolean;
  readonly categories: string[];
  readonly mimeTypes: string[];
  readonly keywords: string[];
  readonly hidden: boolean;
  readonly noDisplay: boolean;
  readonly source: 'system' | 'local' | 'user' | 'flatpak' | 'snap';
}

export class DesktopEntryScanner {
  private parser = new INIParser();
  private readonly scanPaths: Array<{ path: string; source: DesktopEntryInfo['source'] }> = [
    { path: '/usr/share/applications', source: 'system' },
    { path: '/usr/local/share/applications', source: 'local' },
    { path: `${process.env.HOME || '/root'}/.local/share/applications`, source: 'user' },
    { path: '/var/lib/flatpak/exports/share/applications', source: 'flatpak' },
    { path: '/var/lib/snapd/desktop/applications', source: 'snap' }
  ];

  constructor(
    private executionLayer?: LinuxArchExecutionLayer,
    private eventBus?: EventBus
  ) {}

  /**
   * مسح جميع المسارات واكتشاف البرامج
   */
  async scanAll(): Promise<Result<DesktopEntryInfo[], Error>> {
    const allEntries: DesktopEntryInfo[] = [];
    const errors: string[] = [];

    if (this.eventBus) {
      this.eventBus.emit('discovery:scanStarted', {
        paths: this.scanPaths.map(p => p.path),
        timestamp: Date.now()
      });
    }

    for (const { path, source } of this.scanPaths) {
      const scanResult = await this.scanDirectory(path, source);
      
      if (scanResult.isOk) {
        allEntries.push(...scanResult.value);
      } else {
        errors.push(`${path}: ${scanResult.error.message}`);
      }
    }

    // إزالة المكررات (نفس البرنامج قد يكون في أكثر من مسار)
    const uniqueEntries = this.deduplicateEntries(allEntries);

    if (this.eventBus) {
      this.eventBus.emit('discovery:scanCompleted', {
        found: uniqueEntries.length,
        errors: errors.length,
        timestamp: Date.now()
      });
    }

    return ok(uniqueEntries);
  }

  /**
   * مسح دليل واحد
   */
  async scanDirectory(
    dirPath: string,
    source: DesktopEntryInfo['source']
  ): Promise<Result<DesktopEntryInfo[], Error>> {
    if (!this.executionLayer) {
      return ok([]);
    }

    // التحقق من وجود الدليل
    const checkResult = await this.executionLayer.execute({
      commandLine: `test -d "${dirPath}" && echo "exists"`
    });
    
    if (checkResult.status !== 'success' || checkResult.stdout.trim() !== 'exists') {
      return ok([]); // الدليل غير موجود، ليس خطأ
    }

    // قائمة ملفات .desktop
    const listResult = await this.executionLayer.execute({
      commandLine: `find "${dirPath}" -maxdepth 2 -name "*.desktop" -type f 2>/dev/null`
    });

    if (listResult.status !== 'success') {
      return err(new Error(`Failed to list ${dirPath}: ${listResult.reason || 'Execution error'}`));
    }

    const files = listResult.stdout
      .trim()
      .split('\n')
      .filter(f => f.length > 0);

    const entries: DesktopEntryInfo[] = [];

    for (const filePath of files) {
      const parseResult = await this.parseDesktopFile(filePath, source);
      if (parseResult.isOk) {
        entries.push(parseResult.value);
      }
    }

    return ok(entries);
  }

  /**
   * تحليل ملف .desktop واحد
   */
  async parseDesktopFile(
    filePath: string,
    source: DesktopEntryInfo['source'] = 'system'
  ): Promise<Result<DesktopEntryInfo, Error>> {
    let content = '';

    if (this.executionLayer) {
      const readResult = await this.executionLayer.execute({ commandLine: `cat "${filePath}"` });
      if (readResult.status !== 'success') {
        return err(new Error(`Failed to read ${filePath}: ${readResult.reason || 'Read error'}`));
      }
      content = readResult.stdout;
    } else {
      return err(new Error('No execution layer provided'));
    }

    return this.parseDesktopContent(content, filePath, source);
  }

  /**
   * تحليل محتوى نصي لملف .desktop مباشرة (مفيد للاختبارات)
   */
  public parseDesktopContent(
    content: string,
    filePath: string,
    source: DesktopEntryInfo['source'] = 'system'
  ): Result<DesktopEntryInfo, Error> {
    const parseResult = this.parser.parse(content);
    if (parseResult.isErr) {
      return err(new Error(`Failed to parse ${filePath}: ${parseResult.error.message}`));
    }

    const parsed = parseResult.value;
    
    // التحقق من النوع
    const type = parsed.entries.get('Type');
    if (type !== 'Application') {
      return err(new Error(`Not an application: ${filePath}`));
    }

    // استخراج المعلومات
    const entry: DesktopEntryInfo = {
      id: this.extractId(filePath),
      filePath,
      name: parsed.entries.get('Name') || this.extractId(filePath),
      nameAr: this.parser.getLocalizedValue(parsed, 'Name', 'ar') || parsed.entries.get('Name') || '',
      genericName: parsed.entries.get('GenericName') || '',
      comment: parsed.entries.get('Comment') || '',
      commentAr: this.parser.getLocalizedValue(parsed, 'Comment', 'ar') || '',
      exec: parsed.entries.get('Exec') || '',
      icon: parsed.entries.get('Icon') || '',
      terminal: parsed.entries.get('Terminal') === 'true',
      categories: this.parseList(parsed.entries.get('Categories') || ''),
      mimeTypes: this.parseList(parsed.entries.get('MimeType') || ''),
      keywords: this.parseList(parsed.entries.get('Keywords') || ''),
      hidden: parsed.entries.get('Hidden') === 'true',
      noDisplay: parsed.entries.get('NoDisplay') === 'true',
      source
    };

    // تجاهل البرامج المخفية
    if (entry.hidden || entry.noDisplay) {
      return err(new Error(`Entry is hidden: ${filePath}`));
    }

    return ok(entry);
  }

  /**
   * البحث عن برامج تطابق معايير معينة
   */
  async search(criteria: {
    category?: string;
    mimeType?: string;
    keyword?: string;
    name?: string;
  }): Promise<Result<DesktopEntryInfo[], Error>> {
    const scanResult = await this.scanAll();
    if (scanResult.isErr) {
      return err(scanResult.error);
    }

    let results = scanResult.value;

    if (criteria.category) {
      results = results.filter(e => 
        e.categories.some(c => c.toLowerCase().includes(criteria.category!.toLowerCase()))
      );
    }

    if (criteria.mimeType) {
      results = results.filter(e =>
        e.mimeTypes.some(m => m.toLowerCase().includes(criteria.mimeType!.toLowerCase()))
      );
    }

    if (criteria.keyword) {
      results = results.filter(e =>
        e.keywords.some(k => k.toLowerCase().includes(criteria.keyword!.toLowerCase())) ||
        e.name.toLowerCase().includes(criteria.keyword!.toLowerCase()) ||
        e.nameAr.includes(criteria.keyword!)
      );
    }

    if (criteria.name) {
      results = results.filter(e =>
        e.name.toLowerCase().includes(criteria.name!.toLowerCase()) ||
        e.nameAr.includes(criteria.name!)
      );
    }

    return ok(results);
  }

  /**
   * الحصول على أمر التشغيل لبرنامج معين
   */
  getExecCommand(entry: DesktopEntryInfo, filePath?: string): string {
    let exec = entry.exec;
    
    // استبدال المعاملات حسب معيار freedesktop
    // %u = URL واحد, %f = ملف واحد, %U = URLs متعددة, %F = ملفات متعددة
    if (filePath) {
      exec = exec.replace(/%[uUfF]/, `"${filePath}"`);
    } else {
      exec = exec.replace(/%[uUfF]/, '');
    }

    // إزالة أي معاملات أخرى متبقية
    exec = exec.replace(/%[a-zA-Z]/g, '').trim();

    return exec;
  }

  // ─── Private Methods ──────────────────────────────────────────────

  private extractId(filePath: string): string {
    const fileName = filePath.split('/').pop() || '';
    return fileName.replace('.desktop', '');
  }

  private parseList(value: string): string[] {
    return value
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  private deduplicateEntries(entries: DesktopEntryInfo[]): DesktopEntryInfo[] {
    const seen = new Map<string, DesktopEntryInfo>();
    
    for (const entry of entries) {
      const existing = seen.get(entry.id);
      if (!existing || this.getPriority(entry.source) > this.getPriority(existing.source)) {
        seen.set(entry.id, entry);
      }
    }

    return Array.from(seen.values());
  }

  private getPriority(source: DesktopEntryInfo['source']): number {
    const priorities: Record<DesktopEntryInfo['source'], number> = {
      user: 5,
      local: 4,
      system: 3,
      flatpak: 2,
      snap: 1
    };
    return priorities[source];
  }
}
