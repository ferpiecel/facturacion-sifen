import {
  DEFAULT_RECEIVER_EVENT_CONFIG,
  type ReceiverEventConfig,
} from '../domain/receiver-event-rules.js';

function days(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 365) {
    throw new Error(`${name} must be a whole number of days from 1 to 365`);
  }
  return value;
}

/**
 * Deadlines of the receiver events (NT 019, MT Tabla K). Values the sources may still change are
 * configuration, validated at startup: `RECEIVER_EVENT_WINDOW_DAYS` (45) and `RECEIVER_EVENT_CORRECTION_DAYS` (15).
 */
export function readReceiverEventConfig(env: NodeJS.ProcessEnv = process.env): ReceiverEventConfig {
  return {
    ...DEFAULT_RECEIVER_EVENT_CONFIG,
    windowDays: days(env, 'RECEIVER_EVENT_WINDOW_DAYS', DEFAULT_RECEIVER_EVENT_CONFIG.windowDays),
    correctionDays: days(
      env,
      'RECEIVER_EVENT_CORRECTION_DAYS',
      DEFAULT_RECEIVER_EVENT_CONFIG.correctionDays,
    ),
  };
}
