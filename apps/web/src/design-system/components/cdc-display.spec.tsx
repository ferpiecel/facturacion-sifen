import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CdcDisplay } from './cdc-display';

const CDC = '01800123450001001000481222026092911789423585';

function mockClipboard(implementation: (text: string) => Promise<void>) {
  const user = userEvent.setup();
  const writeText = vi.fn(implementation);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return { user, writeText };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CdcDisplay', () => {
  it('shows the 44 digits grouped by CDC field without altering the value', () => {
    render(<CdcDisplay value={CDC} />);

    const value = screen.getByTestId('cdc-value');
    expect(value.children).toHaveLength(11);
    expect(value.children[0]).toHaveTextContent('01');
    expect(value.children[1]).toHaveTextContent('80012345');
    expect(value).toHaveTextContent(CDC);
    expect(value).toHaveClass('font-code-sm');
  });

  it('copies the raw CDC to the clipboard and confirms it', async () => {
    const { user, writeText } = mockClipboard(() => Promise.resolve());
    render(<CdcDisplay value={CDC} />);

    await user.click(screen.getByRole('button', { name: 'Copiar CDC' }));

    expect(writeText).toHaveBeenCalledWith(CDC);
    expect(await screen.findByText('CDC copiado')).toBeInTheDocument();
  });

  it('reports when copying fails', async () => {
    const { user } = mockClipboard(() => Promise.reject(new Error('denied')));
    render(<CdcDisplay value={CDC} />);

    await user.click(screen.getByRole('button', { name: 'Copiar CDC' }));

    expect(await screen.findByText('No se pudo copiar el CDC')).toBeInTheDocument();
  });

  it('shows type, RUC and last digits in the truncated variant, keeping the full value accessible', () => {
    render(<CdcDisplay value={CDC} variant="truncated" />);

    const value = screen.getByTestId('cdc-value');
    expect(value).toHaveAttribute('title', CDC);
    expect(screen.getByText('01-80012345-0...585')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(`CDC ${CDC}`)).toHaveClass('sr-only');
  });

  it.each([
    ['too short', CDC.slice(0, 43)],
    ['too long', `${CDC}1`],
    ['non-digit', `${CDC.slice(0, 43)}A`],
  ])('flags a %s value as invalid and offers no copy action', (_case, value) => {
    render(<CdcDisplay value={value} />);

    expect(screen.getByText('CDC inválido: debe tener 44 dígitos')).toBeInTheDocument();
    expect(screen.getByText(value)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
