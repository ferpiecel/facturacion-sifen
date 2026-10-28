import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Loaded CI runners starve the event loop; the 1000 ms default flakes async queries.
configure({ asyncUtilTimeout: 5000 });

// Pages render the shell's logout button, which needs the App Router (absent in unit tests).
const router = { push: vi.fn(), replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

afterEach(() => {
  cleanup();
});
