// tests/program-catalog.test.ts
import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/kernel/core/event-bus';
import { SafeSystemStorageEngine } from '../src/system/storage';
import { DesktopEntryScanner } from '../src/host/discovery/desktop-entry-scanner';
import { ProgramCatalog } from '../src/host/discovery/program-catalog';

describe('ProgramCatalog Tests', () => {
  it('should build catalog, categorize applications, and perform cached search', async () => {
    const eventBus = new EventBus();
    const storage = new SafeSystemStorageEngine('/vfs/test-storage');
    const scanner = new DesktopEntryScanner(undefined, eventBus);

    // Mock parse and entries
    const f1 = scanner.parseDesktopContent(`
[Desktop Entry]
Type=Application
Name=Firefox
Name[ar]=فايرفوكس
Exec=firefox %u
Categories=Network;WebBrowser;
    `.trim(), '/usr/share/applications/firefox.desktop');

    const f2 = scanner.parseDesktopContent(`
[Desktop Entry]
Type=Application
Name=VS Code
Name[ar]=في اس كود
Exec=code
Categories=Development;IDE;
    `.trim(), '/usr/share/applications/code.desktop');

    const catalog = new ProgramCatalog(scanner, storage, eventBus);

    // Build catalog manually with entries
    if (f1.isOk && f2.isOk) {
      // @ts-ignore - Populate map directly for test predictability
      catalog['programs'].set(f1.value.id, f1.value);
      // @ts-ignore
      catalog['categorizeProgram'](f1.value);

      // @ts-ignore
      catalog['programs'].set(f2.value.id, f2.value);
      // @ts-ignore
      catalog['categorizeProgram'](f2.value);
    }

    const all = catalog.getAllPrograms();
    expect(all.length).toBe(2);

    const categories = catalog.getCategories();
    expect(categories.length).toBeGreaterThan(0);

    const networkCategory = catalog.getByCategory('Network');
    expect(networkCategory.length).toBe(1);
    expect(networkCategory[0].name).toBe('Firefox');

    const searchRes = await catalog.search('فايرفوكس');
    expect(searchRes.isOk).toBe(true);
    if (searchRes.isOk) {
      expect(searchRes.value.length).toBe(1);
      expect(searchRes.value[0].id).toBe('firefox');
    }

    const stats = catalog.getStats();
    expect(stats.totalPrograms).toBe(2);
  });
});
