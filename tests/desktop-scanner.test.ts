// tests/desktop-scanner.test.ts
import { describe, it, expect } from 'vitest';
import { DesktopEntryScanner } from '../src/host/launcher/desktop-scanner';

describe('DesktopEntryScanner Tests', () => {
  it('should parse XDG Desktop Entry file content for Firefox', () => {
    const scanner = new DesktopEntryScanner();

    const firefoxDesktopContent = `
[Desktop Entry]
Version=1.0
Name=Firefox Web Browser
Name[ar]=متصفح الويب فايرفوكس
Comment=Browse the World Wide Web
Exec=firefox %u
Icon=firefox
Terminal=false
Type=Application
Categories=GNOME;GTK;Network;WebBrowser;
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
StartupNotify=true
    `.trim();

    const parsed = scanner.parseDesktopEntry(firefoxDesktopContent, '/usr/share/applications/firefox.desktop');
    expect(parsed).not.toBeNull();
    if (parsed) {
      expect(parsed.name).toBe('Firefox Web Browser');
      expect(parsed.exec).toBe('firefox');
      expect(parsed.binaryName).toBe('firefox');
      expect(parsed.isInternetApp).toBe(true);
      expect(parsed.internetCategory).toBe('browser');
      expect(parsed.categories).toContain('network');
      expect(parsed.categories).toContain('webbrowser');
    }
  });

  it('should parse Thunderbird desktop entry as an email application', () => {
    const scanner = new DesktopEntryScanner();

    const thunderbirdDesktopContent = `
[Desktop Entry]
Name=Thunderbird
Exec=thunderbird %u
Icon=thunderbird
Type=Application
Categories=Network;Email;
MimeType=message/rfc822;x-scheme-handler/mailto;
    `.trim();

    const parsed = scanner.parseDesktopEntry(thunderbirdDesktopContent, '/usr/share/applications/thunderbird.desktop');
    expect(parsed).not.toBeNull();
    if (parsed) {
      expect(parsed.name).toBe('Thunderbird');
      expect(parsed.isInternetApp).toBe(true);
      expect(parsed.internetCategory).toBe('email');
    }
  });

  it('should filter non-application desktop entries', () => {
    const scanner = new DesktopEntryScanner();

    const directoryDesktopContent = `
[Desktop Entry]
Name=System Settings
Type=Directory
    `.trim();

    const parsed = scanner.parseDesktopEntry(directoryDesktopContent, '/usr/share/desktop-directories/System.directory');
    expect(parsed).toBeNull();
  });

  it('should scan fallback binaries and find internet apps', async () => {
    const scanner = new DesktopEntryScanner();
    const result = await scanner.scanApplications();

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      const internetApps = scanner.getInternetApplications();
      expect(internetApps.length).toBeGreaterThan(0);
      const codeServer = internetApps.find(a => a.id === 'code-server');
      expect(codeServer).toBeDefined();
      expect(codeServer?.internetCategory).toBe('web-tool');
    }
  });
});
