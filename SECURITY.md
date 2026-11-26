# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue.

Use either of these:

- GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**.
- Email to team@lightconesystems.com with "Security" in the subject.

Include what you found, how to reproduce it, the commit you tested and what you think the impact is. Never include real operational data, real safety reports or real credentials in a report; reproduce with the seeded fictional tenants.

We will acknowledge a report, tell you whether we can reproduce it, and credit you in the fix unless you ask us not to.

## Supported versions

Ledger is pre-release. Only the current `main` branch receives security fixes. A release that fixes one says so in its upgrade note in [CHANGELOG.md](CHANGELOG.md); [docs/upgrading.md](docs/upgrading.md) says what a release may change.

## What matters most

These properties are the ones Ledger exists to keep. A way to break any of them is a vulnerability:

- **Tenant isolation.** One tenant reading or changing another tenant's records.
- **Protected reporting.** Recovering a safety reporter's identity, or reading report content without the capability for it.
- **Record integrity.** Changing or deleting history, or producing an export that verifies but does not match the journal.
- **Signatures and decisions.** A signature or decision bound to content or authority other than what the person saw and held.
- **Authority.** Performing an action without the capability it requires.

## Not vulnerabilities

- The values in `.env.example`, the broker passwords `pnpm broker:files:dev` writes and the seed data are fixtures for the local development stack. They are documented and are not secrets.
- The emulators and the simulator are development tools and are not hardened for exposure to a network.
