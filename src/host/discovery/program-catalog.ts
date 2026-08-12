// src/host/discovery/program-catalog.ts
import { Result, ok, err } from '../../kernel/core/result';
import { EventBus } from '../../kernel/core/event-bus';
import { ISystemStorageEngine } from '../../system/storage';
import { DesktopEntryScanner, DesktopEntryInfo } from './desktop-entry-scanner';
import { LRUCache } from '../../kernel/core/cache';

export interface ProgramCategory {
  readonly id: string;
  readonly name: string;
  readonly nameAr: string;
  readonly icon: string;
  readonly programs: DesktopEntryInfo[];
}

export interface CatalogStats {
  readonly totalPrograms: number;
  readonly byCategory: Record<string, number>;
  readonly bySource: Record<string, number>;
  readonly lastScan: number;
}

export class ProgramCatalog {
  private programs = new Map<string, DesktopEntryInfo>();
  private categories = new Map<string, ProgramCategory>();
  private cache: LRUCache<string, DesktopEntryInfo[]>;
  private lastScanTime: number = 0;

  constructor(
    private scanner: DesktopEntryScanner,
    private storage: ISystemStorageEngine,
    private eventBus: EventBus
  ) {
    this.cache = new LRUCache<string, DesktopEntryInfo[]>({
      maxSize: 100,
      defaultTtlMs: 3600000 // 1 ساعة
    });
  }

  /**
   * بناء الفهرس الكامل
   */
  async buildCatalog(): Promise<Result<CatalogStats, Error>> {
    this.eventBus.emit('catalog:building', { timestamp: Date.now() });

    // مسح النظام
    const scanResult = await this.scanner.scanAll();
    if (scanResult.isErr) {
      return err(scanResult.error);
    }

    const entries = scanResult.value;

    // تنظيف الفهرس القديم
    this.programs.clear();
    this.categories.clear();

    // إضافة البرامج
    for (const entry of entries) {
      this.programs.set(entry.id, entry);
      this.categorizeProgram(entry);
    }

    // حفظ في التخزين الدائم
    await this.storage.save('program-catalog', {
      programs: Array.from(this.programs.values()),
      lastScan: Date.now()
    });

    this.lastScanTime = Date.now();

    const stats = this.getStats();
    
    this.eventBus.emit('catalog:built', {
      stats,
      timestamp: Date.now()
    });

    return ok(stats);
  }

  /**
   * الحصول على جميع البرامج
   */
  getAllPrograms(): DesktopEntryInfo[] {
    return Array.from(this.programs.values());
  }

  /**
   * الحصول على برنامج بالمعرف
   */
  getProgram(id: string): DesktopEntryInfo | undefined {
    return this.programs.get(id);
  }

  /**
   * البحث عن برامج
   */
  async search(query: string): Promise<Result<DesktopEntryInfo[], Error>> {
    // محاولة من الكاش
    const cached = this.cache.get(`search:${query}`);
    if (cached) {
      return ok(cached);
    }

    const queryLower = query.toLowerCase();
    const results = Array.from(this.programs.values()).filter(entry => {
      return (
        entry.name.toLowerCase().includes(queryLower) ||
        entry.nameAr.includes(query) ||
        entry.genericName.toLowerCase().includes(queryLower) ||
        entry.comment.toLowerCase().includes(queryLower) ||
        entry.commentAr.includes(query) ||
        entry.keywords.some(k => k.toLowerCase().includes(queryLower)) ||
        entry.categories.some(c => c.toLowerCase().includes(queryLower))
      );
    });

    // تخزين في الكاش
    this.cache.set(`search:${query}`, results);

    return ok(results);
  }

  /**
   * الحصول على البرامج حسب الفئة
   */
  getByCategory(categoryId: string): DesktopEntryInfo[] {
    const category = this.categories.get(categoryId);
    return category?.programs || [];
  }

  /**
   * الحصول على جميع الفئات
   */
  getCategories(): ProgramCategory[] {
    return Array.from(this.categories.values());
  }

