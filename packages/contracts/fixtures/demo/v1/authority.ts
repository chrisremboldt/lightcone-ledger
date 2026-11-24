import type { AuthorityPrincipalResponse } from '../../../src/index.js';

export const principalAuthority = {
  principal: {
    id: 'principal-example-owner',
    tenantId: 'tenant-example',
    name: 'Example owner',
    kind: 'human',
    active: true,
    revision: 4,
    capabilities: ['flight:read', 'decision:write', 'briefing:ack'],
    commandLinkSources: [],
    missionSources: [],
    monitoringSources: [],
  },
} satisfies AuthorityPrincipalResponse;
