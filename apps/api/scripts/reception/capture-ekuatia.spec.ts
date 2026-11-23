import { describe, expect, it, vi } from 'vitest';
import { main, type MainDeps } from './capture-ekuatia.js';

const CDC = '1'.repeat(44);
const TOKEN = 'TOKEN-zzz-999';
const API_KEY = 'KEY-secret-0042';

function harness(
  env: Record<string, string | undefined> = {},
  confirmAnswer = true,
  opts: {
    unwritable?: boolean;
    failWrite?: boolean;
    nonEmpty?: boolean;
    repoRoot?: string;
    networkDown?: boolean;
  } = {},
) {
  const prepared: string[] = [];
  const keyReads: string[] = [];
  const guardedEnv = new Proxy<Record<string, string | undefined>>(
    { TWOCAPTCHA_API_KEY: API_KEY, ...env },
    {
      get(target: Record<string, string | undefined>, prop: string): string | undefined {
        if (prop === 'TWOCAPTCHA_API_KEY') keyReads.push(prop);
        return target[prop];
      },
    },
  );
  const printed: string[] = [];
  const written = new Map<string, string>();
  const fetchFake = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
    opts.networkDown
      ? Promise.reject(new Error('down'))
      : Promise.resolve(
          init?.method === 'POST'
            ? new Response('{"DE":{}}', { status: 200, headers: { 'set-cookie': 'sid=S; path=/' } })
            : new Response('<rDE xmlns="x"/>', { status: 200 }),
        ),
  ) as unknown as typeof fetch;
  const createSolver = vi.fn(() => ({ solveRecaptchaV2: vi.fn().mockResolvedValue(TOKEN) }));
  const confirm = vi.fn().mockResolvedValue(confirmAnswer);
  const deps: MainDeps = {
    env: guardedEnv,
    print: (line) => printed.push(line),
    confirm,
    fetch: fetchFake,
    createSolver,
    repoRoot: opts.repoRoot ?? '/nonexistent-repo',
    isNonEmptyDir: () => opts.nonEmpty === true,
    prepareDir: (path) => {
      if (opts.unwritable) throw new Error(`EACCES ${API_KEY}`);
      prepared.push(path);
    },
    writeFile: (path, content) => {
      if (opts.failWrite) throw new Error(`ENOSPC ${API_KEY}`);
      written.set(path, content);
    },
    now: () => new Date('2026-11-23T10:00:00Z'),
  };
  return { prepared, deps, keyReads, printed, written, fetchFake, createSolver, confirm };
}

const HUMAN = ['--i-am-a-human', '--cdc', CDC];

describe('capture-ekuatia main guards', () => {
  it.each([
    ['CI is set', ['--i-am-a-human', '--cdc', CDC], { CI: 'true' }],
    ['--i-am-a-human is missing', ['--cdc', CDC], {}],
    ['the CDC is missing', ['--i-am-a-human'], {}],
    ['the CDC is not 44 digits', ['--i-am-a-human', '--cdc', '123'], {}],
    ['an argument is unknown', [...HUMAN, '--bogus'], {}],
  ])('exits non-zero without any request when %s', async (_name, argv, env) => {
    const h = harness(env);
    expect(await main(argv, h.deps)).not.toBe(0);
    expect(h.fetchFake).not.toHaveBeenCalled();
    expect(h.createSolver).not.toHaveBeenCalled();
    expect(h.keyReads).toEqual([]);
    expect(h.written.size).toBe(0);
  });

  it('exits non-zero when the captcha key is not provided', async () => {
    const h = harness({ TWOCAPTCHA_API_KEY: '' });
    expect(await main(HUMAN, h.deps)).not.toBe(0);
    expect(h.fetchFake).not.toHaveBeenCalled();
    expect(h.createSolver).not.toHaveBeenCalled();
  });

  it('prints the cost summary and stops when the human declines', async () => {
    const h = harness({}, false);
    expect(await main(HUMAN, h.deps)).not.toBe(0);
    const text = h.printed.join('\n');
    expect(text).toMatch(/ekuatia\.set\.gov\.py/);
    expect(text).toMatch(/2captcha\.com/);
    expect(text).toMatch(/costs? money/i);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.fetchFake).not.toHaveBeenCalled();
    expect(h.createSolver).not.toHaveBeenCalled();
  });
});