  /**
   * الحصول على برامج حسب نوع الملف (MIME)
   */
  getByMimeType(mimeType: string): DesktopEntryInfo[] {
    return Array.from(this.programs.values()).filter(entry =>
      entry.mimeTypes.some(m => 
        m === mimeType || 
        (m.endsWith('/*') && mimeType.startsWith(m.slice(0, -1)))
      )
    );
  }

  /**
   * الحصول على إحصائيات
   */
  getStats(): CatalogStats {
    const byCategory: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const [id, category] of this.categories) {
      byCategory[id] = category.programs.length;
    }

    for (const entry of this.programs.values()) {
      bySource[entry.source] = (bySource[entry.source] || 0) + 1;
    }

    return {
      totalPrograms: this.programs.size,
      byCategory,
      bySource,
      lastScan: this.lastScanTime
    };
  }

  /**
   * تحميل الفهرس من التخزين (بدون مسح جديد)
   */
  async loadFromStorage(): Promise<Result<void, Error>> {
    const stored = await this.storage.load<{
      programs: DesktopEntryInfo[];
      lastScan: number;
    }>('program-catalog');

    if (stored.isErr) {
      return err(new Error('No saved catalog found'));
    }

    this.programs.clear();
    this.categories.clear();

    for (const entry of stored.value.programs) {
      this.programs.set(entry.id, entry);
      this.categorizeProgram(entry);
    }

    this.lastScanTime = stored.value.lastScan;
    return ok(undefined);
  }

  // ─── Private Methods ──────────────────────────────────────────────

  private categorizeProgram(entry: DesktopEntryInfo): void {
    // الفئات الرئيسية حسب معيار freedesktop
    const categoryMapping: Record<string, { name: string; nameAr: string; icon: string }> = {
      'Network': { name: 'Internet', nameAr: 'الإنترنت', icon: '🌐' },
      'WebBrowser': { name: 'Web Browsers', nameAr: 'متصفحات الويب', icon: '🌍' },
      'Email': { name: 'Email', nameAr: 'البريد الإلكتروني', icon: '📧' },
      'Development': { name: 'Development', nameAr: 'التطوير', icon: '💻' },
      'IDE': { name: 'IDEs', nameAr: 'بيئات التطوير', icon: '🛠️' },
      'TextEditor': { name: 'Text Editors', nameAr: 'محررات النصوص', icon: '📝' },
      'Graphics': { name: 'Graphics', nameAr: 'الرسوميات', icon: '🎨' },
      'Office': { name: 'Office', nameAr: 'المكتب', icon: '📊' },
      'AudioVideo': { name: 'Multimedia', nameAr: 'الوسائط المتعددة', icon: '🎬' },
      'Game': { name: 'Games', nameAr: 'الألعاب', icon: '🎮' },
      'System': { name: 'System', nameAr: 'النظام', icon: '⚙️' },
      'Utility': { name: 'Utilities', nameAr: 'الأدوات', icon: '🔧' },
      'TerminalEmulator': { name: 'Terminals', nameAr: 'الطرفيات', icon: '🖥️' },
      'FileManager': { name: 'File Managers', nameAr: 'مديرو الملفات', icon: '📁' },
      'Settings': { name: 'Settings', nameAr: 'الإعدادات', icon: '⚙️' }
    };

    for (const category of entry.categories) {
      const mapping = categoryMapping[category];
      if (!mapping) continue;

      if (!this.categories.has(category)) {
        this.categories.set(category, {
          id: category,
          name: mapping.name,
          nameAr: mapping.nameAr,
          icon: mapping.icon,
          programs: []
        });
      }

      this.categories.get(category)!.programs.push(entry);
    }

    // إذا لم يكن له فئة، أضفه إلى "أخرى"
    if (entry.categories.length === 0) {
      if (!this.categories.has('Other')) {
        this.categories.set('Other', {
          id: 'Other',
          name: 'Other',
          nameAr: 'أخرى',
          icon: '📦',
          programs: []
        });
      }
      this.categories.get('Other')!.programs.push(entry);
    }
  }
}
