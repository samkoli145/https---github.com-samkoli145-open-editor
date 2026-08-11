export type Id = string;

export type Priority = 'low' | 'normal' | 'high' | 'critical';

export const PRIORITY_WEIGHTS: Record<Priority, number> = {
  low: 0,
  normal: 10,
  high: 20,
  critical: 30,
};

export interface SystemEvent<T = unknown> {
  id: Id;
  name: string;
  payload: T;
  timestamp: number;
}

export type EventName = string;
export type EventHandler<T = unknown> = (event: SystemEvent<T>) => void;
