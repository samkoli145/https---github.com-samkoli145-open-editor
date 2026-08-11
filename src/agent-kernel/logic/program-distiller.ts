export interface MacroStep {
  toolName: string;
  argsTemplate: Record<string, any>;
}

export interface DistilledProgram {
  id: string;
  name: string;
  steps: MacroStep[];
  usageCount: number;
}

/**
 * Program Distiller.
 * Compiles repetitive multi-step tool call patterns into single macro execution recipes.
 */
export class ProgramDistiller {
  private programs = new Map<string, DistilledProgram>();

  public registerMacro(name: string, steps: MacroStep[]): DistilledProgram {
    const id = `macro_${name}_${Date.now()}`;
    const program: DistilledProgram = {
      id,
      name,
      steps,
      usageCount: 0
    };
    this.programs.set(id, program);
    return program;
  }

  public getMacro(id: string): DistilledProgram | undefined {
    const prog = this.programs.get(id);
    if (prog) {
      prog.usageCount++;
    }
    return prog;
  }

  public listMacros(): DistilledProgram[] {
    return Array.from(this.programs.values());
  }

  public clear(): void {
    this.programs.clear();
  }
}
