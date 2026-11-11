import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PortalLayout from './layout';

// Stable router, as Next's is: useRemote depends on it, a fresh object per render re-runs its request.
const { router } = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

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
