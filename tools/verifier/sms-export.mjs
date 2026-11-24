import { BundleVerificationError, canonicalDigest, decodeBase64, requireValue, sha256 } from './integrity.mjs';

export const SMS_EXPORT_FORMAT = 'ledger.sms-export.1';
const SECTIONS = ['records', 'decisions', 'signatures', 'artifacts', 'withheld', 'people'];
const CLASSES = new Set(['ordinary', 'safety_report', 'restricted_asset_information']);
const DIGEST = /^[a-f0-9]{64}$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const list = (value, path) => {
  requireValue(Array.isArray(value), 'section_type', path, 'Expected a list');
  return value;
};
const text = (value, path) => {
  requireValue(typeof value === 'string' && value.length > 0, 'field_type', path, 'Expected non-empty text');
  return value;
};
const digest = (value, path) => {
  requireValue(typeof value === 'string' && DIGEST.test(value), 'digest_encoding', path, 'Expected a SHA-256 digest');
  return value;
};
function unique(items, key, path) {
  const seen = new Map();
  items.forEach((item, index) => {
    const id = key(item);
    requireValue(!seen.has(id), 'duplicate_item', `${path}[${index}]`, `Duplicate item ${id}`);
    seen.set(id, item);
  });
  return seen;
}

function verifyManifest(bundle, expectedManifestDigest) {
  requireValue(isObject(bundle), 'bundle_type', '$', 'Bundle must be a JSON object');
  requireValue(bundle.format === SMS_EXPORT_FORMAT, 'unsupported_format', '$.format', 'Not an SMS export bundle');
  const manifest = bundle.manifest;
  requireValue(isObject(manifest), 'manifest_type', '$.manifest', 'Manifest must be an object');
  requireValue(
    manifest.format === SMS_EXPORT_FORMAT,
    'manifest_format',
    '$.manifest.format',
    'Manifest format differs',
  );
  requireValue(
    canonicalDigest(manifest) === bundle.manifestDigest,
    'manifest_digest',
    '$.manifestDigest',
    'Manifest digest does not match the manifest',
  );
  if (expectedManifestDigest !== undefined)
    requireValue(
      bundle.manifestDigest === expectedManifestDigest,
      'expected_manifest_digest',
      '$.manifestDigest',
      'Manifest digest differs from the digest you saved at export',
    );
  requireValue(
    Object.keys(bundle).sort().join(',') === ['format', 'manifest', 'manifestDigest', ...SECTIONS].sort().join(','),
    'bundle_sections',
    '$',
    'Bundle has missing or undeclared sections',
  );
  for (const section of SECTIONS)
    requireValue(
      manifest.sectionDigests?.[section] === canonicalDigest(list(bundle[section], `$.${section}`)),
      'section_digest',
      `$.${section}`,
      `Section ${section} does not match its manifest digest`,
    );
  const scope = manifest.scope;
  requireValue(
    isObject(scope) &&
      ['record_closure', 'period'].includes(scope.kind) &&
      typeof scope.statement === 'string' &&
      scope.statement,
    'scope_statement',
    '$.manifest.scope',
    'A filtered export must state its scope',
  );
  const exported = bundle.records.map((record) => record.id).sort();
  requireValue(
    Array.isArray(scope.recordIds) && [...scope.recordIds].sort().join('\u0000') === exported.join('\u0000'),
    'scope_closure',
    '$.manifest.scope.recordIds',
    'The declared record closure differs from the exported records',
  );
  const selected = scope.kind === 'period' ? scope.selectedRecordIds : [scope.recordId];
  requireValue(
    Array.isArray(selected) && selected.length > 0 && selected.every((id) => scope.recordIds.includes(id)),
    'scope_closure',
    '$.manifest.scope',
    'Selected record missing',
  );
  if (scope.kind === 'period')
    requireValue(
      typeof scope.from === 'string' &&
        typeof scope.to === 'string' &&
        Number.isFinite(Date.parse(scope.from)) &&
        Date.parse(scope.from) < Date.parse(scope.to),
      'scope_period',
      '$.manifest.scope',
      'The period must end after it starts',
    );
  return manifest;
}

