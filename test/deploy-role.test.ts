import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const deployRolePath = resolve(dirname(fileURLToPath(import.meta.url)), '../bootstrap/deploy-role.yaml');

interface Statement {
  Sid?: string;
  Action: string[] | string;
  Resource: string[] | string;
}

function logsStatement(): Statement {
  const doc = YAML.parse(readFileSync(deployRolePath, 'utf-8'), { logLevel: 'silent' }) as {
    Resources: Record<string, { Properties?: { Policies?: { PolicyDocument: { Statement: Statement[] } }[] } }>;
  };
  const statements = Object.values(doc.Resources).flatMap(
    (r) => r.Properties?.Policies?.flatMap((p) => p.PolicyDocument.Statement) ?? []
  );
  const logs = statements.find((s) => s.Sid === 'Logs');
  if (!logs) throw new Error('deploy-role.yaml has no Sid: Logs statement');
  return logs;
}

const asList = (v: string[] | string): string[] => (Array.isArray(v) ? v : [v]);

describe('deploy role Logs statement', () => {
  // CloudFormation calls logs:ListTagsForResource on every AWS::Logs::LogGroup
  // update, and the tagging APIs authorize against the bare log-group ARN, which
  // a `log-group:<name>:*` pattern does not match. Missing the bare form left
  // the wxyc-canary stack in UPDATE_ROLLBACK_FAILED on a RetentionInDays change.
  it.each([
    ['legacy APIs', (arn: string) => arn.endsWith('log-group:/aws/lambda/wxyc-canary*:*')],
    ['tagging APIs', (arn: string) => arn.endsWith('log-group:/aws/lambda/wxyc-canary*')],
  ])('grants the log-group ARN form used by the %s', (_label, matches) => {
    expect(asList(logsStatement().Resource).some(matches)).toBe(true);
  });

  it('includes the tagging actions CloudFormation needs to update a log group', () => {
    expect(asList(logsStatement().Action)).toEqual(
      expect.arrayContaining(['logs:ListTagsForResource', 'logs:TagResource'])
    );
  });
});
