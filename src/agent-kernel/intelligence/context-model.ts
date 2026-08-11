export interface ContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  timestamp: number;
}

export interface ContextWindowOptions {
  maxMessages?: number;
  maxEstimatedTokens?: number;
}

/**
 * Context Model for managing session conversation state and token/message window pruning.
 */
export class ContextModel {
  private messages: ContextMessage[] = [];
  private maxMessages: number;
  private maxEstimatedTokens: number;

  constructor(options: ContextWindowOptions = {}) {
    this.maxMessages = options.maxMessages || 100;
    this.maxEstimatedTokens = options.maxEstimatedTokens || 4000;
  }

  public append(role: ContextMessage['role'], content: string, name?: string): ContextMessage {
    const msg: ContextMessage = {
      role,
      content,
      name,
      timestamp: Date.now()
    };
    this.messages.push(msg);
    this.prune();
    return msg;
  }

  public getMessages(): ContextMessage[] {
    return [...this.messages];
  }

  public estimateTokens(): number {
    return this.messages.reduce((total, m) => total + Math.ceil(m.content.length / 4), 0);
  }

  private prune(): void {
    while (this.messages.length > this.maxMessages) {
      // Keep system messages at head if any
      const firstUserIndex = this.messages.findIndex(m => m.role !== 'system');
      if (firstUserIndex > -1) {
        this.messages.splice(firstUserIndex, 1);
      } else {
        this.messages.shift();
      }
    }

    while (this.estimateTokens() > this.maxEstimatedTokens && this.messages.length > 1) {
      const firstUserIndex = this.messages.findIndex(m => m.role !== 'system');
      if (firstUserIndex > -1) {
        this.messages.splice(firstUserIndex, 1);
      } else {
        this.messages.shift();
      }
    }
  }

  public clear(): void {
    this.messages = [];
  }
}
