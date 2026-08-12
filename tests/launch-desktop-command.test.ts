// tests/launch-desktop-command.test.ts
import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/kernel/core/event-bus';
import { CommandRegistry } from '../src/kernel/command-registry';
import { LinuxArchExecutionLayer } from '../src/agent-kernel/linux-arch-execution-layer';
import { LauncherManager } from '../src/host/launcher/launcher-manager';
import { SafeSystemStorageEngine } from '../src/system/storage';

describe('Launcher Desktop File Validation & Command Registry Tests', () => {
  it('should validate allowed system desktop directories and reject invalid/unauthorized paths', () => {
    const eventBus = new EventBus();
    const commandRegistry = new CommandRegistry();
    const executionLayer = new LinuxArchExecutionLayer();
    const storage = new SafeSystemStorageEngine('/vfs/test-launcher-desktop');

    const launcher = new LauncherManager(
      eventBus,
      commandRegistry,
      executionLayer,
      storage
    );

    // Valid paths
    expect(launcher.isValidDesktopFilePath('/usr/share/applications/firefox.desktop')).toBe(true);
    expect(launcher.isValidDesktopFilePath('/usr/local/share/applications/code.desktop')).toBe(true);
    expect(launcher.isValidDesktopFilePath('/var/lib/flatpak/exports/share/applications/org.gimp.GIMP.desktop')).toBe(true);
    expect(launcher.isValidDesktopFilePath('/var/lib/snapd/desktop/applications/vlc.desktop')).toBe(true);

    // Invalid / Malicious paths
    expect(launcher.isValidDesktopFilePath('/tmp/malicious.desktop')).toBe(false);
    expect(launcher.isValidDesktopFilePath('/etc/passwd')).toBe(false);
    expect(launcher.isValidDesktopFilePath('/usr/share/applications/../../etc/evil.desktop')).toBe(false);
    expect(launcher.isValidDesktopFilePath('/usr/share/applications/invalid-extension.txt')).toBe(false);
  });

  it('should execute launcher.launchDesktopFile via CommandRegistry for a valid path', async () => {
    const eventBus = new EventBus();
    const commandRegistry = new CommandRegistry();
    const executionLayer = new LinuxArchExecutionLayer({ isolateAbsoluteTargets: false });
    const storage = new SafeSystemStorageEngine('/vfs/test-launcher-desktop-cmd');

    const launcher = new LauncherManager(
      eventBus,
      commandRegistry,
      executionLayer,
      storage
    );

    // Direct method call test
    const validPath = '/usr/share/applications/firefox.desktop';
    const directRes = await launcher.launchDesktopFile(validPath);
    expect(directRes.isOk).toBe(true);
    if (directRes.isOk) {
      expect(directRes.value).toContain('Successfully launched desktop file with xdg-open');
    }

    // Command registry execution test
    const cmdRes = await commandRegistry.execute<any>('launcher.launchDesktopFile', {
      filePath: validPath
    });

    expect(cmdRes.isOk).toBe(true);
    if (cmdRes.isOk) {
      const innerRes = cmdRes.value;
      expect(innerRes.isOk).toBe(true);
      if (innerRes.isOk) {
        expect(innerRes.value).toContain('Successfully launched desktop file with xdg-open');
      }
    }
  });

  it('should reject execution via CommandRegistry for an unauthorized path', async () => {
    const eventBus = new EventBus();
    const commandRegistry = new CommandRegistry();
    const executionLayer = new LinuxArchExecutionLayer();
    const storage = new SafeSystemStorageEngine('/vfs/test-launcher-desktop-cmd-invalid');

    const launcher = new LauncherManager(
      eventBus,
      commandRegistry,
      executionLayer,
      storage
    );

    const invalidPath = '/tmp/unauthorized.desktop';
    const directRes = await launcher.launchDesktopFile(invalidPath);
    expect(directRes.isErr).toBe(true);
    if (directRes.isErr) {
      expect(directRes.error.message).toContain('Unauthorized or invalid desktop file path');
    }

    const cmdRes = await commandRegistry.execute<any>('launcher.launchDesktopFile', {
      filePath: invalidPath
    });

    expect(cmdRes.isOk).toBe(true);
    if (cmdRes.isOk) {
      const innerRes = cmdRes.value;
      expect(innerRes.isErr).toBe(true);
      if (innerRes.isErr) {
        expect(innerRes.error.message).toContain('Unauthorized or invalid desktop file path');
      }
    }
  });
});
