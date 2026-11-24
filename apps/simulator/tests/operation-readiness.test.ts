import { describe, expect, it } from 'vitest';
import type { Principal } from '@ledger/contracts';
import { openApiDocument } from '../../../packages/contracts/src/openapi.js';
import {
  assertHostedOrdinarySourceTokens,
  assertOperationSourceReadiness,
  checkOperationReadiness,
} from '../src/operation-readiness.js';

const config = {
  apiUrl: 'http://ledger.test/',
  tokens: {
    alpha: { source: 'alpha-source-token', actor: 'alpha-actor-token' },
    beta: { source: 'beta-source-token', actor: 'beta-actor-token' },
  },
};
function fixture(document: unknown = openApiDocument) {
  const identities = new Map<string, Principal>();
  for (const tenant of ['alpha', 'beta'] as const)
    for (const role of ['source', 'actor'] as const)
      identities.set(config.tokens[tenant][role], {
        id: `${tenant}-${role}`,
        tenantId: `tenant-${tenant}`,
        name: `${tenant} ${role}`,
        revision: 1,
        commandLinkSources: [],
        missionSources: [],
        capabilities:
          role === 'source'
            ? ['input:write', 'flight:create', 'flight:read', 'order:read']
            : ['input:write', 'flight:read'],
      });
  const calls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.method ?? 'GET').toBe('GET');
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === '/openapi.json') return Response.json(document);
    if (path === '/v1/me') {
      const credential = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '');
      return Response.json({ principal: identities.get(credential ?? '') });
    }
    throw new Error(`Unexpected readiness request ${path}`);
  };
  return { fetcher, calls, identities };
}

