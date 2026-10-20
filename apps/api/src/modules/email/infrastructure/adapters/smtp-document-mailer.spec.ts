import { createTransport } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { MailerError, type DocumentEmail } from '../../application/ports/document-mailer.port.js';
import { createSmtpDocumentMailer, type MailTransport } from './smtp-document-mailer.js';

const CONFIG = {
  enabled: true as const,
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  allowPlaintext: false,
  fromAddress: 'facturas@example.com',
};

const EMAIL: DocumentEmail = {
  messageId: 'doc-1@sifen.example',
  to: 'cliente@example.com',
  fromName: 'Panadería "La Espiga"',
  replyTo: 'ventas@laespiga.example',
  subject: 'Factura electrónica 001-001-0000007',
  text: 'Adjuntamos su factura.',
  attachments: [
    {
      filename: 'kude-001-001-0000007.pdf',
      contentType: 'application/pdf',
      content: new Uint8Array([1, 2, 3]),
    },
    { filename: 'de-001-001-0000007.xml', contentType: 'application/xml', content: '<rDE/>' },
  ],
};

async function sentThrough(email: DocumentEmail) {
  const transport = createTransport({ jsonTransport: true });
  const spy = vi.spyOn(transport, 'sendMail');
  await createSmtpDocumentMailer(CONFIG, { transport }).send(email);
  const info = (await spy.mock.results[0]?.value) as { message: string };
  return JSON.parse(info.message) as Record<string, unknown>;
}

describe('createSmtpDocumentMailer', () => {
  it('sends from the platform address under the tenant display name', async () => {
    const message = await sentThrough(EMAIL);
    expect(message.from).toEqual({
      name: 'Panadería "La Espiga"',
      address: 'facturas@example.com',
    });
    expect(message.to).toEqual([{ name: '', address: 'cliente@example.com' }]);
    expect(message.replyTo).toEqual([{ name: '', address: 'ventas@laespiga.example' }]);
    expect(message.subject).toBe('Factura electrónica 001-001-0000007');
    expect(message.messageId).toBe('<doc-1@sifen.example>');
  });

  it('attaches the PDF and the XML with their content types', async () => {
    const message = await sentThrough(EMAIL);
    expect(message.attachments).toEqual([
      expect.objectContaining({
        filename: 'kude-001-001-0000007.pdf',
        contentType: 'application/pdf',
      }),
      expect.objectContaining({
        filename: 'de-001-001-0000007.xml',
        contentType: 'application/xml',
      }),
    ]);
  });

  it('strips line breaks from the display name so it cannot inject headers', async () => {
    const message = await sentThrough({ ...EMAIL, fromName: 'Evil\r\nBcc: x@y.com' });
    expect((message.from as { name: string }).name).not.toMatch(/[\r\n]/);
    expect(message).not.toHaveProperty('bcc');
  });

  it.each([
    [{ responseCode: 550, code: 'EENVELOPE' }, false],
    [{ responseCode: 452, code: 'EENVELOPE' }, true],
    [{ code: 'ECONNECTION' }, true],
    [{ code: 'ETIMEDOUT' }, true],
    [{}, true],
  ])('classifies %j as transient=%s and never leaks addresses', async (failure, transient) => {
    const transport: MailTransport = {
      sendMail: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('550 cliente@example.com mailbox unavailable'), failure),
        ),
    };
    const error = await createSmtpDocumentMailer(CONFIG, { transport })
      .send(EMAIL)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(MailerError);
    expect((error as MailerError).transient).toBe(transient);
    expect((error as MailerError).message).not.toContain('cliente@example.com');
  });
});
