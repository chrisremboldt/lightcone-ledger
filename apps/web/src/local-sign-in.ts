/**
 * The local sign-in screen's choices. It offers a seeded fictional organization only when the database holds it; with
 * none, the screen leads with the development token.
 */

/**
 * The ids of the seeded organizations the database holds: those whose first person's development token the API
 * accepts. An unseeded database accepts none of them.
 */
export async function heldOrganizations(
  profiles: readonly { key: string }[],
  people: readonly { operator: string; token: string }[],
  accepted: (token: string) => Promise<boolean>,
): Promise<string[]> {
  const found = await Promise.all(
    profiles.map(async (profile) => {
      const person = people.find((item) => item.operator === profile.key);
      return person && (await accepted(person.token)) ? [`tenant-${profile.key}`] : [];
    }),
  );
  return found.flat();
}

/** The seeded organizations to offer: those the database holds, in the order given. Unknown until read: none. */
export function offeredOrganizations<Profile extends { key: string }>(
  profiles: readonly Profile[],
  existing: readonly string[] | null,
): Profile[] {
  if (!existing) return [];
  const held = new Set(existing);
  return profiles.filter((profile) => held.has(`tenant-${profile.key}`));
}

/** A development token as pnpm org:create prints it. */
export function developmentToken(text: string): string | undefined {
  const token = text.trim();
  return /^ledger-dev-\S+$/.test(token) ? token : undefined;
}
