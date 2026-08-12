import { Result, ok, err } from '../kernel/core/result';

export interface AccessPolicy {
  /** إغلاق شامل لأوامر agent.* غير المسموح بها صراحة */
  allowAllCommands?: boolean;
  /** إغلاق شامل للأدوات غير المسموح بها صراحة */
  allowAllTools?: boolean;
  /** قائمة مسموحة عندما يكون allowAllCommands=false */
  allowedCommands?: string[];
  /** قائمة ممنوعة دائمًا (تُفحص أولًا) */
  deniedCommands?: string[];
  /** قائمة مسموحة عندما يكون allowAllTools=false */
  allowedTools?: string[];
  /** قائمة أدوات ممنوعة دائمًا */
  deniedTools?: string[];
  /** منع جسر نظام الملفات (agent.storage.*) */
  allowSystem?: boolean;
  /** سقف ملاحظات الذاكرة لهذا الوكيل */
  maxMemoryNotes?: number;
}

export interface PolicySummary {
  agentId: string;
  policy: AccessPolicy;
}

export class AccessManager {
  private readonly policies = new Map<string, AccessPolicy>();

  defaultPolicy(): AccessPolicy {
    return {
      allowAllCommands: true,
      allowAllTools: true,
      allowSystem: true,
    };
  }

  setPolicy(agentId: string, policy: AccessPolicy): void {
    this.policies.set(agentId, policy);
  }

  getPolicy(agentId: string): AccessPolicy {
    return this.policies.get(agentId) ?? this.defaultPolicy();
  }

  list(): PolicySummary[] {
    return Array.from(this.policies.entries()).map(([agentId, policy]) => ({ agentId, policy }));
  }

  /** بوابة الأوامر: تفحص قبل أي نداء agent.* */
  checkCommand(agentId: string, commandId: string): Result<void, Error> {
    const p = this.getPolicy(agentId);
    if (p.deniedCommands?.includes(commandId)) {
      return err(new Error(`EPERM: agent '${agentId}' denied command '${commandId}'`));
    }
    if (p.allowAllCommands !== false) return ok(undefined);
    if (p.allowedCommands?.includes(commandId)) return ok(undefined);
    return err(new Error(`EPERM: agent '${agentId}' has no permission for command '${commandId}'`));
  }

  /** بوابة الأدوات: تفحص قبل agent.tool.call */
  checkTool(agentId: string, toolName: string): Result<void, Error> {
    const p = this.getPolicy(agentId);
    if (p.deniedTools?.includes(toolName)) {
      return err(new Error(`EPERM: agent '${agentId}' denied tool '${toolName}'`));
    }
    if (p.allowAllTools !== false) return ok(undefined);
    if (p.allowedTools?.includes(toolName)) return ok(undefined);
    return err(new Error(`EPERM: agent '${agentId}' has no permission for tool '${toolName}'`));
  }

  /** بوابة نظام الملفات (agent.storage.* / جسر VFS) */
  checkSystem(agentId: string): Result<void, Error> {
    const p = this.getPolicy(agentId);
    if (p.allowSystem === false) {
      return err(new Error(`EPERM: agent '${agentId}' has no system (VFS) access`));
    }
    return ok(undefined);
  }

  /** سقف الذاكرة لكل وكيل */
  maxMemoryNotes(agentId: string): number {
    return this.getPolicy(agentId).maxMemoryNotes ?? Number.POSITIVE_INFINITY;
  }
}
