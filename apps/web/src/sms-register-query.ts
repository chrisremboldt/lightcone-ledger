import { useState } from 'react';
import type { SmsRecordKind, SmsRegisterOrder } from '@ledger/contracts';
import { goTo, usePlace, type RegisterChoices } from './place.js';

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

/**
 * A register's query: its plain choices (state, type, order) kept in the address, so a link and back and forward keep
 * them; its search text and days kept on the page only.
 */
export function useRegisterQuery(): [RegisterQuery, (query: RegisterQuery) => void] {
  const { place } = usePlace();
  const [typed, setTyped] = useState({ search: '', openedFrom: '', openedUntil: '' });
  const choices: RegisterChoices = (place.section === 'safety' && 'choices' in place && place.choices) || {};
  const query: RegisterQuery = {
    ...unnarrowed,
    ...typed,
    status: choices.state ?? '',
    assuranceType: choices.type ?? '',
    order: (choices.order as SmsRegisterOrder | undefined) ?? unnarrowed.order,
  };
  const setQuery = (next: RegisterQuery) => {
    setTyped({ search: next.search, openedFrom: next.openedFrom, openedUntil: next.openedUntil });
    const chosen: RegisterChoices = {
      ...(next.status ? { state: next.status } : {}),
      ...(next.assuranceType ? { type: next.assuranceType } : {}),
      ...(next.order !== unnarrowed.order ? { order: next.order } : {}),
    };
    if (place.section !== 'safety' || place.view === 'record' || place.view === 'finding') return;
    const same = chosen.state === choices.state && chosen.type === choices.type && chosen.order === choices.order;
    // A narrowing refines the register on screen: it replaces the address rather than adding a step to go back through.
    if (!same)
      goTo(
        { section: 'safety', view: place.view, ...(Object.keys(chosen).length ? { choices: chosen } : {}) },
        { replace: true },
      );
  };
  return [query, setQuery];
}
