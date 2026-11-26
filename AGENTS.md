# Working rules for agents

## Which of these are you doing?

- **Setting Ledger up for an organization**: an operator asked you to install Ledger, enter or import its records, describe its waiver or procedures, or read where its records stand. Follow [Set up Ledger with a coding agent](docs/guides/set-up-with-a-coding-agent.md) and nothing below, except [An agent that speaks MCP](#an-agent-that-speaks-mcp) when you call Ledger through the Model Context Protocol. It says where the organization's own files go (outside this checkout, or in the git-ignored `organization/` folder), what you may do yourself, and what only a person does. Never commit the organization's files to this repository.
- **Working on Ledger itself**: you are changing this repository's code, documents or tests, usually to take an issue. Read the rest of this file.

## An agent that speaks MCP

`pnpm ledger mcp` starts a Model Context Protocol server on standard input and output. It is the command-line client: the same credential (`LEDGER_TOKEN` and `LEDGER_API_URL`, or `.ledger/credentials`), the same commands and the same rules, offered as tools with described inputs and structured results. Ledger itself calls no language model; the agent is the operator's own. A client configuration, with the path of the checkout filled in:

```json
{
  "mcpServers": {
    "ledger": {
      "command": "pnpm",
      "args": ["--dir", "<path of the Ledger checkout>", "ledger", "mcp"]
    }
  }
}
```

A relative file path given to a tool is read from the folder the agent started the server in.

- **Reading**, marked read-only: `who_am_i`, `record_types`, `record_columns`, `record_template`, `start_mapping`, `list_records`, `subject_file` (what is on file about one subject), `list_packs`, `adopted_packs`, `show_pack`, `coverage`, `list_findings`, `show_finding` (one finding, the evaluations behind it, the records they read and what is not on file), `list_people`, `role_presets` and `draft_recordkeeping_plan`.
- **Checking and importing**, not read-only: `check_records` (Ledger keeps the files as uploads and records nothing a rule reads), `import_records` (records rows under the client's credential, as `records import` does) and `read_flight_log` (writes a CSV beside the log and sends nothing).
- **A person's decision**: `prepare_adoption`, `prepare_findings_decision`, `prepare_person_addition`, `prepare_person_change` and `prepare_safety_decision` print what the client prints without `--reason` and send nothing. The result's `personRuns` is the command the person runs with their own credential and reason. No tool takes a credential or a reason; the server refuses any argument a tool does not describe.

# Work on Ledger itself

This part applies to people and to automated agents changing this repository. Each of you takes one issue from this repository's issue list. [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md) still apply; this file adds what you need to work on an issue alongside others.

## Before you start

- Read the issue in full, then the files it lists under "Read first".
- Keep the change to what the issue asks for. If you find something that belongs to another issue, say so in your report instead of doing it.
- Do not change behaviour the issue did not ask you to change.

## The rule every issue serves

Every issue ends with this rule:

> A new problem type must be addable by touching only adapters, rule packs, control types and indicator definitions.

Core code must not name a specific rule, report type or vendor. If an issue cannot be done without breaking this rule, stop. Say so in the issue, explain why, and do not work around it.

## Two doctrines

- **People attest; Ledger records.** Ledger never issues a compliance verdict. Do not use words such as "compliant", "authorized", "go" or "no-go" for a result. A check reports what the evidence supports; a named person with the authority decides.
- **Deterministic, not generative.** Rule checks are ordinary code over retained records. The same inputs give the same result. Nothing calls a language model, and no finding, evaluation result or decision comes from one.

## Invariants every change keeps

These are listed in full in the README. In short:

- **Tenant isolation.** Tenant and principal come from authentication, never the request body. The API and workers run as non-owner roles under row-level security.
- **Append-only history.** Inputs, receipts, journal events, decisions and signatures are never changed.
- **Durable, idempotent intake.** A receipt means the bytes are stored and work is queued. The same idempotency key with different content conflicts.
- **Decisions pin their basis.** If the basis changed between display and commit, the command conflicts.
- **One front door.** Everything writes through the public API. Nothing writes Ledger tables directly.
- **Workers are fenced.** A worker that lost its lease cannot commit effects.
- **Protected reporting.** A safety report's title, narrative and reporter are stored apart and are readable only with a specific capability. Restricted attachments are never exported, and each read of one is retained.

## Data

This is a rule about what is committed to this repository, which is public. It does not apply to an organization's own records kept outside it.

- Everything committed is fictional. The seeded tenants and the worked examples exist for this.
- No real organization, operator, customer, partner or person names in anything committed: code, fixtures, tests, comments, commit messages, issues or screenshots.
- Products that Ledger connects to may be named.

## Running the stack and the checks

Set up the stack as described in the [README quickstart](README.md#from-a-source-checkout). The checks:

```sh
pnpm verify             # format check, build, typecheck, unit tests
pnpm test:integration   # PostgreSQL tests against a separate test database (default ledger_test)
pnpm test:browser       # Playwright, against the seeded pnpm dev stack
pnpm format             # apply Prettier formatting
```

- A registry (check kinds, exposure kinds, observation types, packs) can be loaded from source and from a build in one test process, and keeps whichever copy registered first. In a test, compare a registered entry by its digest, never by object identity (`toBe`).
- `pnpm test:integration` creates its test database if it is missing, then migrates and seeds it.
- `pnpm test:browser` needs `pnpm dev` running against a migrated and seeded database. It uses `WEB_URL` if set, otherwise `http://127.0.0.1:5173`.
- Some browser specs need a stack of their own and skip, with a reason, on the seeded one; each says how to set it up in its header. `openid-connect.spec.ts`, `first-day-safety.spec.ts` and `assurance-records.spec.ts` need the test issuer (`pnpm test-issuer`) and a database none of the others used. The parts of `first-run.spec.ts` and `open-findings.spec.ts` about a new organization need a database made with `pnpm org:create` instead of the seed; their other parts need the seed.
- One integration test, of the adapter process, skips when the local broker is not reachable.
- `pnpm scenario` runs the simulated day: ten flights through the order and Airspace Link emulators, then 19 self-checks, including tenant isolation. It fails when a self-check fails, and writes its report to `.local/scenarios/m0-m1`.
- It needs `pnpm dev` running against a migrated and seeded database. It can run again on the same database: each run puts a fresh run id into its keys. Set `SIMULATOR_RUN_ID` to fix the id for a reproducible recording; a fixed id can be used only once per database.

## Working in parallel

Several agents may work on one machine at the same time. To avoid colliding:

- Work in your own git worktree on your own branch. Do not edit another worktree or the main checkout.
- Give integration tests their own database: `LEDGER_TEST_DATABASE=<unique name> pnpm test:integration`. The name replaces the database in the `DATABASE_URL`, `DATABASE_ADMIN_URL` and `WORKER_DATABASE_URL` from `.env`.
- Run only one browser-test run or demo recording at a time on a machine.
- The stack runs on fixed ports unless you change them: the web app on 5173, the API on 4000, the emulators on 4002 and 4003, and the services of `infra/compose.yaml` on 54329 (PostgreSQL), 9090 (object storage), 1883 and 1884 (broker). A second stack on the same computer needs ports of its own; see "Running a second stack" below.

## Running a second stack

When another stack holds the ports, `pnpm dev` stops with `EADDRINUSE`, but `curl http://127.0.0.1:4000/readyz` may still answer "ready": from the other stack's API, which may even be connected to your database. Never take a `/readyz` answer as yours. Confirm with `pnpm ledger me` that the organization it names is the one you created; `/readyz` says only that some API is up.

To run your own stack beside another, change only settings:

1. Start the services under a project name of your own, with the override that moves their ports (54429, 9190, 1983 and 1984; edit it if those are taken too):

   ```sh
   docker compose -p ledger-second -f infra/compose.yaml -f infra/compose.other-ports.yaml up -d --wait
   ```

   The project name keeps your containers and volumes apart from the other stack's. Give the same `-p` and both `-f` to every later `docker compose` command for this stack.
2. In your checkout's `.env`, set:

   | Variable | Example | What it moves |
   | --- | --- | --- |
   | `PORT` | `4100` | The API. The web app of `pnpm dev` forwards `/v1` to it. |
   | `LEDGER_WEB_PORT` | `5273` | The web app of `pnpm dev`. A port already taken stops it rather than moving it. |
   | `CORS_ORIGINS` | `http://localhost:5273,http://127.0.0.1:5273` | The web app's origins the API accepts sign-in from. |
   | `DATABASE_ADMIN_URL`, `DATABASE_URL`, `WORKER_DATABASE_URL` | `…@127.0.0.1:54429/ledger` | The database, on the override's port. |
   | `S3_ENDPOINT` | `http://127.0.0.1:9190` | Object storage, on the override's port. |
   | `EMULATOR_PORT`, `EMULATOR_BASE_URL` | `4102`, `http://127.0.0.1:4102` | The emulators `pnpm dev` starts. |
   | `SIMULATOR_CALLBACK_PORT` | `4103` | The simulator's callback listener. |
   | `EMULATOR_CALLBACK_ORIGINS` | `http://127.0.0.1:4100,http://localhost:4100,http://127.0.0.1:4103` | What the emulators may call back. |
   | `AIRSPACE_REDIRECT_URIS` | `http://127.0.0.1:4102/oauth/callback` | The Airspace Link emulator's sign-in redirect. |
   | `LEDGER_API_URL` | `http://127.0.0.1:4100` | Where `pnpm ledger` and the simulator reach the API; also in `.ledger/credentials`. |
   | `WEB_URL` | `http://127.0.0.1:5273` | The web app the browser tests open. |

3. Run `pnpm db:migrate` (and `pnpm db:seed` for the fictional organizations), then `pnpm dev`. Wait for `curl -sf http://127.0.0.1:4100/readyz`, then run `pnpm ledger me` and check the organization it names.

A variable set in the shell takes precedence over `.env`, so `PORT=4100 pnpm dev` works too; writing them in `.env` keeps every command of the stack on the same ports.
- Have only one issue labelled `adds-migration` in progress at a time, so migrations are numbered in one sequence.

## Migrations

- Applied migrations are never edited. Add a new file in `packages/persistence/migrations`.
- Only an issue labelled `adds-migration` adds one. If you find your issue needs a migration and it is not labelled, stop and say so.

## Contracts

After a change to `packages/contracts`, run `pnpm generate:client` and commit the regenerated `docs/openapi.json` and typed client in the same change.

## Demo scenes

Scenes live in `apps/web/src/autopilot/scenes.ts`. The hosted demonstration replays recordings in `apps/web/src/autopilot/tapes`.

- When a screen used by a scene changes, re-record in the same change with `pnpm demo:record`. Follow the notes at the top of `tools/record-demo-tape.mjs`: record against a freshly seeded local stack with `pnpm dev` running. `pnpm demo:record hazard` records only the named scene.
- Keep `tests/browser/autopilot.spec.ts` passing.
- In the web app, a build-time switch that decides whether demo or recording code is included must be written inline at the point of use, as `import.meta.env.DEV || import.meta.env.VITE_LEDGER_ENV === 'demo'` (see `apps/web/src/transport.ts` and `apps/web/src/main.tsx`). The bundler drops that code from an ordinary production build only when it sees the condition directly. An imported constant such as `demonstration` is fine for a label, not for such a guard.

## Definition of done

An issue is done when all of these are true:

- `pnpm verify` passes.
- The integration tests pass if you changed behaviour in `packages/domain`, `packages/persistence`, `apps/api` or `apps/workers`.
- The browser tests for any screen you changed pass, including `tests/browser/autopilot.spec.ts` if a scene's screens changed.
- No behaviour changed that the issue did not ask for.
- Every acceptance item in the issue is met, or your report says which is not and why.
- Your report says which checks ran, with their results, and what was not checked.

## Commits and reports

- Small commits. The message says what changed in plain words.
- In your report, say exactly which checks you ran and their results, what you did not check, and every judgment call you made.
