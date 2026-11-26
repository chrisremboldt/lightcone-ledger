import type { ReactNode } from 'react';
import type { LedgerClient } from '@ledger/contracts/client';
import type { Principal } from '@ledger/contracts';
import { Notice } from '@ledger/ui';
import { FirstDay } from './FirstDay.js';
import { NoticesArea } from './NoticesArea.js';
import { PeopleArea } from './PeopleArea.js';
import { RecordsArea } from './RecordsArea.js';
import { RulesArea } from './RulesArea.js';
import { PlaceLink } from './TopBar.js';
import { barSection, sections, type BarSection, type Place } from './place.js';

/** Whether a place is one every shell shows the same way: Setup, Records, Rules, People, or no place. */
export function sharedSection(place: Place): boolean {
  return ['setup', 'records', 'rules', 'people', 'unknown'].includes(place.section);
}

/**
 * The first-day list, Records, Rules and People, which both the flights and the safety shell show under the same bar; an address that
 * names no place; and a section the person may not open.
 */
export function SectionArea({
  place,
  client,
  principal,
  offered,
  onOpenDocument,
}: {
  place: Place;
  client: LedgerClient;
  principal: Principal | null;
  offered: BarSection[];
  /** Opens a controlled document under Safety, when the person may read safety records. */
  onOpenDocument?: (id: string) => void;
}) {
  if (place.section === 'unknown')
    return (
      <PlaceNotice title="Nothing here">
        Ledger has no screen at this address. The link may be mistyped or cut short.
      </PlaceNotice>
    );
  if (place.section === 'setup') return <FirstDay />;
  const section = barSection(place);
  if (principal && section && !offered.includes(section)) return <SectionUnavailable section={section} />;
  if (place.section === 'records')
    return <RecordsArea client={client} principal={principal} place={place} onOpenDocument={onOpenDocument} />;
  if (place.section === 'rules') return <RulesArea client={client} principal={principal} place={place} />;
  if (place.section === 'people')
    return 'pane' in place ? (
      <NoticesArea client={client} pane={place.pane} />
    ) : (
      <PeopleArea client={client} principal={principal} personId={place.personId} />
    );
  return null;
}

/** A section the signed-in person may not open, as when a link was made by someone with another role. */
export function SectionUnavailable({ section }: { section: BarSection }) {
  const label = sections.find(([value]) => value === section)![1];
  return (
    <PlaceNotice title={`${label} is not available to you`}>
      Your role in this organization does not include {label}. Ask the person who manages authority in your
      organization.
    </PlaceNotice>
  );
}

/** A plain notice in place of a screen, with a way back to the first screen the person can open. */
export function PlaceNotice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="records-area records-home" aria-label={title}>
      <section className="thread-workspace" aria-label={title}>
        <div className="thread-main">
          <Notice tone="neutral" title={title}>
            {children}
          </Notice>
          <PlaceLink className="button button--secondary" place={{ section: 'start' }}>
            Open your first screen
          </PlaceLink>
        </div>
      </section>
    </main>
  );
}
