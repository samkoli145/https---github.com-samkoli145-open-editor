// tests/launcher-discovery.test.ts
import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/kernel/core/event-bus';
import { CommandRegistry } from '../src/kernel/command-registry';
import { LinuxArchExecutionLayer } from '../src/agent-kernel/linux-arch-execution-layer';
import { LauncherManager } from '../src/host/launcher/launcher-manager';
import { SafeSystemStorageEngine } from '../src/system/storage';

describe('LauncherManager Discovery Practical Integration Test', () => {
  it('should run discoverPrograms() and return CatalogStats structured metrics', async () => {
    const eventBus = new EventBus();
    const commandRegistry = new CommandRegistry();
    const executionLayer = new LinuxArchExecutionLayer();
    const storage = new SafeSystemStorageEngine('/vfs/launcher-discovery-test');

    const launcher = new LauncherManager(
      eventBus,
      commandRegistry,
      executionLayer,
      storage
    );

    // Populate mock entries directly into catalog to simulate CachyOS/KDE scan
    const scanner = launcher['discoveryScanner'];
    const catalog = launcher['catalog'];

    const mockApps = [
      { content: '[Desktop Entry]\nType=Application\nName=Firefox\nExec=firefox %u\nCategories=Network;WebBrowser;', path: '/usr/share/applications/firefox.desktop', source: 'system' as const },
      { content: '[Desktop Entry]\nType=Application\nName=VSCode\nExec=code\nCategories=Development;IDE;', path: '/usr/local/share/applications/code.desktop', source: 'local' as const },
      { content: '[Desktop Entry]\nType=Application\nName=GIMP\nExec=gimp\nCategories=Graphics;', path: '/var/lib/flatpak/exports/share/applications/org.gimp.GIMP.desktop', source: 'flatpak' as const },
      { content: '[Desktop Entry]\nType=Application\nName=VLC\nExec=vlc\nCategories=AudioVideo;', path: '/var/lib/snapd/desktop/applications/vlc.desktop', source: 'snap' as const },
      { content: '[Desktop Entry]\nType=Application\nName=CustomTool\nExec=custom\nCategories=Utility;', path: `${process.env.HOME}/.local/share/applications/custom.desktop`, source: 'user' as const }
    ];

    for (const app of mockApps) {
      const parsed = scanner.parseDesktopContent(app.content, app.path, app.source);
      if (parsed.isOk) {
        catalog['programs'].set(parsed.value.id, parsed.value);
        catalog['categorizeProgram'](parsed.value);
      }
    }

    const stats = catalog.getStats();

    expect(stats.totalPrograms).toBe(5);
    expect(stats.byCategory['Network']).toBe(1);
    expect(stats.byCategory['Development']).toBe(1);
    expect(stats.byCategory['Graphics']).toBe(1);
    expect(stats.byCategory['AudioVideo']).toBe(1);
    expect(stats.byCategory['Utility']).toBe(1);

    expect(stats.bySource['system']).toBe(1);
    expect(stats.bySource['local']).toBe(1);
    expect(stats.bySource['flatpak']).toBe(1);
    expect(stats.bySource['snap']).toBe(1);
    expect(stats.bySource['user']).toBe(1);

    // Search validation
    const searchRes = await launcher.searchPrograms('VSCode');
    expect(searchRes.isOk).toBe(true);
    if (searchRes.isOk) {
      expect(searchRes.value[0].id).toBe('code');
    }
  });
});
