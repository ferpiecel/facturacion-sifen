import { createRequire } from 'node:module';
import { cruise, type IFlattenedRuleSet } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// Load the package-local config that `pnpm depcruise` uses, and the root
// config it overrides, not copies of their rules.
const localConfig = require('../.dependency-cruiser.cjs') as {
  forbidden: IFlattenedRuleSet['forbidden'];
};
const rootConfig = require('../../../.dependency-cruiser.cjs') as {
  forbidden: IFlattenedRuleSet['forbidden'];
};

describe('sifen-tips TIPS-library confinement (package-local dependency-cruiser config)', () => {
  it('does not flag its own src for importing the TIPS libraries', async () => {
    const result = await cruise(
      ['src'],
      { validate: true, ruleSet: { forbidden: localConfig.forbidden } },
      {},
    );
    if (typeof result.output === 'string') throw new Error('Expected a structured cruise result.');

    const violations = result.output.summary.violations.map((violation) => violation.rule.name);
    expect(violations).not.toContain('tips-libs-confined-to-sifen-tips');
  });

  it('still flags a fixture elsewhere that imports a TIPS library under the root rule', async () => {
    const result = await cruise(
      ['src'],
      { validate: true, ruleSet: { forbidden: rootConfig.forbidden }, baseDir: 'test/fixtures' },
      {},
    );
    if (typeof result.output === 'string') throw new Error('Expected a structured cruise result.');

    const violations = result.output.summary.violations.map((violation) => violation.rule.name);
    expect(violations).toContain('tips-libs-confined-to-sifen-tips');
  });
});
