import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EnvironmentBanner } from './environment-banner';

describe('EnvironmentBanner', () => {
  it('announces the test environment with a non-dismissible status strip', () => {
    render(<EnvironmentBanner environment="test" />);

    expect(screen.getByRole('status')).toHaveTextContent(
      'Ambiente de prueba: los documentos no tienen valor comercial ni fiscal.',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders nothing in production', () => {
    const { container } = render(<EnvironmentBanner environment="production" />);

    expect(container).toBeEmptyDOMElement();
  });
});
