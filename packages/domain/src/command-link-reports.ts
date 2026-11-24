/**
 * Command-link reports that arrive as link.status observations, read from the observations themselves: a transition
 * of the command and control link about a flight, kept only when its capture session's earliest current transition
 * names the same flight and aircraft, as the lost-link review keeps it.
 */

const transition = (alias: string) => `${alias}.observation_type='link.status' AND ${alias}.source_event_id IS NOT NULL
  AND ${alias}.source_session_id IS NOT NULL AND ${alias}.observation->'values'->>'link'='command_control'
  AND ${alias}.observation->'values'->>'report'='transition'`;

const current = (alias: string) => `NOT EXISTS(SELECT 1 FROM observation_withdrawals w
    WHERE w.tenant_id=${alias}.tenant_id AND w.observation_id=${alias}.id)
  AND NOT EXISTS(SELECT 1 FROM observations r WHERE r.tenant_id=${alias}.tenant_id AND r.replaces_observation_id=${alias}.id)`;

/** The flight and aircraft the earliest current transition of the observation's capture session names. */
const sessionBinding = `(SELECT ARRAY[f.subject_kind,f.subject_id,COALESCE(f.secondary_subject_id,'')] FROM observations f
  WHERE f.tenant_id=o.tenant_id AND f.source_id=o.source_id AND COALESCE(f.source_session_id,'')=o.source_session_id
    AND ${transition('f')} AND ${current('f')}
  ORDER BY f.occurred_at,f.subject_kind COLLATE "C",f.subject_id COLLATE "C",f.secondary_subject_id COLLATE "C",f.id
  LIMIT 1)`;

/** True for the observation `o` when it is a command-link report its capture session is bound to. */
export const commandLinkObservationReport = `${transition('o')} AND o.subject_kind='flight'
  AND o.secondary_subject_kind='aircraft'
  AND ${sessionBinding}=ARRAY[o.subject_kind,o.subject_id,COALESCE(o.secondary_subject_id,'')]`;
