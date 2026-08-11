export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  tools?: any[];
}

export interface OpenAIChatChoice {
  index: number;
  message: OpenAIChatMessage;
  finish_reason: string;
}

export interface OpenAIChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class HermesAdapter {
  public static formatOpenAIResponse(
    model: string,
    content: string,
    finishReason: string = 'stop'
  ): OpenAIChatResponse {
    return {
      id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content
          },
          finish_reason: finishReason
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: content.length,
        total_tokens: 10 + content.length
      }
    };
  }
}
