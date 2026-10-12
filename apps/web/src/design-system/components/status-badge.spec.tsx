import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusBadge } from './status-badge';

const CASES = [
  ['accepted', 'Recibido', 'neutral'],
  ['signed', 'Firmado', 'info'],
  ['queued', 'En cola', 'info'],
  ['submitted', 'Enviado a SIFEN', 'info'],
  ['approved', 'Aprobado SIFEN', 'success'],
  ['approved_with_observations', 'Aprobado con observación', 'warning'],
  ['rejected', 'Rechazado', 'danger'],
  ['corrected', 'Corregido', 'neutral'],
  ['number_voided', 'Número inutilizado', 'neutral'],
  ['cancelled', 'Cancelado', 'neutral'],
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
