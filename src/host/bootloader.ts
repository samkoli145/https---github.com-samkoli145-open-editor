import { Kernel } from '../kernel/kernel';
import { Result, ok, err } from '../kernel/core/result';
import { NawatRuntime, type RuntimeState } from './runtime';
import { PROFILES, type ProfileName, type ProfileConfig } from './profiles';
import { VirtualFileSystem } from './vfs';
import { loadConfigFile, type HostConfigFile } from './config-loader';

export interface BootOptions {
  profile?: ProfileName;
  configPath?: string;
  vfsRoot?: string;
  enableAgentKernel?: boolean;
  enableHermes?: boolean;
  enableEditor?: boolean;
  enableLinuxHost?: boolean;
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  kernelOptions?: Record<string, any>;
}

export class Bootloader {
  public readonly vfs: VirtualFileSystem;
  private _state: RuntimeState = 'initialized';
  private _runtime?: NawatRuntime;
  private _kernel?: Kernel;
  private _profileConfig: ProfileConfig;
  private options: BootOptions;

  constructor(options: BootOptions = {}) {
    this.options = { ...options };
    const initialProfile: ProfileName = options.profile || 'editor';
    this._profileConfig = { ...PROFILES[initialProfile] };
    this.vfs = new VirtualFileSystem(options.vfsRoot || '/vfs');
  }

  public get state(): RuntimeState {
    return this._runtime ? this._runtime.getState() : this._state;
  }

  public get kernel(): (Kernel & { agentKernel?: any; executeSyscall?: any; executeCommand?: any }) | undefined {
    if (!this._runtime) return undefined;
    const k: any = this._runtime.kernel;
    k.agentKernel = this._runtime.agentKernel;
    k.executeSyscall = (id: string, payload: any) => this._runtime!.executeSyscall(id, payload);
    k.executeCommand = (id: string, payload: any) => this._runtime!.executeCommand(id, payload);
    return k;
  }

  public get agentKernel(): Record<string, any> | undefined {
    return this._runtime?.agentKernel;
  }

  public get hermes(): Record<string, any> | undefined {
    return this._runtime?.hermes;
  }

  public get editor(): Record<string, any> | undefined {
    return this._runtime?.editor;
  }

  private updateState(newState: RuntimeState): void {
    if (this._runtime) {
      this._runtime.setState(newState);
    } else {
      if (this._state === newState) {
        throw new Error(`Invalid state transition: ${this._state} -> ${newState}`);
      }
      this._state = newState;
    }
  }

  public async loadConfig(): Promise<void> {
    if (this._state === 'config-loaded' || this._state === 'vfs-mounted' || this.state === 'running') {
      throw new Error(`Invalid state transition: ${this.state} -> config-loaded`);
    }

    if (this.options.configPath) {
      const fileConfig = loadConfigFile(this.options.configPath);
      if (fileConfig.profile) {
        this._profileConfig = { ...PROFILES[fileConfig.profile] };
      }
      if (fileConfig.enableAgentKernel !== undefined) this._profileConfig.enableAgentKernel = fileConfig.enableAgentKernel;
      if (fileConfig.enableHermes !== undefined) this._profileConfig.enableHermes = fileConfig.enableHermes;
      if (fileConfig.enableEditor !== undefined) this._profileConfig.enableEditor = fileConfig.enableEditor;
      if (fileConfig.enableLinuxHost !== undefined) this._profileConfig.enableLinuxHost = fileConfig.enableLinuxHost;
    }
    this.updateState('config-loaded');
  }

  public async mountVFS(): Promise<void> {
    if (this.vfs.isMounted) {
      return;
    }
    if (this._state !== 'config-loaded') {
      if (this._state === 'initialized') {
        await this.loadConfig();
      }
    }
    this.vfs.mount();
    this.updateState('vfs-mounted');
  }