describe('capture-ekuatia main happy path', () => {
  it('skips the prompt with --yes, writes the capture and never leaks secrets', async () => {
    const h = harness();
    expect(await main([...HUMAN, '--yes', '--out', 'OUT'], h.deps)).toBe(0);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.createSolver).toHaveBeenCalledWith(API_KEY);
    expect([...h.written.keys()].sort()).toEqual([
      'OUT/v2026-Q4/success/documento.xml',
      'OUT/v2026-Q4/success/meta.json',
      'OUT/v2026-Q4/success/requests.json',
    ]);
    const everything = [...h.written.values(), ...h.printed].join('\n');
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain(TOKEN);
    expect(h.written.get('OUT/v2026-Q4/success/requests.json')).toContain('"cookie_names"');
  });

  it('asks for confirmation interactively when --yes is absent', async () => {
    const h = harness();
    expect(await main(HUMAN, h.deps)).toBe(0);
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it('reports a failed solver without leaking and exits non-zero', async () => {
    const h = harness();
    h.createSolver.mockReturnValue({
      solveRecaptchaV2: vi.fn().mockRejectedValue(new Error(`x ${API_KEY}`)),
    });
    expect(await main([...HUMAN, '--yes'], h.deps)).not.toBe(0);
    expect(h.printed.join('\n')).not.toContain(API_KEY);
  });

  it('runs the invalid-captcha probe without a key, a solver or a spend', async () => {
    const h = harness({ TWOCAPTCHA_API_KEY: undefined });
    expect(await main([...HUMAN, '--yes', '--probe-rejected-captcha'], h.deps)).toBe(0);
    expect(h.createSolver).not.toHaveBeenCalled();
    expect(h.keyReads).toEqual([]);
    expect(h.printed.join('\n')).toMatch(/does not spend/i);
  });

  it('still refuses the probe without --i-am-a-human', async () => {
    const h = harness({ TWOCAPTCHA_API_KEY: undefined });
    expect(await main(['--cdc', CDC, '--probe-rejected-captcha'], h.deps)).not.toBe(0);
    expect(h.fetchFake).not.toHaveBeenCalled();
  });

  it.each(['..', 'a/b', 'a\\b', '', 'has space'])(
    'exits non-zero without any request or solver for label %j',
    async (label) => {
      const h = harness();
      expect(await main([...HUMAN, '--yes', '--label', label], h.deps)).not.toBe(0);
      expect(h.fetchFake).not.toHaveBeenCalled();
      expect(h.createSolver).not.toHaveBeenCalled();
      expect(h.keyReads).toEqual([]);
      expect(h.prepared).toEqual([]);
    },
  );

  it('fails before solving the captcha when the output directory is not writable', async () => {
    const h = harness({}, true, { unwritable: true });
    expect(await main([...HUMAN, '--yes'], h.deps)).not.toBe(0);
    expect(h.createSolver).not.toHaveBeenCalled();
    expect(h.fetchFake).not.toHaveBeenCalled();
    expect(h.printed.join('\n')).not.toContain(API_KEY);
  });

  it('prepares the output directory before the captcha is solved', async () => {
    const h = harness();
    expect(await main([...HUMAN, '--yes', '--out', 'OUT'], h.deps)).toBe(0);
    expect(h.prepared).toEqual(['OUT/v2026-Q4/success']);
  });

  it('says where the result stayed (memory) when writing fails later, without secrets', async () => {
    const h = harness({}, true, { failWrite: true });
    expect(await main([...HUMAN, '--yes', '--out', 'OUT'], h.deps)).not.toBe(0);
    const text = h.printed.join('\n');
    expect(text).toMatch(/only in memory/i);
    expect(text).toContain('OUT/v2026-Q4/success');
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(TOKEN);
  });

  it('refuses a repeated label whose output directory already has files', async () => {
    const h = harness({}, true, { nonEmpty: true });
    expect(await main([...HUMAN, '--yes'], h.deps)).not.toBe(0);
    expect(h.createSolver).not.toHaveBeenCalled();
    expect(h.fetchFake).not.toHaveBeenCalled();
    expect(h.prepared).toEqual([]);
  });

  it.each(['/repo/apps/api/src', '/repo/docs'])(
    'refuses --out %s inside the versioned tree',
    async (out) => {
      const h = harness({}, true, { repoRoot: '/repo' });
      expect(await main([...HUMAN, '--yes', '--out', out], h.deps)).not.toBe(0);
      expect(h.createSolver).not.toHaveBeenCalled();
      expect(h.fetchFake).not.toHaveBeenCalled();
    },
  );

  it.each(['/repo/apps/api/.captures', '/elsewhere/out'])('allows --out %s', async (out) => {
    const h = harness({}, true, { repoRoot: '/repo' });
    expect(await main([...HUMAN, '--yes', '--out', out], h.deps)).toBe(0);
  });

  it('writes the files but exits non-zero when no request got a status', async () => {
    const h = harness({}, true, { networkDown: true });
    expect(await main([...HUMAN, '--yes', '--out', 'OUT'], h.deps)).not.toBe(0);
    expect(h.written.has('OUT/v2026-Q4/success/requests.json')).toBe(true);
    expect(h.printed.join('\n')).toMatch(/no response/i);
  });
});
