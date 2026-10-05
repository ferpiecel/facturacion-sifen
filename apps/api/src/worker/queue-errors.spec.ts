import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { logQueueErrors } from './queue.js';

/** Spec: HU-E6-02 (S5d). A Redis outage must be logged, not crash the worker as an unhandled 'error' event. */
describe('logQueueErrors', () => {
  it('routes error events to the logger with the class and code only', () => {
    const emitter = new EventEmitter();
    const logs: string[] = [];
    logQueueErrors(emitter, 'worker', { error: (message) => logs.push(message) });

    emitter.emit(
      'error',
      Object.assign(new Error('connect to redis://:s3cret@10.0.0.5:6379 failed'), {
        name: 'RedisConnectionError',
        code: 'ECONNREFUSED',
      }),
    );
    emitter.emit('error', 'not an error object');

    expect(logs).toEqual([
      'worker error: RedisConnectionError (ECONNREFUSED)',
      'worker error: unknown error',
    ]);
    expect(logs.join('\n')).not.toContain('s3cret');
  });
});
