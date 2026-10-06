import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import LoginPage from './page';
import MfaPage from './mfa/page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

describe('login pages', () => {
  it('login has one h1 and the form', () => {
    render(<LoginPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Ingresar al portal' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ingresar' })).toBeInTheDocument();
  });

  it('mfa has one h1 and the form', () => {
    render(<MfaPage />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Verificación en dos pasos' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Código de 6 dígitos')).toBeInTheDocument();
  });
});
