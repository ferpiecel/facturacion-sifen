import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import TenantPage from './page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

describe('tenant picker page', () => {
  it('has one h1', () => {
    render(<TenantPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Elegí una empresa' })).toBeInTheDocument();
  });
});
