import { TeachingMaterial } from '../hermes/material-schema';
import { DomainName, DomainPolicy } from './domains/domain-types';
import { ConstraintRule } from '../intelligence/constraint-engine';
import { InferenceRule } from '../intelligence/inference-engine';

/**
 * Domain Compiler.
 * Compiles raw Hermes TeachingMaterial items into optimized, executable DomainPolicy instances.
 */
export class DomainCompiler {
  public compile(domain: DomainName, materials: TeachingMaterial[], existingVersion = 1): DomainPolicy {
    const constraints: ConstraintRule[] = [];
    const inferenceRules: InferenceRule[] = [];
    const toolAllowlist = new Set<string>();

    for (const mat of materials) {
      if (!mat || !mat.content) continue;

      // Map targeted domain if specified
      if (mat.targetPersona && mat.targetPersona !== domain && mat.targetPersona !== '*') {
        continue;
      }

      if (mat.type === 'constraint' || mat.type === 'rule') {
        constraints.push({
          id: mat.id,
          expression: mat.content,
          severity: mat.priority === 'high' ? 'block' : 'warn',
          reason: `Compiled rule ${mat.id}: ${mat.content}`
        });
      } else if (mat.type === 'fact' || mat.type === 'skill') {
        inferenceRules.push({
          id: mat.id,
          ifPattern: mat.content,
          thenDeduction: mat.content,
          actionTool: mat.metadata?.actionTool
        });

        if (mat.metadata?.actionTool) {
          toolAllowlist.add(mat.metadata.actionTool);
        }
      }
    }

    return {
      domain,
      version: existingVersion + 1,
      compiledAt: Date.now(),
      constraints,
      inferenceRules,
      toolAllowlist
    };
  }
}