function verifyRecords(bundle) {
  const versions = new Map();
  const attachments = new Map();
  const withheld = unique(bundle.withheld, (item) => `${item.kind}:${item.id}`, '$.withheld');
  const declared = new Set();
  bundle.records.forEach((record, index) => {
    const path = `$.records[${index}]`;
    text(record.id, `${path}.id`);
    requireValue(CLASSES.has(record.confidentiality), 'confidentiality_class', path, 'Unknown confidentiality class');
    text(record.recordClass, `${path}.recordClass`);
    requireValue(
      record.confidentiality === 'ordinary' || (!record.links?.length && !record.linkChanges?.length),
      'restricted_content_present',
      path,
      'A restricted record carries links in an ordinary export',
    );
    list(record.versions, `${path}.versions`).forEach((version, at) => {
      const where = `${path}.versions[${at}]`;
      digest(version.bodyDigest, `${where}.bodyDigest`);
      versions.set(`${record.id}\u0000${version.versionNumber}`, version);
      if (version.body === null) {
        const declaration = withheld.get(`record_body:${version.eventId}`);
        requireValue(
          declaration &&
            declaration.recordId === record.id &&
            declaration.sha256 === version.bodyDigest &&
            declaration.confidentiality !== 'ordinary',
          'undeclared_withholding',
          where,
          'A record body is missing without a withheld declaration',
        );
        declared.add(`record_body:${version.eventId}`);
      } else {
        requireValue(
          record.confidentiality === 'ordinary',
          'restricted_content_present',
          where,
          'A non-ordinary record body is present in an ordinary export',
        );
        requireValue(
          canonicalDigest(version.body) === version.bodyDigest,
          'body_digest',
          where,
          'Record body does not match its digest',
        );
      }
    });
    list(record.attachments, `${path}.attachments`).forEach((attachment) => {
      requireValue(CLASSES.has(attachment.confidentiality), 'confidentiality_class', path, 'Unknown attachment class');
      attachments.set(attachment.id, { ...attachment, recordId: record.id });
    });
  });
  const artifacts = unique(bundle.artifacts, (item) => item.attachmentId, '$.artifacts');
  for (const [id, attachment] of attachments) {
    const path = `$.attachments.${id}`;
    if (attachment.confidentiality === 'ordinary') {
      const artifact = artifacts.get(id);
      requireValue(artifact, 'attachment_bytes_missing', path, 'An ordinary attachment has no bytes in the export');
      const bytes = decodeBase64(artifact.bytesBase64, path);
      requireValue(
        bytes.byteLength === attachment.byteLength && sha256(bytes) === attachment.sha256,
        'attachment_digest',
        path,
        'Attachment bytes do not match their digest',
      );
    } else {
      requireValue(!artifacts.has(id), 'restricted_content_present', path, 'Restricted attachment bytes are present');
      const declaration = withheld.get(`attachment:${id}`);
      requireValue(
        declaration &&
          declaration.recordId === attachment.recordId &&
          declaration.confidentiality === attachment.confidentiality &&
          declaration.sha256 === attachment.sha256 &&
          declaration.byteLength === attachment.byteLength,
        'undeclared_withholding',
        path,
        'A restricted attachment is missing without a matching withheld declaration',
      );
      declared.add(`attachment:${id}`);
    }
  }
  for (const id of artifacts.keys())
    requireValue(
      attachments.has(id),
      'undeclared_bytes',
      `$.artifacts.${id}`,
      'Bytes belong to no exported attachment',
    );
  for (const key of withheld.keys())
    requireValue(declared.has(key), 'stray_withholding', `$.withheld.${key}`, 'Declaration names no exported item');
  return { versions, attachments, withheld };
}

