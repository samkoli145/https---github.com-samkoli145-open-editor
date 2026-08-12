// src/host/launcher/types.ts

export type LaunchMode = 
  | 'direct'           // الحالة 1: مباشر بدون نواة
  | 'managed'          // الحالة 2: عبر النواة
  | 'embedded'         // مضمّن داخل واجهتنا
  | 'background';      // في الخلفية بدون واجهة

export type EmbedStrategy = 
  | 'xembed'           // X11 XEmbed protocol
  | 'reparent'         // إعادة توجيه النافذة (X11)
  | 'kpart'            // KDE KParts
  | 'webview'          // لتطبيقات الويب/السيرفرات
  | 'external';        // نافذة خارجية (بدون تضمين)

export type DisplayServer = 'x11' | 'wayland';

export interface LaunchRequest {
  readonly programId: string;
  readonly binaryPath: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly workingDirectory?: string;
  readonly mode: LaunchMode;
  readonly embedStrategy?: EmbedStrategy;
  readonly windowTitle?: string;
  readonly timeout?: number;
}

export interface LaunchResult {
  readonly pid: number;
  readonly windowId?: string;       // X11 Window ID
  readonly waylandSurface?: string; // Wayland surface
  readonly port?: number;           // للسيرفرات
  readonly displayServer: DisplayServer;
  readonly embedded: boolean;
  readonly timestamp: number;
}

export interface ProcessInfo {
  readonly pid: number;
  readonly programId: string;
  readonly name: string;
  readonly status: 'running' | 'stopped' | 'zombie' | 'unknown';
  readonly cpuUsage: number;
  readonly memoryUsage: number;
  readonly startTime: number;
  readonly windowId?: string;
  readonly embedded: boolean;
}

export interface EmbedResult {
  readonly success: boolean;
  readonly containerId: string;     // معرف الحاوية في واجهتنا
  readonly windowId?: string;
  readonly error?: string;
}

export interface WindowGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
