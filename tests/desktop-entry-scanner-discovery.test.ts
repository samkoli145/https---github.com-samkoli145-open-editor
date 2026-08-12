// tests/desktop-entry-scanner-discovery.test.ts
import { describe, it, expect } from 'vitest';
import { INIParser } from '../src/host/discovery/ini-parser';
import { DesktopEntryScanner } from '../src/host/discovery/desktop-entry-scanner';

describe('DesktopEntryScanner & INIParser Tests', () => {
  it('INIParser should parse desktop file with Arabic localized values', () => {
    const parser = new INIParser();
    const content = `
[Desktop Entry]
Version=1.0
Type=Application
Name=Firefox Web Browser
Name[ar]=متصفح الويب فايرفوكس
Comment=Browse the Web
Comment[ar]=تصفح شبكة الويب العالمية
Exec=firefox %u
Icon=firefox
Categories=Network;WebBrowser;
MimeType=text/html;x-scheme-handler/http;
    `.trim();

    const result = parser.parse(content);
    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.entries.get('Name')).toBe('Firefox Web Browser');
      expect(parser.getLocalizedValue(result.value, 'Name', 'ar')).toBe('متصفح الويب فايرفوكس');
      expect(parser.getLocalizedValue(result.value, 'Comment', 'ar')).toBe('تصفح شبكة الويب العالمية');
    }
  });

  it('DesktopEntryScanner should parse desktop content and strip freedesktop placeholders', () => {
    const scanner = new DesktopEntryScanner();
    const content = `
[Desktop Entry]
Type=Application
Name=Google Chrome
Name[ar]=جوجل كروم
Exec=google-chrome-stable %U
Icon=google-chrome
Categories=Network;WebBrowser;
MimeType=text/html;x-scheme-handler/https;
Keywords=browser;internet;web;
    `.trim();

    const parseResult = scanner.parseDesktopContent(content, '/usr/share/applications/google-chrome.desktop', 'system');
    expect(parseResult.isOk).toBe(true);
    if (parseResult.isOk) {
      const entry = parseResult.value;
      expect(entry.id).toBe('google-chrome');
      expect(entry.name).toBe('Google Chrome');
      expect(entry.nameAr).toBe('جوجل كروم');
      expect(entry.categories).toContain('Network');
      expect(entry.categories).toContain('WebBrowser');
      
      const cmd = scanner.getExecCommand(entry, 'https://example.com');
      expect(cmd).toBe('google-chrome-stable "https://example.com"');
    }
  });

  it('DesktopEntryScanner should ignore hidden desktop entries', () => {
    const scanner = new DesktopEntryScanner();
    const hiddenContent = `
[Desktop Entry]
Type=Application
Name=Internal Helper
Exec=helper
NoDisplay=true
    `.trim();

    const parseResult = scanner.parseDesktopContent(hiddenContent, '/usr/share/applications/helper.desktop', 'system');
    expect(parseResult.isErr).toBe(true);
  });
});
