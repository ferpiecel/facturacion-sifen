import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import {
  authEvents,
  createPgliteDatabase,
  tenantMemberships,
  tenants,
  userMfa,
  userSessions,
  users,
  type DatabaseHandle,
} from '@sifen/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClsModule } from 'nestjs-cls';
import { EnvelopeCipher } from '../../../custody/application/envelope-cipher.js';
import { MfaSecretVault } from '../../../custody/application/mfa-secret-vault.js';
import { CustodyModule } from '../../../custody/custody.module.js';
import { DATABASE, DatabaseModule } from '../../../database/database.module.js';
import { CreateUserUseCase } from '../../application/create-user.use-case.js';
import { generateTotpSecret, totpAt } from '../../domain/totp.js';
import { Argon2SecretHasherAdapter } from '../adapters/argon2-secret-hasher.adapter.js';
import { IdentityModule } from '../../identity.module.js';
import { PortalAuthModule } from '../../portal-auth.module.js';
import { WebhooksModule } from '../../../webhooks/webhooks.module.js';
import { COOKIE_NAMES } from './auth-cookies.js';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';
const EMAIL = 'ana@example.com';

describe('portal auth over HTTP (HU-E1-07 S5 core, without enrolment)', () => {
  let handle: DatabaseHandle;
  let app: NestFastifyApplication;
  let secret: Buffer;
  let userId: string;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    handle = createPgliteDatabase();
    await handle.migrate();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true } }),
        DatabaseModule,
        CustodyModule,
        IdentityModule,
        PortalAuthModule,
        WebhooksModule,
      ],
    })
      .overrideProvider(DATABASE)
      .useValue(handle.db)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const created = await new CreateUserUseCase(new Argon2SecretHasherAdapter()).execute({
      email: EMAIL,
      displayName: 'Ana',
      password: PASSWORD,
    });
    [{ id: userId }] = (await handle.db
      .insert(users)
      .values(created)
      .returning({ id: users.id })) as [{ id: string }];
    [tenantA, tenantB] = (
      await handle.db
        .insert(tenants)
        .values([{ name: 'A' }, { name: 'B' }])
        .returning()
    ).map((t) => t.id) as [string, string];
    await handle.db.insert(tenantMemberships).values([
      { tenantId: tenantA, userId, role: 'admin' },
      { tenantId: tenantB, userId, role: 'lector' },
    ]);
    secret = generateTotpSecret();
    const sealed = await new MfaSecretVault(app.get(EnvelopeCipher)).seal(
      Buffer.from(secret),
      userId,
    );
    await handle.db.insert(userMfa).values({ userId, sealed });
    await handle.db.update(userMfa).set({ confirmedAt: new Date(), lastUsedStep: 1 });
    // The guard trigger forbids lowering the replay step; the test rewinds it to reuse the current code.
    await handle.db.execute(sql`alter table user_mfa disable trigger user_mfa_guard`);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  /** A tiny cookie jar plus request helper. */
  function client() {
    const jar = new Map<string, string>();
    const send = async (
      method: 'GET' | 'POST',
      url: string,
      options: { body?: object; origin?: string | null; cookies?: boolean } = {},
    ) => {
      const headers: Record<string, string> = {};
      const origin = options.origin === undefined ? ORIGIN : options.origin;
      if (origin !== null && method === 'POST') headers.origin = origin;
      if (options.cookies !== false && jar.size > 0) {
        headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      }
      const res = await app.inject({ method, url, headers, payload: options.body });
      const body: Record<string, unknown> =
        res.payload === '' ? {} : (JSON.parse(res.payload) as Record<string, unknown>);
      const raw = res.headers['set-cookie'];
      const setCookies = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
      for (const line of setCookies) {
        const [pair = ''] = line.split(';');
        const [name = '', value = ''] = pair.split('=');
        if (/Max-Age=0\b/.test(line)) jar.delete(name);
        else jar.set(name, value);
      }
      return {
        status: res.statusCode,
        body,
        setCookies,
        headers: res.headers,
      };
    };
    return { jar, send };
  }

  /** A fresh, in-window code: the replay step is rewound first so each sign-in can use the current one. */
  const nextCode = async () => {
    await handle.db.update(userMfa).set({ lastUsedStep: 1 });
    return totpAt(secret, Date.now());
  };

  async function signIn(c: ReturnType<typeof client>) {
    expect(
      (await c.send('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } })).status,
    ).toBe(200);
    return c.send('POST', '/auth/mfa', { body: { code: await nextCode() } });
  }

  it('login then MFA gives a verified session with HttpOnly __Host- Strict cookies, and chooses nothing for two tenants', async () => {
    const c = client();
    const login = await c.send('POST', '/auth/login', {
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ status: 'mfa_required' });
    expect(login.setCookies).toHaveLength(1);
    expect(c.jar.has(COOKIE_NAMES.pending)).toBe(true);
    expect((await c.send('GET', '/auth/me')).status).toBe(401); // pending is not a session

    const mfa = await c.send('POST', '/auth/mfa', { body: { code: await nextCode() } });
    expect(mfa.status).toBe(200);
    expect(mfa.body).toMatchObject({ activeTenant: null });
    expect((mfa.body.tenants as unknown[]).length).toBe(2);
    expect([...c.jar.keys()].sort()).toEqual([COOKIE_NAMES.access, COOKIE_NAMES.refresh].sort());
    for (const line of mfa.setCookies) {
      expect(line).toMatch(/^__Host-sifen_(at|rt|pending)=/);
      expect(line).toContain('HttpOnly');
      expect(line).toContain('Secure');
      expect(line).toContain('SameSite=Strict');
      expect(line).toContain('Path=/');
      expect(line).not.toMatch(/Domain/i);
    }
  });

  it('lists tenants, switches the active one and re-reads membership and role on every request', async () => {
    const c = client();
    await signIn(c);
    const list = await c.send('GET', '/auth/tenants');
    expect(list.body.tenants).toEqual(
      expect.arrayContaining([expect.objectContaining({ tenantId: tenantA, role: 'admin' })]),
    );
    expect(
      (await c.send('POST', '/auth/select-tenant', { body: { tenantId: tenantA } })).status,
    ).toBe(204);
    expect((await c.send('GET', '/auth/me')).body).toMatchObject({
      userId,
      activeTenant: { tenantId: tenantA, role: 'admin' },
    });
    await c.send('POST', '/auth/select-tenant', { body: { tenantId: tenantB } });
    expect((await c.send('GET', '/auth/me')).body).toMatchObject({
      activeTenant: { tenantId: tenantB, role: 'lector' },
    });
    expect(
      (
        await c.send('POST', '/auth/select-tenant', {
          body: { tenantId: '00000000-0000-4000-8000-000000000000' },
        })
      ).status,
    ).toBe(403);

    await handle.db
      .update(tenantMemberships)
      .set({ role: 'emisor' })
      .where(eq(tenantMemberships.tenantId, tenantB));
    expect((await c.send('GET', '/auth/me')).body).toMatchObject({
      activeTenant: { role: 'emisor' },
    });
    await handle.db.delete(tenantMemberships).where(eq(tenantMemberships.tenantId, tenantB));
    expect((await c.send('GET', '/auth/me')).body).toMatchObject({ activeTenant: null });
    await handle.db.insert(tenantMemberships).values({ tenantId: tenantB, userId, role: 'lector' });
  });

  it('rotates the pair on refresh: the old access token dies and the old refresh token cannot be reused', async () => {
    const c = client();
    await signIn(c);
    const oldAccess = c.jar.get(COOKIE_NAMES.access);
    const oldRefresh = c.jar.get(COOKIE_NAMES.refresh);
    const refreshed = await c.send('POST', '/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect(c.jar.get(COOKIE_NAMES.access)).not.toBe(oldAccess);
    expect(c.jar.get(COOKIE_NAMES.refresh)).not.toBe(oldRefresh);
    expect((await c.send('GET', '/auth/me')).status).toBe(200);

    const attacker = client();
    attacker.jar.set(COOKIE_NAMES.access, oldAccess ?? '');
    attacker.jar.set(COOKIE_NAMES.refresh, oldRefresh ?? '');
    expect((await attacker.send('GET', '/auth/me')).status).toBe(401);
    expect((await attacker.send('POST', '/auth/refresh')).status).toBe(401); // reuse revokes the family
    expect((await c.send('GET', '/auth/me')).status).toBe(401);
  });

  it('answers 401 and clears the cookies once the user has been idle past the refresh window', async () => {
    const c = client();
    await signIn(c);
    await handle.db.update(userSessions).set({
      accessExpiresAt: new Date(Date.now() - 2000),
      refreshExpiresAt: new Date(Date.now() - 1000),
    });
    expect((await c.send('GET', '/auth/me')).status).toBe(401);
    const refreshed = await c.send('POST', '/auth/refresh');
    expect(refreshed.status).toBe(401);
    expect(c.jar.size).toBe(0);
    expect(refreshed.setCookies.every((line) => /Max-Age=0\b/.test(line))).toBe(true);
  });

  it('never refreshes past the absolute cap: back to login with password and MFA', async () => {
    const c = client();
    await signIn(c);
    await handle.db.update(userSessions).set({ absoluteExpiresAt: new Date(Date.now() - 1000) });
    expect((await c.send('GET', '/auth/me')).status).toBe(401);
    expect((await c.send('POST', '/auth/refresh')).status).toBe(401);
    const again = client();
    expect((await signIn(again)).status).toBe(200);
  });

  it('logs out: 204, cookies cleared, the session dead server-side even if a cookie is replayed', async () => {
    const c = client();
    await signIn(c);
    const replay = new Map(c.jar);
    const out = await c.send('POST', '/auth/logout');
    expect(out.status).toBe(204);
    expect(c.jar.size).toBe(0);
    const stolen = client();
    for (const [k, v] of replay) stolen.jar.set(k, v);
    expect((await stolen.send('GET', '/auth/me')).status).toBe(401);
    expect((await client().send('POST', '/auth/logout')).status).toBe(204); // idempotent
  });

  it('rejects every state-changing route without the portal Origin (CSRF) and lets GET through', async () => {
    const c = client();
    await signIn(c);
    for (const url of [
      '/auth/login',
      '/auth/mfa',
      '/auth/refresh',
      '/auth/logout',
      '/auth/select-tenant',
    ]) {
      expect((await c.send('POST', url, { origin: null, body: {} })).status, url).toBe(403);
      expect(
        (await c.send('POST', url, { origin: 'https://evil.example.com', body: {} })).status,
        url,
      ).toBe(403);
    }
    expect((await c.send('GET', '/auth/me')).status).toBe(200);
    expect((await c.send('GET', '/auth/tenants')).status).toBe(200);
  });

  it('answers the same 401 for an unknown email and a wrong password, and sets no cookie', async () => {
    const c = client();
    const unknown = await c.send('POST', '/auth/login', {
      body: { email: 'nobody@example.com', password: PASSWORD },
    });
    const wrong = await c.send('POST', '/auth/login', {
      body: { email: EMAIL, password: 'wrong password entirely' },
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(unknown.setCookies).toEqual([]);
    expect(wrong.setCookies).toEqual([]);
  });

  it('rejects malformed bodies with 400 and a wrong MFA code with 401', async () => {
    const c = client();
    expect((await c.send('POST', '/auth/login', { body: { email: 5 } })).status).toBe(400);
    await c.send('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect((await c.send('POST', '/auth/mfa', { body: { code: 'abc' } })).status).toBe(400);
    expect((await c.send('POST', '/auth/mfa', { body: { code: '000000' } })).status).toBe(401);
  });

  it('answers a user without MFA exactly like a wrong password (no password oracle), audits it, and leaves no live session', async () => {
    const created = await new CreateUserUseCase(new Argon2SecretHasherAdapter()).execute({
      email: 'new@example.com',
      displayName: 'New',
      password: PASSWORD,
    });
    const [row] = await handle.db.insert(users).values(created).returning({ id: users.id });
    const c = client();
    const noMfa = await c.send('POST', '/auth/login', {
      body: { email: 'new@example.com', password: PASSWORD },
    });
    const wrong = await c.send('POST', '/auth/login', {
      body: { email: 'new@example.com', password: 'wrong password entirely' },
    });
    expect(noMfa.status).toBe(401);
    expect(noMfa.body).toEqual(wrong.body);
    expect(noMfa.setCookies).toEqual([]);
    const live = await handle.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.userId, row?.id ?? ''));
    expect(live.every((session) => session.revokedAt !== null)).toBe(true);
    const events = await handle.db
      .select()
      .from(authEvents)
      .where(eq(authEvents.userId, row?.id ?? ''));
    expect(events.map((e) => e.event)).toContain('login.mfa_enrollment_required');
    expect((await c.send('POST', '/auth/mfa', { body: { code: '123456' } })).status).toBe(401);
  });

  it('logs out with only the refresh cookie: the whole family dies, even a replayed access cookie', async () => {
    const c = client();
    await signIn(c);
    const access = c.jar.get(COOKIE_NAMES.access) ?? '';
    const onlyRefresh = client();
    onlyRefresh.jar.set(COOKIE_NAMES.refresh, c.jar.get(COOKIE_NAMES.refresh) ?? '');
    const out = await onlyRefresh.send('POST', '/auth/logout');
    expect(out.status).toBe(204);
    expect(out.setCookies.every((line) => /Max-Age=0\b/.test(line))).toBe(true);
    const replay = client();
    replay.jar.set(COOKIE_NAMES.access, access);
    expect((await replay.send('GET', '/auth/me')).status).toBe(401);
  });

  it('logs out a password-only (pending) session too: its cookie stops working', async () => {
    const c = client();
    await c.send('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(c.jar.has(COOKIE_NAMES.pending)).toBe(true);
    const pendingCookie = c.jar.get(COOKIE_NAMES.pending) ?? '';
    expect((await c.send('POST', '/auth/logout')).status).toBe(204);
    expect(c.jar.size).toBe(0);
    const replay = client();
    replay.jar.set(COOKIE_NAMES.pending, pendingCookie);
    expect(
      (await replay.send('POST', '/auth/mfa', { body: { code: await nextCode() } })).status,
    ).toBe(401);
  });

  it('keeps the API-key guard for everything else: /auth is public, /v1 still needs a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/endpoints' });
    expect(res.statusCode).toBe(401);
  });
});