function verifySignatures(bundle, versions, attachments) {
  const decisions = unique(bundle.decisions, (decision) => decision.id, '$.decisions');
  const signatures = unique(bundle.signatures, (signature) => signature.id, '$.signatures');
  const records = new Set(bundle.records.map((record) => record.id));
  for (const [id, decision] of decisions) {
    const path = `$.decisions.${id}`;
    requireValue(decision.version === 'sms.decision.1', 'decision_version', path, 'Unknown decision version');
    requireValue(records.has(decision.subjectId), 'decision_subject', path, 'Decision names no exported record');
    if (decision.signature) {
      const signature = signatures.get(decision.signature.id);
      requireValue(signature, 'signature_missing', path, 'A signed decision has no signature in the export');
      requireValue(
        signature.decisionId === id && signature.contentDigest === decision.signature.contentDigest,
        'signature_binding',
        path,
        'Decision and signature do not name each other',
      );
    }
  }
  for (const [id, signature] of signatures) {
    const path = `$.signatures.${id}`;
    requireValue(isObject(signature.content), 'signature_content', path, 'Signed content must be an object');
    requireValue(
      canonicalDigest(signature.content) === digest(signature.contentDigest, `${path}.contentDigest`),
      'signature_digest',
      path,
      'Signed content does not match the signature digest',
    );
    requireValue(
      text(signature.intent, `${path}.intent`) === signature.content.intent &&
        signature.meaning === signature.content.meaning,
      'signature_intent',
      path,
      'The intent statement is not part of the signed content',
    );
    requireValue(
      signature.content.subject?.id === signature.subjectId &&
        signature.content.subject?.revision === signature.subjectRevision &&
        signature.content.signer?.id === signature.signerId,
      'signature_subject',
      path,
      'Signed content names a different record or signer',
    );
    requireValue(
      isObject(signature.authority) && signature.authority.principalId === signature.signerId,
      'signature_authority',
      path,
      'The signer’s authority snapshot is missing',
    );
    requireValue(
      isObject(signature.reauthentication) && typeof signature.reauthentication.method === 'string',
      'signature_reauthentication',
      path,
      'Re-authentication evidence is missing',
    );
    const decision = decisions.get(signature.decisionId);
    requireValue(
      decision?.signature?.id === id && decision.subjectId === signature.subjectId,
      'signature_binding',
      path,
      'Signature is not bound to an exported decision',
    );
    list(signature.content.bindings, `${path}.content.bindings`).forEach((binding, index) => {
      const where = `${path}.content.bindings[${index}]`;
      if (binding.kind === 'record_version') {
        const version = versions.get(`${binding.recordId}\u0000${binding.versionNumber}`);
        requireValue(
          version && version.bodyDigest === binding.bodyDigest,
          'signature_binding',
          where,
          'Signed record version is not in the export or has a different digest',
        );
      } else if (binding.kind === 'attachment') {
        requireValue(
          attachments.get(binding.attachmentId)?.sha256 === binding.sha256,
          'signature_binding',
          where,
          'Signed attachment is not in the export or has a different digest',
        );
      } else if (binding.kind === 'decision') {
        const cited = decisions.get(binding.decisionId);
        requireValue(
          cited && canonicalDigest(cited.outcome) === binding.outcomeDigest,
          'signature_binding',
          where,
          'Signed decision is not in the export or has a different outcome',
        );
      } else throw new BundleVerificationError('signature_binding', where, 'Unknown signature binding');
    });
  }
  return { decisions, signatures };
}

function verifyAcknowledgements(bundle, decisions) {
  bundle.records.forEach((record, index) => {
    if (record.documentAcknowledgements === undefined) return;
    list(record.documentAcknowledgements, `$.records[${index}].documentAcknowledgements`).forEach((receipt, at) => {
      const path = `$.records[${index}].documentAcknowledgements[${at}]`;
      const issue = decisions.get(receipt.issueId);
      requireValue(
        receipt.recordId === record.id &&
          issue?.kind === 'document.issue' &&
          issue.subjectId === record.id &&
          issue.outcome?.contentDigest === digest(receipt.contentDigest, `${path}.contentDigest`),
        'acknowledgement_binding',
        path,
        'Acknowledgement names no exported issue of this document or a different issued content',
      );
      text(receipt.statement, `${path}.statement`);
    });
  });
}

/** Verifies an SMS export offline. Record bodies are opaque; signatures and withholding are checked here. */
export function verifySmsExport(bundle, options = {}) {
  const manifest = verifyManifest(bundle, options.expectedManifestDigest);
  const { versions, attachments, withheld } = verifyRecords(bundle);
  const { decisions, signatures } = verifySignatures(bundle, versions, attachments);
  verifyAcknowledgements(bundle, decisions);
  return {
    status: 'verified',
    format: SMS_EXPORT_FORMAT,
    exportId: manifest.exportId,
    tenantId: manifest.tenantId,
    scope: manifest.scope,
    counts: {
      records: bundle.records.length,
      decisions: decisions.size,
      signatures: signatures.size,
      attachments: [...attachments.values()].filter((item) => item.confidentiality === 'ordinary').length,
      withheld: withheld.size,
    },
    withheld: [...withheld.values()].map(({ kind, id, recordId, confidentiality, sha256: digest }) => ({
      kind,
      id,
      recordId,
      confidentiality,
      sha256: digest,
    })),
  };
}
