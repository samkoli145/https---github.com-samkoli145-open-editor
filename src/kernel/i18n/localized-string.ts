export interface LocalizedString {
  ar: string;
  en: string;
}

export function localize(
  str: LocalizedString | string | null | undefined,
  lang: 'ar' | 'en' = 'ar'
): string {
  if (!str) return '';
  if (typeof str === 'string') return str;
  const primary = str[lang];
  if (primary && primary.trim() !== '') return primary;
  const fallbackAr = str.ar;
  if (fallbackAr && fallbackAr.trim() !== '') return fallbackAr;
  const fallbackEn = str.en;
  if (fallbackEn && fallbackEn.trim() !== '') return fallbackEn;
  return '';
}
