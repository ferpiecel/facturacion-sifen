import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PortalLayout from './layout';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

describe('portal layout', () => {
  it('holds the content back until the session gate has answered', () => {
    render(
      <PortalLayout>
        <p>Panel</p>
      </PortalLayout>,
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Panel')).not.toBeInTheDocument();
  });
});
