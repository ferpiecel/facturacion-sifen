import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ArtifactViewer } from './artifact-viewer';

const URL_OF = '/api/portal/received-documents/d1/artifact';
const artifact = (content_type: string, original_name: string | null = null) => ({
  id: 'a1',
  content_type,
  size_bytes: 2048,
  sha256: 'abc',
  original_name,
  page_count: null,
});

describe('ArtifactViewer', () => {
  it('offers a PDF as an open link and a download, never as an embed', () => {
    const { container } = render(
      <ArtifactViewer artifact={artifact('application/pdf')} href={URL_OF} />,
    );

    expect(screen.getByRole('link', { name: 'Abrir artefacto' })).toHaveAttribute('href', URL_OF);
    expect(screen.getByRole('link', { name: 'Abrir artefacto' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(screen.getByRole('link', { name: 'Descargar' })).toHaveAttribute('download');
    expect(container.querySelector('iframe, object, embed')).toBeNull();
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'])('shows %s as an image', (type) => {
    render(<ArtifactViewer artifact={artifact(type, 'foto.png')} href={URL_OF} />);

    expect(screen.getByRole('img', { name: 'foto.png' })).toHaveAttribute('src', URL_OF);
  });

  it.each(['application/xml', 'text/xml', 'text/html', 'image/svg+xml'])(
    'offers %s only as a download link',
    (type) => {
      const { container } = render(<ArtifactViewer artifact={artifact(type)} href={URL_OF} />);

      expect(screen.getByRole('link', { name: 'Descargar' })).toHaveAttribute('href', URL_OF);
      expect(container.querySelector('iframe, object, embed, img')).toBeNull();
    },
  );

  it.each(['application/pdf; charset=binary', ' Application/PDF ;x=y'])(
    'treats %j as a PDF despite parameters and case',
    (type) => {
      render(<ArtifactViewer artifact={artifact(type)} href={URL_OF} />);

      expect(screen.getByRole('link', { name: 'Abrir artefacto' })).toHaveAttribute('href', URL_OF);
    },
  );

  it.each(['image/png; x=y', 'IMAGE/JPEG;q=1'])('treats %j as an image', (type) => {
    render(<ArtifactViewer artifact={artifact(type, 'foto')} href={URL_OF} />);

    expect(screen.getByRole('img', { name: 'foto' })).toHaveAttribute('src', URL_OF);
  });

  it.each(['image/svg+xml; charset=utf-8', 'text/html;charset=utf-8', 'application/xml; x=y'])(
    'keeps %j as a download even with parameters',
    (type) => {
      const { container } = render(<ArtifactViewer artifact={artifact(type)} href={URL_OF} />);

      expect(container.querySelector('iframe, object, embed, img')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Abrir artefacto' })).toBeNull();
      expect(screen.getByRole('link', { name: 'Descargar' })).toHaveAttribute('href', URL_OF);
    },
  );

  it('says so when the document has no artifact', () => {
    render(<ArtifactViewer artifact={null} href={URL_OF} />);

    expect(screen.getByText('Este documento no tiene un archivo adjunto.')).toBeVisible();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
