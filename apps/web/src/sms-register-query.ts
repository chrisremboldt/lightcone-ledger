import type { SmsRecordKind, SmsRegisterOrder } from '@ledger/contracts';

/** What a person narrowed a safety register to. An empty value narrows nothing. */
export interface RegisterQuery {
  search: string;
  status: string;
  assuranceType: string;
  openedFrom: string;
  openedUntil: string;
  order: SmsRegisterOrder;
}

export const unnarrowed: RegisterQuery = {
  search: '',
  status: '',
  assuranceType: '',
  openedFrom: '',
  openedUntil: '',
  order: 'newest',
};

/** The query parameters a register read sends: only what narrows or orders it, so the plain read stays as it was. */
export function registerParams(query: RegisterQuery): Record<string, string> {
  return Object.fromEntries(
    [
      ['search', query.search.trim()],
      ['status', query.status],
      ['assuranceType', query.assuranceType],
      ['openedFrom', query.openedFrom],
      ['openedUntil', query.openedUntil],
      ['order', query.order === 'newest' ? '' : query.order],
    ].filter(([, value]) => value),
  );
}

export const narrowed = (query: RegisterQuery) => Object.keys(registerParams(query)).length > 0;

export function registerPath(kind: SmsRecordKind, query: RegisterQuery, cursor?: string): string {
  return `/v1/sms/records?${new URLSearchParams({
    kind,
    ...registerParams(query),
    ...(cursor ? { cursor } : {}),
  })}`;
}

export const orderLabels: Record<SmsRegisterOrder, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  due: 'Soonest due first',
};

/** The register's count: how many are shown, with + while more can be read, and whether they match a narrowing. */
export function registerCount(shown: number, more: boolean, query: RegisterQuery): string {
  return `${shown}${more ? '+' : ''} ${narrowed(query) ? (shown === 1 && !more ? 'matches' : 'match') : 'recorded'}`;
}
