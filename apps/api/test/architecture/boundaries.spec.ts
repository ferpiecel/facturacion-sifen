import { createRequire } from 'node:module';
import path from 'node:path';
import { cruise, type ICruiseResult, type IFlattenedRuleSet } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const ruleConfig = require('../../../../.dependency-cruiser.cjs') as {
  options: Record<string, unknown>;
  forbidden: IFlattenedRuleSet['forbidden'];
};

const FIXTURES_ROOT = path.resolve(import.meta.dirname, '../fixtures/boundaries');

async function cruiseFixtures(): Promise<ICruiseResult> {
  const result = await cruise(
    [FIXTURES_ROOT],
    {
      validate: true,
      ruleSet: { forbidden: ruleConfig.forbidden },
      ...ruleConfig.options,
    },
    {},
  );

  if (typeof result.output === 'string') {
    throw new Error('Expected a structured cruise result, got a formatted string.');
  }

  return result.output;
}

function violatedRuleNames(cruiseResult: ICruiseResult, sourceSuffix: string): string[] {
  const module = cruiseResult.modules.find((candidate) => candidate.source.endsWith(sourceSuffix));
  if (!module) {
    throw new Error(`Fixture module not found in cruise result: ${sourceSuffix}`);
  }

  return module.dependencies
    .filter((dependency) => !dependency.valid)
    .flatMap((dependency) => dependency.rules?.map((rule) => rule.name) ?? []);
}

describe('architecture boundaries (dependency-cruiser rules on fixtures)', () => {
  it('flags a domain file importing a framework package', async () => {
    const result = await cruiseFixtures();

    expect(violatedRuleNames(result, 'modules/sample/domain/framework-import.ts')).toContain(
      'domain-app-framework-free',
    );
  });

  it('flags a domain file importing from application', async () => {
    const result = await cruiseFixtures();

    expect(violatedRuleNames(result, 'modules/sample/domain/imports-application.ts')).toContain(
      'domain-no-outer-layers',
    );
  });

  it('flags an application file importing from infrastructure', async () => {
    const result = await cruiseFixtures();

    expect(
      violatedRuleNames(result, 'modules/sample/application/imports-infrastructure.ts'),
    ).toContain('application-no-infrastructure');
  });

  it('does not flag infrastructure importing from application', async () => {
    const result = await cruiseFixtures();
    const module = result.modules.find((candidate) =>
      candidate.source.endsWith('modules/sample/infrastructure/imports-application-allowed.ts'),
    );

    expect(module).toBeDefined();
    expect(module?.dependencies.every((dependency) => dependency.valid)).toBe(true);
  });
});
