import { cn } from '../lib/cn';
import { formatPYG } from '../lib/format-pyg';

interface MoneyPYGProps {
  amount: number;
  className?: string;
}

/** Guaraní amount; negative amounts use the error color as in the Stitch table. */
export function MoneyPYG({ amount, className }: MoneyPYGProps) {
  if (!Number.isFinite(amount)) {
    return (
      <span className={cn('whitespace-nowrap', className)} aria-label="Monto no disponible">
        —
      </span>
    );
  }

  const negative = Math.round(amount) < 0;
  return (
    <span
      className={cn('whitespace-nowrap tabular-nums', className, negative && 'text-error')}
      data-negative={negative ? 'true' : undefined}
    >
      {formatPYG(amount)}
    </span>
  );
}
