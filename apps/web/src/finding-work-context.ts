import { createContext } from 'react';
import type { Principal, SubjectFindingRecord } from '@ledger/contracts';

/**
 * What a finding's actions need from the shell, wherever a finding about a subject is shown: who is signed in, and a
 * way into the safety section to open a hazard from the finding, for someone who may write safety records.
 */
export interface FindingWorkLinks {
  principal: Principal | null;
  openHazard?: (finding: SubjectFindingRecord, subjectLabel: string) => void;
}

export const FindingWorkContext = createContext<FindingWorkLinks>({ principal: null });
