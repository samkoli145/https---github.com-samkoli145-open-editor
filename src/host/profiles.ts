import type { LocalizedString } from '../kernel/i18n/localized-string';

export type ProfileName = 'headless' | 'agent' | 'hermes' | 'editor';

export interface ProfileConfig {
  name: ProfileName;
  title: LocalizedString;
  enableAgentKernel: boolean;
  enableHermes: boolean;
  enableEditor: boolean;
  enableLinuxHost: boolean;
  description: LocalizedString;
}

export const PROFILES: Record<ProfileName, ProfileConfig> = {
  headless: {
    name: 'headless',
    title: { ar: 'النمط الميكانيكي (Headless)', en: 'Headless Profile' },
    enableAgentKernel: false,
    enableHermes: false,
    enableEditor: false,
    enableLinuxHost: true,
    description: { ar: 'تشغيل نواة P الأساسية فقط مع VFS والأوامر الميكانيكية.', en: 'Run core P kernel with VFS and basic commands.' }
  },
  agent: {
    name: 'agent',
    title: { ar: 'نمط الوكيل الذكي (Agent AIOS)', en: 'Agent AIOS Profile' },
    enableAgentKernel: true,
    enableHermes: false,
    enableEditor: false,
    enableLinuxHost: true,
    description: { ar: 'تشغيل الوكيل الذكي محلياً مع إدارة الذاكرة والصلاحيات وSyscalls.', en: 'Run local agent kernel with memory, access control, and syscalls.' }
  },
  hermes: {
    name: 'hermes',
    title: { ar: 'نمط هيرمس التعليمي (Hermes Teacher)', en: 'Hermes Profile' },
    enableAgentKernel: true,
    enableHermes: true,
    enableEditor: false,
    enableLinuxHost: true,
    description: { ar: 'تشغيل حلقة التعلّم والمفكرة والمستندات التدريبية الموطنة.', en: 'Run learning loop, notebook, and localized training materials.' }
  },
  editor: {
    name: 'editor',
    title: { ar: 'نمط المحرر الكامل (Workbench / Editor)', en: 'Editor Workbench Profile' },
    enableAgentKernel: true,
    enableHermes: true,
    enableEditor: true,
    enableLinuxHost: true,
    description: { ar: 'تشغيل بيئة المحرر مع التبويبات والمستندات والرموز وحزم اللغات.', en: 'Run full editor workbench with tabs, documents, symbols, and language packs.' }
  }
};
