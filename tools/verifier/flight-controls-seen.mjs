import { canonicalDigest, requireValue } from './integrity.mjs';

export const PINNED_CONTROLS_LIMITATION =
  'A briefing that pins the controls in scope, and every departure authorization, is checked for that list: its shape, that its digest reproduces from what it holds, and that it equals the digest the command named (a departure command may name none only for an empty list). This format cannot show that the list was complete, that each control was in force or each result current when it was recorded, or that a listed evaluation is in this inventory. A briefing whose command named no digest pins no list.';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The controls section a briefing or departure event pins, or undefined when it pins none. */
function pinnedSection(envelope) {
  const acceptance = envelope.payload?.acceptance;
  if (envelope.type === 'mission.brief')
    return acceptance?.controls !== undefined ? { section: acceptance.controls, mayOmitDigest: false } : undefined;
  if (envelope.type === 'mission.departure-authorize')
    return { section: acceptance?.issuanceBasis?.controls, mayOmitDigest: true };
  return undefined;
}

/** Checks the controls list a briefing or departure pins against the command it answers; true when it pins one. */
export function verifyPinnedControls(record) {
  const { envelope, path } = record;
  const check = (condition, message) => requireValue(condition, 'pinned_controls_commitment', path, message);
  const pinned = pinnedSection(envelope);
  const named = envelope.payload?.expectedControlsDigest;
  if (!pinned) {
    check(named === undefined, 'The command names a controls digest its record does not pin');
    return false;
  }
  const { section, mayOmitDigest } = pinned;
  check(
    object(section) &&
      Object.keys(section).sort().join() === 'complete,controls,digest,mission,notApplicable,version' &&
      section.version === 'flight.controls-seen.1' &&
      Array.isArray(section.controls) &&
      Array.isArray(section.notApplicable) &&
      typeof section.complete === 'boolean' &&
      (section.mission === null || object(section.mission)),
    'The pinned controls section is malformed',
  );
  check(
    section.digest ===
      canonicalDigest({
        version: section.version,
        controls: section.controls,
        notApplicable: section.notApplicable,
        complete: section.complete,
        mission: section.mission,
      }),
    'The pinned controls digest does not reproduce',
  );
  // A departure command names no digest when no control was in scope; its record pins the empty list.
  check(
    named === section.digest ||
      (named === undefined && mayOmitDigest && section.controls.length === 0 && section.notApplicable.length === 0),
    'The pinned controls differ from the digest the command named',
  );
  return true;
}
