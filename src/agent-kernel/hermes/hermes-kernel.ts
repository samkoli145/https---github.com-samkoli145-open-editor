import { Result, ok, err } from '../../kernel/core/result';
import { TeachingBridge } from './teaching-bridge';
import { SymbolicLoop, LoopStepOutput } from './agent-loop';
import { PersonaRegistry } from './persona-system';
import { TeachingRequest, LearningReport } from './material-schema';
import { SafeStorageEngine } from '../storage';
import { SessionManager } from '../session';
import { ToolRegistry } from '../tools';

export class HermesKernel {
  public readonly bridge: TeachingBridge;
  public readonly loop: SymbolicLoop;
  public readonly personas: PersonaRegistry;
  public readonly storage: SafeStorageEngine;
  public readonly sessions: SessionManager;
  public readonly toolRegistry: ToolRegistry;

  constructor(toolRegistry?: ToolRegistry, storage?: SafeStorageEngine) {
    this.toolRegistry = toolRegistry || new ToolRegistry();
    this.bridge = new TeachingBridge();
    this.loop = new SymbolicLoop(this.toolRegistry, this.bridge);
    this.personas = new PersonaRegistry();
    this.storage = storage || new SafeStorageEngine();
    this.sessions = new SessionManager();
  }

  public async learn(request: TeachingRequest): Promise<Result<LearningReport, Error>> {
    return this.bridge.learn(request);
  }

  public async save(sessionId: string): Promise<Result<void, Error>> {
    const exportedState = this.bridge.exportState();
    return this.storage.save(`hermes_session_${sessionId}`, exportedState);
  }

  public async load(sessionId: string): Promise<Result<number, Error>> {
    const loadRes = await this.storage.load<Record<string, any>>(`hermes_session_${sessionId}`);
    if (loadRes.isErr) {
      return err(loadRes.error);
    }
    return this.bridge.importState(loadRes.value);
  }

  public exportState(): Record<string, any> {
    return this.bridge.exportState();
  }

  public importState(data: Record<string, any>): Result<number, Error> {
    return this.bridge.importState(data);
  }

  public async serve(input: string, toolName?: string, toolArgs: any = {}): Promise<Result<LoopStepOutput, Error>> {
    return this.loop.step(input, toolName, toolArgs);
  }
}
