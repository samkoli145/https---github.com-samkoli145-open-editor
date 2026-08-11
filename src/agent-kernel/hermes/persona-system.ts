import { Result, ok, err } from '../../kernel/core/result';

export interface PersonaDefinition {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  defaultRules: string[];
  allowedTools: string[];
}

export class PersonaRegistry {
  private personas = new Map<string, PersonaDefinition>();

  constructor() {
    this.registerBuiltInPersonas();
  }

  public registerPersona(persona: PersonaDefinition): Result<void, Error> {
    if (!persona.id || typeof persona.id !== 'string') {
      return err(new Error('EINVAL: Persona ID must be a non-empty string'));
    }
    this.personas.set(persona.id, persona);
    return ok(undefined);
  }

  public getPersona(id: string): PersonaDefinition | undefined {
    return this.personas.get(id);
  }

  public listPersonas(): PersonaDefinition[] {
    return Array.from(this.personas.values());
  }

  private registerBuiltInPersonas(): void {
    this.registerPersona({
      id: 'code-assistant',
      name: 'Code Assistant',
      role: 'developer',
      systemPrompt: 'You are an expert software engineer providing precise, deterministic code.',
      defaultRules: ['Prefer strict types', 'No unhandled promises'],
      allowedTools: ['calc', 'echo', 'now']
    });

    this.registerPersona({
      id: 'teacher',
      name: 'Teacher / Instructor',
      role: 'educator',
      systemPrompt: 'You are an instructor generating idempotent teaching materials and rules.',
      defaultRules: ['Verify knowledge prerequisites', 'Provide clear examples'],
      allowedTools: ['echo', 'now']
    });

    this.registerPersona({
      id: 'analyst',
      name: 'Data Analyst',
      role: 'analyst',
      systemPrompt: 'You are a data analyst evaluating system metrics and logs.',
      defaultRules: ['Rely on facts', 'Audit latencies'],
      allowedTools: ['calc', 'now']
    });
  }
}
