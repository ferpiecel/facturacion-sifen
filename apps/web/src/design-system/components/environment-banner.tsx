export type Environment = 'test' | 'production';

interface EnvironmentBannerProps {
  environment: Environment;
}

/**
 * Strip warning that documents issued in the SIFEN test environment have no
 * commercial or tax value. The environment belongs to the tenant, so this is
 * informative only: it cannot be dismissed or toggled.
 */
export function EnvironmentBanner({ environment }: EnvironmentBannerProps) {
  if (environment !== 'test') {
    return null;
  }

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-space-xs border-b border-test-environment-accent bg-test-environment px-space-lg py-space-xs font-body-sm text-body-sm font-semibold text-on-test-environment"
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-test-environment-accent"
      />
      Ambiente de prueba: los documentos no tienen valor comercial ni fiscal.
    </div>
  );
}
