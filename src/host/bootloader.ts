import { Kernel } from '../kernel/kernel';
import { Result, ok, err } from '../kernel/core/result';
import { NawatRuntime, type RuntimeState } from './runtime';
import { PROFILES, type ProfileName, type ProfileConfig } from './profiles';
import { VirtualFileSystem } from './vfs';
import { loadConfigFile, type HostConfigFile } from './config-loader';
import { HermesKernel } from '../agent-kernel/hermes/hermes-kernel';
import { AgentKernel } from '../agent-kernel/agent-kernel';
import { ToolRegistry } from '../agent-kernel/tools';
import { SafeStorageEngine } from '../agent-kernel/storage';
import { LLMCore, DeterministicBackend, backendsFromDiscoveredServers, type ILLMBackend } from '../agent-kernel/llm-core';
import { discoverLocalLLMServers, type LocalLLMServerInfo, type LocalServerDiscoveryOptions } from '../agent-kernel/local-server-discovery';
import { InferenceGovernor, DefaultResourceProbe } from '../agent-kernel/inference-governor';
import { SessionManager } from '../agent-kernel/session';
import { ResourceQuotaGuard } from '../agent-kernel/quota';
import { EditorManager } from './editor-manager';
import { SnowballEngine } from './snowball';
import { LanguageServerProtocolAdapter } from './lsp-adapter';

export interface BootOptions {
  profile?: ProfileName;
  configPath?: string;
  vfsRoot?: string;
  enableAgentKernel?: boolean;
  enableHermes?: boolean;
  enableEditor?: boolean;
  enableLinuxHost?: boolean;
  /** اكتشاف سيرفرات LLM المحلية تلقائياً عند الإقلاع (افتراضي: من ملف الإعداد أو البروفايل) */
  enableLLMDiscovery?: boolean;
  /** إعدادات الاكتشاف (منافذ/مضيفين/مهلة/تزامن/fetchImpl) */
  llmDiscovery?: LocalServerDiscoveryOptions;
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
  private _llmServers: LocalLLMServerInfo[] = [];

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

