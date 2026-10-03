import type { TenantEnvironments } from './tenant-directory.js';

export interface SimulatorGuardDeps<D extends { tenantId: string }, R> {
  /** True when the gateway is the in-process simulator, not SIFEN. */
  readonly simulator: boolean;
  readonly environments: TenantEnvironments;
  readonly logger: { warn(message: string): void };
  readonly process: (data: D) => Promise<R>;
}

/**
 * Wraps the job handler so that, with the simulator gateway, a tenant that is in `production` is
 * skipped: its documents would be "approved" by a fake and never reach SIFEN. Warns once per tenant.
 */
export function guardSimulatorTenants<D extends { tenantId: string }, R>({
  simulator,
  environments,
  logger,
  process,
}: SimulatorGuardDeps<D, R>): (data: D) => Promise<R | { status: 'skipped' }> {
  const warned = new Set<string>();
  return async (data) => {
    if (simulator && (await environments.environmentOf(data.tenantId)) === 'production') {
      if (!warned.has(data.tenantId)) {
        warned.add(data.tenantId);
        logger.warn(
          `tenant ${data.tenantId} is in production but the gateway is the simulator: cycle skipped`,
        );
      }
      return { status: 'skipped' };
    }
    return process(data);
  };
}
