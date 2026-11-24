# Contributing

Thank you for looking at Ledger. Rule packs and adapters are where outside help is most useful.

## Licence of contributions

Ledger is licensed under the Apache License, Version 2.0. A contribution you submit is licensed under the same terms, as section 5 of the licence says. You keep your copyright. There is nothing to sign.

Submit only work you have the right to contribute. If part of it is not your own, say so in the pull request and name its source and licence.

## Before you start

- Open an issue for anything larger than a small fix, so the approach can be agreed first.
- Report security problems privately. See [SECURITY.md](SECURITY.md).
- Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Working on the code

Before taking an issue, read [AGENTS.md](AGENTS.md): the working rules for people and agents, and the definition of done.

Set up the local stack as described in the [README](README.md#quickstart), including `pnpm vendor:airspace`: the Airspace Link emulator, the simulated scenarios and the unit tests of `pnpm verify` read the schemas it downloads. Then:

```sh
pnpm verify             # format check, build, typecheck, unit tests
pnpm test:integration   # PostgreSQL tests against a separate ledger_test database
pnpm test:browser       # with the seeded pnpm dev stack running
```

- Prettier formats everything: `pnpm format`.
- Keep the invariants listed in the README true in every change.
- Applied migrations are never edited. Add a new one.
- After a contract change, run `pnpm generate:client` and commit the result.
- A test earns its place by protecting an invariant or a user path: isolation, idempotency, basis conflicts, report confidentiality, signature binding.

## Data and names

- Use only fictional data. The seeded tenants exist for this.
- Never add real operational data, real safety reports, real people, or the names of real operators, customers or partners to code, fixtures, tests, screenshots or issues.
- Do not copy an organization's manuals, checklists, hazard libraries or other proprietary material. Regulatory text published by a government may be quoted with its source.
- Products that Ledger connects to may be named.

## Rules and regulatory text

- A rule quotes its source exactly and pins it by byte span and digest. Do not paraphrase source text into a rule.
- Proposed rules are labelled as proposed and are never presented as current law.
- Ledger does not state compliance verdicts. A check reports what the evidence supports; a person decides.
- Rule checks are deterministic code. Do not add a check whose result comes from a language model.

## Commits and pull requests

- Small, runnable commits. The message says what changed in plain words.
- Describe what you ran and anything you could not check.
