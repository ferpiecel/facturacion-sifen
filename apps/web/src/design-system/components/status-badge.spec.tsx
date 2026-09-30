import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusBadge } from './status-badge';

const CASES = [
  ['borrador', 'Borrador', 'neutral'],
  ['firmado', 'Firmado', 'info'],
  ['en_lote', 'En lote', 'info'],
  ['aprobado', 'Aprobado SIFEN', 'success'],
  ['aprobado_con_observacion', 'Aprobado con observación', 'warning'],
  ['rechazado', 'Rechazado', 'danger'],
  ['cancelado', 'Cancelado', 'neutral'],
  ['inutilizado', 'Inutilizado', 'neutral'],
] as const;

describe('StatusBadge', () => {
  it.each(CASES)('renders %s as "%s" with the %s tone', (status, label, tone) => {
    render(<StatusBadge status={status} />);

    const badge = screen.getByText(label).closest('[data-tone]');
    expect(badge).toHaveAttribute('data-tone', tone);
    // The text label carries the meaning; the colored dot is decorative.
    expect(badge?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('falls back to a neutral "Desconocido" badge for unknown states', () => {
    render(<StatusBadge status="procesando" />);

    expect(screen.getByText('Desconocido').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'neutral',
    );
  });

  it('does not treat inherited object keys as known states', () => {
    render(<StatusBadge status="toString" />);

    expect(screen.getByText('Desconocido')).toBeInTheDocument();
  });
});
