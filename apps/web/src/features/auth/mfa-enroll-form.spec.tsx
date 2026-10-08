import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient, ConfirmEnrollmentResult, EnrollResult } from './auth-client';
import { MfaEnrollForm } from './mfa-enroll-form';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: replace, replace }) }));

const toDataURL = vi.fn<(text: string) => Promise<string>>(() =>
  Promise.resolve('data:image/png;base64,AAAA'),
);
vi.mock('qrcode', () => ({ default: { toDataURL: (text: string) => toDataURL(text) } }));

const URI = 'otpauth://totp/Acme:ana%40acme.py?secret=JBSWY3DPEHPK3PXP&issuer=Acme';
const ENROLL: EnrollResult = { kind: 'ok', otpauthUri: URI, secret: 'JBSWY3DPEHPK3PXP' };
const T1 = { tenantId: 't1', tenantName: 'Acme', role: 'owner' };
const T2 = { tenantId: 't2', tenantName: 'Beta', role: 'lector' };
const CODES = ['AAAA-BBBB-CCCC-DDDD', 'EEEE-FFFF-GGGG-HHHH'];

function setup(enroll: EnrollResult, confirm?: ConfirmEnrollmentResult) {
  const client = {
    enrollMfa: vi.fn(() => Promise.resolve(enroll)),
    confirmMfaEnrollment: vi.fn(() => Promise.resolve(confirm ?? { kind: 'invalid' as const })),
  } as unknown as AuthClient;
  render(<MfaEnrollForm client={client} />);
  return client;
}

async function confirmWith(code: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Código de 6 dígitos'), code);
  await user.click(screen.getByRole('button', { name: 'Activar' }));
  return user;
}

describe('MfaEnrollForm', () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it('shows the QR generated in the browser and the secret as a manual fallback', async () => {
    setup(ENROLL);
    const qr = await screen.findByRole('img', { name: /código QR/i });
    expect(qr).toHaveAttribute('src', 'data:image/png;base64,AAAA');
    expect(toDataURL).toHaveBeenCalledWith(URI);
    expect(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument();
  });

  it('tells the user to log in again when there is no pending session', async () => {
    setup({ kind: 'invalid' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Volvé a ingresar');
  });

  it('shows a wrong code as an error and stays on the enrolment screen', async () => {
    setup(ENROLL, { kind: 'invalid' });
    await confirmWith('123456');
    expect(await screen.findByRole('alert')).toHaveTextContent('Código incorrecto');
  });

  it('shows the recovery codes once and only continues after the acknowledgement', async () => {
    const client = setup(ENROLL, {
      kind: 'ok',
      recoveryCodes: CODES,
      activeTenant: { tenantId: 't1', role: 'owner' },
      tenants: [T1],
    });
    const user = await confirmWith('123 456');
    expect(client.confirmMfaEnrollment).toHaveBeenCalledWith('123456');
    expect(await screen.findByText(CODES[0] ?? '')).toBeInTheDocument();
    expect(screen.getByText(CODES[1] ?? '')).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Continuar' });
    expect(next).toBeDisabled();
    await user.click(screen.getByLabelText(/Guardé mis códigos de recuperación/));
    expect(next).toBeEnabled();
    await user.click(next);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/');
    });
  });

  it.each([
    [[T1, T2], '/seleccionar-empresa'],
    [[], null],
  ])('with tenants %j it routes to %s', async (tenants, route) => {
    setup(ENROLL, { kind: 'ok', recoveryCodes: CODES, activeTenant: null, tenants });
    const user = await confirmWith('123456');
    await user.click(await screen.findByLabelText(/Guardé mis códigos/));
    await user.click(screen.getByRole('button', { name: 'Continuar' }));
    if (route) {
      await waitFor(() => {
        expect(replace).toHaveBeenCalledWith(route);
      });
    } else expect(await screen.findByRole('alert')).toHaveTextContent('no tiene empresas');
  });
});