describe('live operation readiness', () => {
  it('requires service credentials for the hosted ordinary reader while other modes retain their credentials', () => {
    expect(() => assertHostedOrdinarySourceTokens(config.tokens)).toThrow('alpha ordinary hosted source');
    const tokens = structuredClone(config.tokens);
    tokens.alpha.source = 'ledger-service-alpha-source';
    expect(() => assertHostedOrdinarySourceTokens(tokens)).toThrow('beta ordinary hosted source');
    tokens.beta.source = 'ledger-service-beta-source';
    expect(() => assertHostedOrdinarySourceTokens(tokens)).not.toThrow();
  });
  it('checks the actual served contract and resolves both tenants without requiring proposed safety inputs', async () => {
    const { fetcher, calls } = fixture();
    const ready = await checkOperationReadiness(config, fetcher);
    expect(ready.apiVersion).toBe('0.1.0');
    expect(ready.contractVersion).toBe('ledger.demo-contract.1');
    expect(ready.principals.alpha.source.id).toBe('alpha-source');
    expect(ready.principals.alpha.actor.id).toBe('alpha-actor');
    expect(ready.principals.beta.source.tenantId).toBe('tenant-beta');
    expect(ready.principals.beta.actor.tenantId).toBe('tenant-beta');
    expect(calls).toEqual(['/openapi.json', '/v1/me', '/v1/me', '/v1/me', '/v1/me']);
  });

  it('requires each source principal’s capability and exact grant only for selected mission delivery', async () => {
    const selected = {
      profile: { missionPlan: 'dispatch-plan.1' },
      capability: 'mission:write',
      grants: 'missionSources',
      sourceId: 'mission-planner',
    } as const;
    const f = fixture();
    for (const tenant of ['alpha', 'beta'] as const) {
      const actor = f.identities.get(config.tokens[tenant].actor)!;
      actor.capabilities.push(selected.capability);
      actor[selected.grants] = [selected.sourceId];
    }
    const ready = await checkOperationReadiness(config, f.fetcher);
    expect(() => assertOperationSourceReadiness(ready, {})).not.toThrow();
    expect(() => assertOperationSourceReadiness(ready, selected.profile)).toThrow(
      `alpha source requires ${selected.capability}`,
    );
    for (const tenant of ['alpha', 'beta'] as const) {
      const source = ready.principals[tenant].source;
      source.capabilities.push(selected.capability);
      source[selected.grants] = [`${selected.sourceId}-other`];
    }
    expect(() => assertOperationSourceReadiness(ready, selected.profile)).toThrow(
      `alpha source requires ${selected.sourceId} in ${selected.grants}`,
    );
    ready.principals.alpha.source[selected.grants] = [selected.sourceId];
    expect(() => assertOperationSourceReadiness(ready, selected.profile)).toThrow(
      `beta source requires ${selected.sourceId} in ${selected.grants}`,
    );
    ready.principals.beta.source[selected.grants] = [selected.sourceId];
    expect(() => assertOperationSourceReadiness(ready, selected.profile)).not.toThrow();
  });

  it('rejects a stale contract before reading identities or permitting intake', async () => {
    const document = JSON.parse(JSON.stringify(openApiDocument));
    document['x-ledger-demo-contract-version'] = 'ledger.demo-contract.0';
    const { fetcher, calls } = fixture(document);
    await expect(checkOperationReadiness(config, fetcher)).rejects.toThrow(
      'contract version must be ledger.demo-contract.1',
    );
    expect(calls).toEqual(['/openapi.json']);
  });

  it('requires a link.status grant for the command-link source before link reports can be delivered', async () => {
    const ready = await checkOperationReadiness(config, fixture().fetcher);
    const grant = { sourceId: 'command-link', observationType: 'link.status' };
    for (const options of [
      [{}, true],
      [{ commandLinkEpisode: 'canal-market-relay.1' }, false],
    ] as const) {
      for (const tenant of ['alpha', 'beta'] as const) ready.principals[tenant].source.observationGrants = [];
      expect(() => assertOperationSourceReadiness(ready, options[0], options[1])).toThrow(
        'alpha source requires a link.status observation grant for command-link',
      );
      for (const tenant of ['alpha', 'beta'] as const) ready.principals[tenant].source.observationGrants = [grant];
      expect(() => assertOperationSourceReadiness(ready, options[0], options[1])).not.toThrow();
      ready.principals.beta.source.observationGrants = [{ ...grant, sourceId: 'other-radio' }];
      expect(() => assertOperationSourceReadiness(ready, options[0], options[1])).toThrow(
        'beta source requires a link.status observation grant for command-link',
      );
    }
  });

  it('inspects input kinds and retained-byte fields rather than relying only on the version label', async () => {
    const document = JSON.parse(JSON.stringify(openApiDocument));
    const input = document.paths['/v1/inputs'].post.requestBody.content['application/json'].schema;
    input.properties.kind.anyOf = input.properties.kind.anyOf.filter(
      (kind: { const: string }) => kind.const !== 'telemetry.segment',
    );
    const missingKind = fixture(document);
    await expect(checkOperationReadiness(config, missingKind.fetcher)).rejects.toThrow(
      'does not accept telemetry.segment',
    );
    expect(missingKind.calls).toEqual(['/openapi.json']);

    input.properties.kind.anyOf.push({ type: 'string', const: 'telemetry.segment' });
    delete input.properties.sourceSessionId;
    await expect(checkOperationReadiness(config, fixture(document).fetcher)).rejects.toThrow(
      '/v1/inputs.sourceSessionId',
    );
  });

  it('requires upload finalization and idempotency before any evidence delivery', async () => {
    const document = JSON.parse(JSON.stringify(openApiDocument));
    delete document.paths['/v1/uploads/{id}/finalize'];
    await expect(checkOperationReadiness(config, fixture(document).fetcher)).rejects.toThrow(
      '/v1/uploads/{id}/finalize',
    );
    document.paths['/v1/uploads/{id}/finalize'] = openApiDocument.paths['/v1/uploads/{id}/finalize'];
    document.paths['/v1/inputs'].post.parameters = [];
    await expect(checkOperationReadiness(config, fixture(document).fetcher)).rejects.toThrow(
      '/v1/inputs must require Idempotency-Key',
    );
  });

  it('accepts legacy subject requirements and rejects conditional schemas that leave flight inputs unscoped', async () => {
    const document = JSON.parse(JSON.stringify(openApiDocument));
    const input = document.paths['/v1/inputs'].post.requestBody.content['application/json'].schema;
    input.required.push('subject');
    expect((await checkOperationReadiness(config, fixture(document).fetcher)).principals.alpha.source.id).toBe(
      'alpha-source',
    );
    input.required = input.required.filter((field: string) => field !== 'subject');
    const monitoring = input.allOf.find(
      (clause: { if: { properties: { kind: { const: string } } } }) =>
        clause.if.properties.kind.const === 'monitoring.window',
    );
    delete monitoring.else;
    const unsafe = fixture(document);
    await expect(checkOperationReadiness(config, unsafe.fetcher)).rejects.toThrow(
      'must require subject for order.revision',
    );
    expect(unsafe.calls).toEqual(['/openapi.json']);
  });

  it('rejects wrong-tenant credentials and missing actor authority before mutations', async () => {
    const wrongTenant = fixture();
    wrongTenant.identities.get(config.tokens.beta.actor)!.tenantId = 'tenant-alpha';
    await expect(checkOperationReadiness(config, wrongTenant.fetcher)).rejects.toThrow(
      'beta actor GET /v1/me must authenticate tenant-beta',
    );

    const missingCapability = fixture();
    missingCapability.identities.get(config.tokens.alpha.actor)!.capabilities = ['flight:read'];
    await expect(checkOperationReadiness(config, missingCapability.fetcher)).rejects.toThrow(
      'alpha actor requires input:write',
    );
  });
});