  /** سيرفرات LLM المكتشفة عند الإقلاع (فارغة إن عُطّل الاكتشاف أو لم يستجب شيء) */
  public get discoveredLLMServers(): LocalLLMServerInfo[] {
    return this._llmServers;
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
      if (fileConfig.enableLLMDiscovery !== undefined) this._profileConfig.enableLLMDiscovery = fileConfig.enableLLMDiscovery;
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

      const subsystems: { agentKernel?: any; hermes?: any; editor?: any; snowball?: any } = {};

      // نواة الوكيل العليا الحقيقية (AgentKernel) — LLMCore + ToolRegistry (موصول بسجل الأوامر) + SessionManager (موصول بالحصص)
      if (this._profileConfig.enableAgentKernel) {
        const quotaGuard = new ResourceQuotaGuard();
        const sessions = new SessionManager(this._kernel.getContext().events, quotaGuard);
        const tools = new ToolRegistry(this._kernel.getContext().commands);

        // الخلفية الحتمية أولاً (fallback)، ثم خلفيات سيرفرات LLM المكتشفة إن فُعّل الاكتشاف
        const backends: ILLMBackend[] = [new DeterministicBackend({
          defaultResponse: 'Deterministic response from local agent'
        })];
        const enableDiscovery = this.options.enableLLMDiscovery ?? this._profileConfig.enableLLMDiscovery;
        let governor: InferenceGovernor | undefined;
        if (enableDiscovery) {
          try {
            const discovered = await discoverLocalLLMServers(this.options.llmDiscovery ?? {});
            this._llmServers = discovered;
            const discoveredBackends = backendsFromDiscoveredServers(discovered);
            backends.push(...discoveredBackends);
            // حاكم موارد الاستدلال: يفعَّل فقط عند وجود خلفيات Ollama حقيقية مكتشفة
            if (discoveredBackends.length > 0) {
              const first = discoveredBackends[0];
              const baseUrl = (first as unknown as { baseUrl?: string }).baseUrl ?? 'http://127.0.0.1:11434';
              governor = new InferenceGovernor(new DefaultResourceProbe(), { baseUrl });
            }
          } catch {
            // الاكتشاف اختياري؛ فشله لا يُسقط الإقلاع
          }
        }

        const agentKernel = new AgentKernel({
          backends,
          tools,
          quota: quotaGuard,
          sessions,
          storage: new SafeStorageEngine(),
          governor,
        });
        await agentKernel.boot();
        agentKernel.attach(this._kernel);
        subsystems.agentKernel = agentKernel;
      }

      // نواة هيرمس حقيقية (HermesKernel) بدل mock — تعريض serve/learn/hermesKernel عبر البوابة
      if (this._profileConfig.enableHermes) {
        const hermesKernel = new HermesKernel(new ToolRegistry(), new SafeStorageEngine());
        subsystems.hermes = {
          name: 'Hermes',
          status: 'active',
          kernel: hermesKernel,
          hermesKernel,
          serve: (input: string, toolName?: string, toolArgs?: any) =>
            hermesKernel.serve(input, toolName, toolArgs),
          serveText: async (input: string, toolName?: string, toolArgs?: any): Promise<{ status: string; output: string }> => {
            const res = await hermesKernel.serve(input, toolName, toolArgs);
            if (res.isErr) {
              return { status: 'error', output: String(res.error?.message ?? res.error) };
            }
            const value = res.value ?? {};
            const status = (value as any)?.status ?? 'completed';
            const output = (value as any)?.result ?? (value as any)?.value ?? (value as any)?.reason ?? '';
            return { status: String(status), output: String(output ?? '') };
          },
          learn: async (topic: string): Promise<string> => {
            const res = await hermesKernel.learn({
              sessionId: 'boot',
              materials: [{
                id: `boot_${Date.now()}`,
                type: 'fact',
                content: String(topic ?? ''),
                priority: 'normal'
              }]
            });
            return res.isOk ? `Hermes learned: ${topic}` : `Hermes error: ${res.error.message}`;
          }
        };
      }

      const snowballEngine = new SnowballEngine();
      subsystems.snowball = {
        name: 'SnowballEngine',
        status: 'active',
        engine: snowballEngine,
        getMetrics: () => snowballEngine.getMetrics(),
        record: (type: any, source: string, payload: any, ctx?: any) => snowballEngine.recordInteraction(type, source, payload, ctx),
        predict: (ctx: any) => snowballEngine.predict(ctx),
        recall: (q: any) => snowballEngine.recall(q)
      };

      if (this._profileConfig.enableEditor) {
        const editorManager = new EditorManager();
        editorManager.scanSystemForEditors();
        const lspAdapter = new LanguageServerProtocolAdapter();

        subsystems.editor = {
          name: 'EditorWorkbench',
          status: 'active',
          manager: editorManager,
          editorManager,
          lspAdapter,
          snowball: snowballEngine,
          scan: () => editorManager.getDiscoveredTools(),
          openFile: (filePath: string, line?: number, toolId?: string) => editorManager.openFile(filePath, line, toolId),
          dispatch: (intent: any, payload: any) => editorManager.dispatchIntent(intent, payload)
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

      if (this._profileConfig.enableEditor) {
        ctx.commands.register({
          id: 'host.editor.scan',
          title: { ar: 'فحص المحررات والأدوات المثبتة', en: 'Scan Installed Editors & Tools' },
          category: { ar: 'المحرر', en: 'Editor' },
          description: { ar: 'اكتشاف المحررات وأدوات التطوير على النظام', en: 'Discover installed system editors and tools' },
          handler: () => {
            const ed = this.editor;
            return ed?.manager ? ed.manager.getDiscoveredTools() : [];
          }
        });

        ctx.commands.register({
          id: 'host.editor.open',
          title: { ar: 'فتح ملف في أداة تطوير', en: 'Open File in Editor Tool' },
          category: { ar: 'المحرر', en: 'Editor' },
          description: { ar: 'توجيه فتح الملف للمحرر المناسب', en: 'Open target file using best editor' },
          handler: async (p: any) => {
            const ed = this.editor;
            if (!ed?.manager) return { error: 'Editor manager unavailable' };
            const res = await ed.manager.openFile(p?.path || p?.filePath || 'server.ts', p?.line || 1, p?.toolId);
            return res.isOk ? res.value : { error: res.error.message };
          }
        });

        ctx.commands.register({
          id: 'host.orchestrator.dispatch',
          title: { ar: 'توجيه العقل الموجه', en: 'Orchestrator Kernel Dispatch' },
          category: { ar: 'النواة', en: 'Kernel' },
          description: { ar: 'معالجة النواة كعقل موجه لأدوات النظام', en: 'Dispatch intent to system tool agents' },
          handler: async (p: any) => {
            const ed = this.editor;
            if (!ed?.manager) return { error: 'Editor manager unavailable' };
            const res = await ed.manager.dispatchIntent(p?.intent || 'inspect', p || {});
            return res.isOk ? res.value : { error: res.error.message };
          }
        });

        ctx.commands.register({
          id: 'host.lsp.diagnose',
          title: { ar: 'فحص التشخيصات اللغوية LSP', en: 'LSP Language Diagnostics' },
          category: { ar: 'المحرر', en: 'Editor' },
          description: { ar: 'قراءة أخطاء وتوجيهات خوادم اللغات', en: 'Get diagnostics from language servers' },
          handler: async (p: any) => {
            const ed = this.editor;
            if (!ed?.lspAdapter) return [];
            const res = await ed.lspAdapter.getDiagnostics(p?.path || p?.filePath || 'server.ts');
            return res.isOk ? res.value : [];
          }
        });

        ctx.commands.register({
          id: 'host.snowball.metrics',
          title: { ar: 'مؤشرات محرك كرة الثلج المعرفي', en: 'Snowball Engine Metrics' },
          category: { ar: 'التعلم الذاتي', en: 'Snowball Learning' },
          description: { ar: 'عرض إحصائيات التراكم المعرفي والتنبؤات', en: 'Get snowball engine metrics and layers' },
          handler: () => {
            const sb = this._runtime?.snowball;
            return sb ? sb.getMetrics() : { totalInteractions: 0, totalKnowledge: 0 };
          }
        });

        ctx.commands.register({
          id: 'host.snowball.record',
          title: { ar: 'تسجيل تفاعل في محرك التعلم', en: 'Record Snowball Interaction' },
          category: { ar: 'التعلم الذاتي', en: 'Snowball Learning' },
          description: { ar: 'تسجيل حدث واستخراج أنماط التعلم', en: 'Record interaction and extract patterns' },
          handler: async (p: any) => {
            const sb = this._runtime?.snowball;
            if (!sb) return { error: 'Snowball engine unavailable' };
            const res = await sb.record(p?.type || 'command_executed', p?.source || 'cli', p?.payload || {}, p?.ctx);
            return res.isOk ? res.value : { error: res.error.message };
          }
        });
      }

      if (this._profileConfig.enableAgentKernel) {
        ctx.commands.register({
          id: 'agent.llm.chat',
          title: { ar: 'محادثة الوكيل', en: 'Agent LLM Chat' },
          category: { ar: 'الوكيل', en: 'Agent' },
          description: { ar: 'إرسال استعلام للوكيل الذكي', en: 'Send query to local agent' },
          handler: async (p: any) => {
            const agent = this.agentKernel;
            if (!agent?.executeSyscall) return { output: 'Agent unavailable' };
            const msg = typeof p === 'string' ? p : (p?.msg ?? p?.message ?? '');
            const res = await agent.executeSyscall('agent.llm.chat', {
              messages: [{ role: 'user', content: String(msg ?? '') }]
            });
            if (res.isErr) return { output: `Agent error: ${res.error.message}` };
            return { output: res.value?.content ?? '' };
          }
        });
      }

      if (this._profileConfig.enableHermes) {
        ctx.commands.register({
          id: 'hermes.learn',
          title: { ar: 'تعلم هيرمس', en: 'Hermes Learn' },
          category: { ar: 'هيرمس', en: 'Hermes' },
          description: { ar: 'إضافة مادة تعليمية جديدة', en: 'Add training material' },
          handler: async (p: any) => {
            const hermes = this.hermes;
            if (!hermes?.learn) return { output: 'Hermes unavailable' };
            const topic = typeof p === 'string' ? p : (p?.topic ?? '');
            const output = await hermes.learn(topic);
            return { output };
          }
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
