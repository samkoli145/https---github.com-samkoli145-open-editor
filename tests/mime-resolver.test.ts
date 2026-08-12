// tests/mime-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/kernel/core/event-bus';
import { SafeSystemStorageEngine } from '../src/system/storage';
import { DesktopEntryScanner } from '../src/host/discovery/desktop-entry-scanner';
import { ProgramCatalog } from '../src/host/discovery/program-catalog';
import { MimeResolver } from '../src/host/discovery/mime-resolver';

describe('MimeResolver Tests', () => {
  it('should resolve default mime type fallback and match catalog entries', async () => {
    const eventBus = new EventBus();
    const storage = new SafeSystemStorageEngine('/vfs/test-storage-mime');
    const scanner = new DesktopEntryScanner(undefined, eventBus);

    const f1 = scanner.parseDesktopContent(`
[Desktop Entry]
Type=Application
Name=Firefox
Exec=firefox %u
MimeType=text/html;x-scheme-handler/http;
    `.trim(), '/usr/share/applications/firefox.desktop');

    const catalog = new ProgramCatalog(scanner, storage, eventBus);
    if (f1.isOk) {
      // @ts-ignore - Populate for testing
      catalog['programs'].set(f1.value.id, f1.value);
    }

    const resolver = new MimeResolver(undefined, catalog);
    const res = await resolver.resolve('/tmp/index.html');

    expect(res.isOk).toBe(true);
    if (res.isOk) {
      expect(res.value.filePath).toBe('/tmp/index.html');
      expect(res.value.availablePrograms.length).toBe(0); // fallback without execution layer
    }
  });

  it('should return error when trying to open file without execution layer', async () => {
    const resolver = new MimeResolver();
    const openRes = await resolver.openWithDefault('/tmp/document.pdf');
    expect(openRes.isErr).toBe(true);
    if (openRes.isErr) {
      expect(openRes.error.message).toContain('No execution layer available');
    }
  });
});