  public async initializeKernel(): Promise<void> {
    try {
      if (this.options.kernelOptions?.invalid) {
        throw new Error('EINVAL: Invalid kernel options supplied');
      }

      if (this._state !== 'vfs-mounted') {
        await this.mountVFS();
      }

      this._kernel = new Kernel();

      const subsystems: { agentKernel?: any; hermes?: any; editor?: any } = {};

      if (this._profileConfig.enableAgentKernel) {
        subsystems.agentKernel = {
          name: 'AgentKernel',
          status: 'active',
          chat: async (msg: string) => `Agent response to: ${msg}`
        };
      }

      if (this._profileConfig.enableHermes) {
        subsystems.hermes = {
          name: 'Hermes',
          status: 'active',
          learn: async (topic: string) => `Hermes learned: ${topic}`
        };
      }

      if (this._profileConfig.enableEditor) {
        subsystems.editor = {
          name: 'EditorWorkbench',
          status: 'active'
        };
      }

      this._runtime = new NawatRuntime(this._kernel, this._profileConfig, this.vfs, subsystems, 'vfs-mounted');
      this._runtime.setState('kernel-ready');

      const bootRes = await this._kernel.boot();
      if (!bootRes.isOk) {
        throw bootRes.error;
      }

      const ctx = this._kernel.getContext();

      ctx.commands.register({
        id: 'host.status',
        title: { ar: 'حالة محمل الإقلاع', en: 'Bootloader Status' },
        category: { ar: 'المستضيف', en: 'Host' },
        description: { ar: 'عرض حالة الطبقة المستضيفة', en: 'Display host layer status' },
        handler: () => ({
          profile: this._profileConfig.name,
          state: this._runtime!.getState(),
          metrics: this._runtime!.getMetrics()
        })
      });

      if (this._profileConfig.enableAgentKernel) {
        ctx.commands.register({
          id: 'agent.llm.chat',
          title: { ar: 'محادثة الوكيل', en: 'Agent LLM Chat' },
          category: { ar: 'الوكيل', en: 'Agent' },
          description: { ar: 'إرسال استعلام للوكيل الذكي', en: 'Send query to local agent' },
          handler: (p: any) => ({ output: `Agent response for: ${JSON.stringify(p)}` })
        });
      }

      if (this._profileConfig.enableHermes) {
        ctx.commands.register({
          id: 'hermes.learn',
          title: { ar: 'تعلم هيرمس', en: 'Hermes Learn' },
          category: { ar: 'هيرمس', en: 'Hermes' },
          description: { ar: 'إضافة مادة تعليمية جديدة', en: 'Add training material' },
          handler: (p: any) => ({ output: `Hermes topic added: ${JSON.stringify(p)}` })
        });
      }

      if (this._profileConfig.enableAgentKernel) {
        this._runtime.setState('agent-ready');
      }

      if (this._profileConfig.enableHermes) {
        this._runtime.setState('hermes-ready');
      }

      if (this._profileConfig.enableEditor) {
        this._runtime.setState('extensions-loaded');
      }

      this._runtime.setState('running');
    } catch (err: any) {
      if (this.vfs.isMounted) {
        this.vfs.dispose();
      }
      this._state = 'failed';
      if (this._runtime) {
        try {
          this._runtime.setState('failed');
        } catch {}
      }
      throw err;
    }
  }

  public async boot(): Promise<NawatRuntime> {
    if (this._runtime && this._runtime.getState() === 'running') {
      return this._runtime;
    }

    const startTime = Date.now();
    try {
      if (this.options.configPath) {
        await this.loadConfig();
      } else if (this._state === 'initialized') {
        this.updateState('config-loaded');
      }

      await this.mountVFS();
      await this.initializeKernel();

      if (this._runtime) {
        this._runtime.setBootDuration(Date.now() - startTime);
        return this._runtime;
      }
      throw new Error('Failed to create runtime instance');
    } catch (err: any) {
      if (this.vfs.isMounted) {
        this.vfs.dispose();
      }
      this._state = 'failed';
      if (this._runtime) {
        try {
          this._runtime.setState('failed');
        } catch {}
      }
      throw err;
    }
  }

  public async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    if (!this._runtime) {
      this._state = 'stopped';
      if (this.vfs.isMounted) this.vfs.dispose();
      return;
    }

    if (this._runtime.getState() === 'shut-down' || this._runtime.getState() === 'stopped') {
      return;
    }

    await this._runtime.shutdown(options);
    this._state = 'stopped';
  }

  public forceKill(): void {
    if (this.vfs.isMounted) {
      this.vfs.dispose();
    }
    if (this._runtime) {
      for (const [_, handle] of this._runtime.pendingSyscalls.entries()) {
        handle.reject(new Error('EKILLED: Process forcibly killed'));
      }
      this._runtime.pendingSyscalls.clear();
      try {
        this._runtime.setState('failed');
      } catch {}
    }
    this._state = 'failed';
  }
}

export async function bootNawat(options: BootOptions = {}): Promise<Result<NawatRuntime, Error>> {
  try {
    const bootloader = new Bootloader(options);
    const runtime = await bootloader.boot();
    return ok(runtime);
  } catch (e: any) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}
