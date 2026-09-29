import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MoneyPYG } from './money-pyg';

describe('MoneyPYG', () => {
  it('renders Guaraníes without decimals using tabular numbers', () => {
    render(<MoneyPYG amount={1_250_000} />);

    const amount = screen.getByText('₲ 1.250.000');
    expect(amount).toHaveClass('tabular-nums');
    expect(amount).not.toHaveAttribute('data-negative');
  });

  it('marks negative amounts and shows them in the error color', () => {
    render(<MoneyPYG amount={-650_000} />);

    const amount = screen.getByText('-₲ 650.000');
    expect(amount).toHaveAttribute('data-negative', 'true');
    expect(amount).toHaveClass('text-error');
  });

  it('keeps the caller type scale while overriding its color for negatives', () => {
    render(<MoneyPYG amount={-1} className="text-headline-md text-on-surface" />);

    const amount = screen.getByText('-₲ 1');
    expect(amount).toHaveClass('text-headline-md', 'text-error');
    expect(amount).not.toHaveClass('text-on-surface');
  });

  it('shows a placeholder with an accessible label when the amount is not a number', () => {
    render(<MoneyPYG amount={Number.NaN} />);

    expect(screen.getByLabelText('Monto no disponible')).toHaveTextContent('—');
  });
});
