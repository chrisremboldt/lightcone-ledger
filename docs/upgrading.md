# Upgrading Ledger

What a new release of Ledger may change, and what you do when you move a deployment to it. Each release's own steps are in its **Upgrading** part of [CHANGELOG.md](../CHANGELOG.md); read it before you start.

## While Ledger is pre-release

Ledger is pre-release (version 0.x). A release may change anything: record shapes, the API, the pack file format, the adapter contract, pinned digests, settings, and migrations already published. There is no converter from one shape to the next. When a release cannot run on a database made by the release before, its upgrade note says so in its first line: **Recreate the database**. You then make a new database, run the migrations and create your organization again; keep the old database until the new one holds what you need.

Everything below "Once Ledger leaves pre-release" is the rule a 1.0 release will start to keep. Until then it is the direction, not a promise.

## Once Ledger leaves pre-release

Versions are numbered major.minor.patch. Within one major version a release keeps these stable:

- **Record shapes on file.** Every journal event, receipt, observation, decision, signature and export a release wrote reads the same under a later release of the same major version. A new field may be added; none is removed, renamed or given another meaning.
- **Pinned digests.** A shipped pack's and a check kind's digest does not move. A changed rule is a new pack version beside the old one, and adoptions that named the old one keep reading it.
- **The API's existing fields.** A route, a field of a request or an answer, an error code and a capability stay as they are. New routes and new optional fields may be added; a client must ignore fields it does not know.
- **The pack file format.** A pack file built for the major version loads in every later release of it.
- **The adapter contract.** An adapter's descriptor, its observation envelope and the observation types it produces keep their meaning; a changed observation type is a new version beside the old one.

A minor release may add to any of these. A patch release fixes what was wrong and adds nothing a client must know about.

### How something is retired

Nothing on that list is removed without warning. A release announces what will go, in its notes under **Upgrading**, and says what replaces it; the thing goes no earlier than the next major version, and at least one release after the announcement. An API field or route that will go keeps working, and answers as before, until then.

### Migrations

- Migrations only go forward. A published migration is never edited; a change is a new migration. There are no down migrations: going back is a restore of the backup taken before the upgrade.
- Run the new release's migrations before you start the new release: `pnpm db:migrate`, or `node packages/persistence/dist/migrate.js` from the image ([Deploy Ledger, section 5](guides/deploy.md#5-run-the-migrations)). They run in one transaction; a failure leaves the database as it was.
- A migration may need the old release stopped first. The upgrade note says when.

## Steps for an upgrade

1. Read the release's upgrade note, and every note between your release and it.
2. Take a backup: the database and the original files together ([Deploy Ledger, section 9](guides/deploy.md#9-backups-and-restoring)).
3. Stop the API and the workers (or the one process).
4. Run the new release's migrations.
5. Start the new release: the API first, then the workers.

## After an upgrade

- `GET /readyz` answers `{"status":"ready","role":"ledger_app"}`.
- `pnpm ledger me` names your organization, and a person can sign in through your identity provider.
- The workers are working: their log shows work completed, or with metrics on, `ledger_worker_passes_total{outcome="completed"}` rises and `ledger_evaluation_lag_seconds` comes back down ([Deploy Ledger, Metrics](guides/deploy.md#metrics)).
- Your own pack files are still offered (`pnpm pack:list`), and the adoptions you made still show their pack versions.
- Each adapter process signs in again and logs `first_submitted`.
- A record export you made before the upgrade still verifies.
