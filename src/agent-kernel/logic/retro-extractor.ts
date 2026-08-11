import { LoopStepOutput } from '../hermes/agent-loop';
import { TeachingMaterial } from '../hermes/material-schema';
import { TeachingBridge } from '../hermes/teaching-bridge';

export interface RetroHarvestReport {
  extractedMaterials: TeachingMaterial[];
  reasons: string[];
}

/**
 * Retro Extractor.
 * Analyzes execution traces, failures, and blocked steps to harvest new deterministic rules and constraints.
 */
export class RetroExtractor {
  private bridge?: TeachingBridge;

  constructor(bridge?: TeachingBridge) {
    this.bridge = bridge;
  }

  public async harvestAndLearn(stepOutput: LoopStepOutput, sessionId = 'retro_session'): Promise<RetroHarvestReport> {
    const report = this.harvestFromStep(stepOutput);
    if (this.bridge && report.extractedMaterials.length > 0) {
      await this.bridge.learn({
        sessionId,
        materials: report.extractedMaterials
      });
    }
    return report;
  }

  public extractPatternFromReason(reason: string): string {
    if (!reason) return '';
    
    // Extract quoted terms if present (e.g. Constraint violated: 'drop table' is forbidden)
    const quoteMatch = reason.match(/['"`]([^'"`]+)['"`]/);
    if (quoteMatch && quoteMatch[1] && quoteMatch[1].trim().length > 0) {
      return quoteMatch[1].trim();
    }

    // Strip generic prefix phrases
    let cleaned = reason.replace(/^(Constraint violated|Error|Blocked|Violation|Failed):\s*/i, '').trim();

    // If cleaned is a descriptive sentence (contains spaces), check for explicit dangerous keywords
    if (cleaned.includes(' ')) {
      const keyPhrases = ['drop table', 'rm -rf', 'eval', 'process.exit', 'exec', 'unauthorized', 'ssrf'];
      for (const phrase of keyPhrases) {
        const idx = cleaned.toLowerCase().indexOf(phrase);
        if (idx !== -1) {
          return cleaned.substring(idx, idx + phrase.length);
        }
      }
    }

    return cleaned;
  }

  public harvestFromStep(stepOutput: LoopStepOutput): RetroHarvestReport {
    const extractedMaterials: TeachingMaterial[] = [];
    const reasons: string[] = [];

    if (stepOutput.status === 'blocked' && stepOutput.reason) {
      const materialId = `retro_c_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const pattern = this.extractPatternFromReason(stepOutput.reason);
      extractedMaterials.push({
        id: materialId,
        type: 'constraint',
        content: pattern,
        priority: 'high',
        metadata: {
          source: 'retro_harvest',
          latencyMs: stepOutput.latencyMs
        }
      });
      reasons.push(`Harvested blocked constraint pattern '${pattern}' from step trace`);
    }

    if (stepOutput.latencyMs > 100) {
      const materialId = `retro_warn_latency_${Date.now()}`;
      extractedMaterials.push({
        id: materialId,
        type: 'metric',
        content: `latency_audit:${stepOutput.latencyMs}ms`,
        priority: 'normal',
        metadata: {
          source: 'latency_audit',
          recordedLatency: stepOutput.latencyMs
        }
      });
      reasons.push(`Flagged high latency (${stepOutput.latencyMs}ms) for performance optimization`);
    }

    return {
      extractedMaterials,
      reasons
    };
  }
}
