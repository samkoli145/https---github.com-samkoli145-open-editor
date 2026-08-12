// src/host/discovery/ini-parser.ts
import { Result, ok, err } from '../../kernel/core/result';

export interface ParsedDesktopEntry {
  readonly entries: Map<string, string>;
  readonly rawEntries: Map<string, Map<string, string>>;
}

export class INIParser {
  /**
   * تحليل محتوى ملف .desktop وتفكيك المجموعات والمفاتيح المترجمة
   */
  public parse(content: string): Result<ParsedDesktopEntry, Error> {
    try {
      const lines = content.split('\n');
      const rawEntries = new Map<string, Map<string, string>>();
      const desktopEntries = new Map<string, string>();

      let currentGroup = '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        if (line.startsWith('[') && line.endsWith(']')) {
          currentGroup = line.slice(1, -1).trim();
          if (!rawEntries.has(currentGroup)) {
            rawEntries.set(currentGroup, new Map<string, string>());
          }
          continue;
        }

        const eqIdx = line.indexOf('=');
        if (eqIdx !== -1) {
          const key = line.substring(0, eqIdx).trim();
          const value = line.substring(eqIdx + 1).trim();

          if (currentGroup) {
            const groupMap = rawEntries.get(currentGroup);
            if (groupMap) {
              groupMap.set(key, value);
            }
          }

          if (currentGroup === 'Desktop Entry') {
            desktopEntries.set(key, value);
          }
        }
      }

      return ok({
        entries: desktopEntries,
        rawEntries
      });
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * استخراج قيمة مترجمة مثل Name[ar] أو Comment[ar]
   */
  public getLocalizedValue(
    parsed: ParsedDesktopEntry,
    key: string,
    lang: string
  ): string | undefined {
    const desktopGroup = parsed.rawEntries.get('Desktop Entry');
    if (!desktopGroup) return undefined;

    // 1. البحث المطابق مع اللغة والبلد مثل Name[ar_SA]
    const exactLangKey = `${key}[${lang}]`;
    if (desktopGroup.has(exactLangKey)) {
      return desktopGroup.get(exactLangKey);
    }

    // 2. البحث المطابق مع لغة العائلة فقط (مثل ar)
    const baseLang = lang.split('_')[0];
    const baseLangKey = `${key}[${baseLang}]`;
    if (desktopGroup.has(baseLangKey)) {
      return desktopGroup.get(baseLangKey);
    }

    return undefined;
  }
}
