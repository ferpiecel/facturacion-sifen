import { createRequire } from 'node:module';
import { cruise, type IFlattenedRuleSet } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// Load the package-local config that `pnpm depcruise` uses, not a copy of its rules.
const localConfig = require('../.dependency-cruiser.cjs') as {
  forbidden: IFlattenedRuleSet['forbidden'];
};

describe('sifen-gateway framework isolation (package-local dependency-cruiser config)', () => {
  it('flags a src/ file that imports a framework package', async () => {
    const result = await cruise(
      ['src'],
      { validate: true, ruleSet: { forbidden: localConfig.forbidden }, baseDir: 'test/fixtures' },
      {},
    );
    if (typeof result.output === 'string') throw new Error('Expected a structured cruise result.');

    const violations = result.output.summary.violations.map((violation) => violation.rule.name);
    expect(violations).toContain('sifen-gateway-framework-free-local');
  });
});
