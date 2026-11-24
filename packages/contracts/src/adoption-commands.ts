import type {
  AdoptionMode,
  OrganizationCoverageResponse,
  PackAdoptionCommand,
  PackAdoptionRecord,
} from './adoptions.js';
import type { AdoptionParameterValues } from './checked-rules.js';
import type { RulePackVersion } from './rule-packs.js';

/**
 * The adoption commands a person sends: a new adoption, a revision of one and a successor of one, each pinned to the
 * coverage the person was shown. The Rules screen and the command-line client build them here alike.
 */

type Interval = PackAdoptionCommand['effectiveInterval'];

function displayedCut(shown: OrganizationCoverageResponse): PackAdoptionCommand['inputCut'] {
  return {
    ...shown.meta.inputCut,
    basisRevision: shown.organization.revision,
    principalRevision: shown.meta.inputCut.principalRevision!,
  };
}

function packReference(pack: RulePackVersion): PackAdoptionCommand['pack'] {
  const reference = ({ id, version, digest }: { id: string; version: number; digest: string }) => ({
    id,
    version,
    digest,
  });
  return {
    packId: pack.packId,
    version: pack.version,
    digest: pack.digest,
    leaves: pack.leaves.map(reference),
    bindings: pack.bindings.map(reference),
  };
}

/** A new adoption of the exact pack shown, pinned to the coverage the person saw. */
export function adoptionCommand(
  shown: OrganizationCoverageResponse,
  pack: RulePackVersion,
  choice: { mode: AdoptionMode; effectiveInterval: Interval; note: string; parameters?: AdoptionParameterValues },
): PackAdoptionCommand {
  return {
    kind: 'rule-pack.adopt',
    expectedRevision: shown.organization.revision,
    inputCut: displayedCut(shown),
    expectedDependencyBasis: shown.meta.dependencyBasis!,
    pack: packReference(pack),
    effectiveInterval: { ...choice.effectiveInterval },
    note: choice.note,
    ...(choice.parameters ? { parameters: structuredClone(choice.parameters) } : {}),
    mode: choice.mode,
  };
}

/**
 * A revision of an adoption: the same exact pack with the mode, dates and values given, each kept as adopted when not
 * given. The revision replaces the adoption whole.
 */
export function revisionCommand(
  shown: OrganizationCoverageResponse,
  adoption: PackAdoptionRecord,
  choice: { note: string; mode?: AdoptionMode; effectiveInterval?: Interval; parameters?: AdoptionParameterValues },
): PackAdoptionCommand {
  const parameters = choice.parameters ?? adoption.parameters;
  return {
    ...adoptionCommand(shown, adoption.pack, {
      mode: choice.mode ?? adoption.mode,
      effectiveInterval: choice.effectiveInterval ?? adoption.effectiveInterval,
      note: choice.note,
      ...(parameters ? { parameters } : {}),
    }),
    revises: adoption.id,
  };
}

/**
 * A successor adoption of a newer version of the adoption's pack, from `start` to `end` (the end of the adoption it
 * succeeds unless given), pinned to the coverage the person saw. The earlier adoption ends where this one starts.
 */
export function successorCommand(
  shown: OrganizationCoverageResponse,
  adoption: PackAdoptionRecord,
  pack: RulePackVersion,
  choice: { mode: AdoptionMode; start: string; end?: string; note: string; parameters?: AdoptionParameterValues },
): PackAdoptionCommand {
  return {
    ...adoptionCommand(shown, pack, {
      mode: choice.mode,
      effectiveInterval: { start: choice.start, end: choice.end ?? adoption.effectiveInterval.end },
      note: choice.note,
      ...(choice.parameters ? { parameters: choice.parameters } : {}),
    }),
    succeeds: adoption.id,
  };
}

/** True when nothing later replaces the adoption: no revision of it, and no later version succeeds it. */
export function adoptionStands(adoption: PackAdoptionRecord): boolean {
  return !adoption.revisedBy && !adoption.succeededBy && adoption.state !== 'revised' && adoption.state !== 'succeeded';
}

/**
 * The standing adoptions of a pack whose dates meet the interval, earliest first: the ones a new adoption of the pack
 * over that interval would overlap.
 */
export function overlappingAdoptions(
  adoptions: readonly PackAdoptionRecord[],
  packId: string,
  interval: Interval,
): PackAdoptionRecord[] {
  const start = Date.parse(interval.start);
  const end = Date.parse(interval.end);
  return adoptions
    .filter(
      (adoption) =>
        adoption.pack.packId === packId &&
        adoptionStands(adoption) &&
        Date.parse(adoption.effectiveInterval.start) < end &&
        Date.parse(adoption.effectiveInterval.end) > start,
    )
    .sort((left, right) => Date.parse(left.effectiveInterval.start) - Date.parse(right.effectiveInterval.start));
}
