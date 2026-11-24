import type { Fidelity, SourceCapability } from '@ledger/contracts';
import type { PoolClient } from '@ledger/persistence';

interface SourceDeclaration {
  source_id: string;
  event_type: string;
  principal_id: string;
  declared_fidelity: string | null;
  schema_digest: string | null;
  declared_limitations: unknown;
}

export async function readSourceCapabilities(client: PoolClient): Promise<SourceCapability[]> {
  const rows = await client.query<SourceDeclaration>(
    'SELECT source_id,event_type,principal_id,declared_fidelity,schema_digest,declared_limitations FROM source_declarations ORDER BY source_id,event_type,principal_id,declaration_digest',
  );
  return sourceCapabilities(rows.rows);
}

function limitationText(value: string): string {
  return value
    .replace(
      /\b(?:ledger-(?:dev|service)-[A-Za-z0-9_-]+|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*)/gi,
      '[redacted credential]',
    )
    .replace(
      /\b(authorization|cookie|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
      '$1=[redacted credential]',
    )
    .trim()
    .slice(0, 1000);
}

export function sourceCapabilities(rows: SourceDeclaration[]): SourceCapability[] {
  const capabilities = new Map<string, SourceCapability>();
  for (const row of rows) {
    const fidelity: Fidelity =
      row.declared_fidelity === 'documented_schema_conformant' ? 'documented_schema_conformant' : 'synthetic_contract';
    const schemaDigest =
      typeof row.schema_digest === 'string' && /^[a-fA-F0-9]{64}$/.test(row.schema_digest)
        ? row.schema_digest.toLowerCase()
        : undefined;
    const key = JSON.stringify([row.source_id, row.event_type, fidelity, schemaDigest ?? null]);
    let capability = capabilities.get(key);
    if (!capability) {
      capability = {
        sourceId: row.source_id,
        capability: row.event_type,
        fidelity,
        ...(schemaDigest ? { schemaDigest } : {}),
        limitations: [],
      };
      capabilities.set(key, capability);
    }
    const limitations = new Set(capability.limitations);
    const producer = `Producer principal ${row.principal_id}`;
    limitations.add(
      'Ledger has no source-validation registry; captured replay, vendor sandbox, and live-source validation are not certified.',
    );
    if (row.declared_fidelity === 'documented_schema_conformant') {
      limitations.add(
        `${producer} asserted documented_schema_conformant; Ledger has not checked these bodies against a pinned schema.`,
      );
    } else if (row.declared_fidelity === 'synthetic_contract') {
      limitations.add(
        `${producer} declared synthetic_contract; behavior remains synthetic until independent validation is registered.`,
      );
    } else if (row.declared_fidelity) {
      limitations.add(
        `${producer} declared ${row.declared_fidelity}; effective fidelity is capped at synthetic_contract because that validation is not registered.`,
      );
    } else
      limitations.add(
        `${producer} supplied no fidelity declaration; effective fidelity defaults to synthetic_contract.`,
      );
    if (schemaDigest)
      limitations.add(
        'Schema digest is a producer-supplied SHA-256 reference; Ledger has not verified the referenced schema or provenance bytes.',
      );
    else if (row.schema_digest)
      limitations.add('Producer schemaDigest was omitted because it is not a 64-digit hexadecimal SHA-256 value.');
    else if (row.declared_fidelity === 'documented_schema_conformant')
      limitations.add('Producer supplied no pinned schema digest for this conformance assertion.');
    if (Array.isArray(row.declared_limitations))
      for (const value of row.declared_limitations) {
        if (typeof value === 'string') {
          const text = limitationText(value);
          if (text) limitations.add(`Producer limitation (${row.principal_id}): ${text}`);
        }
      }
    capability.limitations = [...limitations].sort();
  }
  return [...capabilities.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
