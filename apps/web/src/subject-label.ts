/**
 * A subject as people read it: the name its records give it beside the organization's own id, or the id alone when no
 * record names it. A flight Ledger created has a UUID for an id, shown shortened beside its name.
 */
const ledgerMadeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function subjectLabel(subject: { id: string; name?: string | null }): string {
  const name = subject.name?.trim();
  if (!name || name === subject.id) return subject.id;
  // An id Ledger made, a UUID, tells a reader nothing: its first eight characters are enough to tell two apart.
  return `${name} (${ledgerMadeId.test(subject.id) ? subject.id.slice(0, 8) : subject.id})`;
}
