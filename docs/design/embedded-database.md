# An embedded database for one operator

Status: a question looked into, nothing built. The question: could an embedded PostgreSQL start Ledger for one operator with one command and no Docker?

**What was run and what was not.** The inventory below of what Ledger asks of its database was taken from the migrations and the code after PostGIS was removed, and the whole migration set and integration suite were run against plain PostgreSQL 17.12 (the official image). No embedded database was run: installing PGlite into a scratch folder was refused on the computer where this note was written, so every statement below about PGlite or another candidate comes from its documentation and is **unverified** with Ledger. The checks to run are listed at the end; they are the follow-up.

## What Ledger asks of its database

After the PostGIS change, the 85 migrations use no extension. They use, and the code relies on:

- **Roles.** The migrations create `ledger_app` (`NOINHERIT`) and `ledger_worker` (a member of `ledger_app`), both `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, with passwords, and the API and the workers refuse to start unless they are connected as those roles and own no table. 109 `REVOKE`s and the grants shape what each may do.
- **Row-level security** on 41 tables (`ENABLE ROW LEVEL SECURITY`, 42 policies over `current_setting('ledger.tenant_id', true)`), which binds only because the runtime roles are not the tables' owner.
- **PL/pgSQL**: 75 functions, 32 of them `SECURITY DEFINER`; 78 triggers, among them the append-only ones and 10 deferred constraint triggers (`DEFERRABLE INITIALLY DEFERRED`).
- **Partitioning**: `journal_events` is `PARTITION BY HASH` into eight partitions.
- **Locks**: `pg_advisory_xact_lock` and its shared form with `hashtextextended`, 53 `FOR UPDATE` and 28 `FOR SHARE` in the code, one `REPEATABLE READ` transaction, `statement_timeout`. The workers' leases and the lock order (`docs/design/lock-order.md`) assume transactions of the API and the workers run at the same time and wait for each other.
- **Concurrency**: two pools (the API's and the workers'), ten connections each by default, with transactions open on several connections at once.
- Ordinary features besides: `jsonb` with GIN `jsonb_path_ops` indexes and `jsonb_path_exists`, generated columns, `WITH RECURSIVE`, materialized CTEs, `COLLATE "C"`, `gen_random_uuid()`, `clock_timestamp()`, `ON CONFLICT`.
- Not used: `LISTEN`/`NOTIFY` (the live views read their own change tables), any extension.

## The candidates

**PGlite** (`@electric-sql/pglite`, Apache-2.0) is PostgreSQL compiled to WebAssembly, run inside the Node process, keeping its data in a folder. By its documentation it is PostgreSQL 17 in single-user mode with PL/pgSQL, and it serves one connection: `@electric-sql/pglite-socket` puts it behind the PostgreSQL wire protocol so an ordinary client can reach it, one connection at a time. What that means for Ledger, to be checked:

- Roles, grants and row-level security are PostgreSQL's own code and should behave the same, but the runtime would have to act as `ledger_app` and `ledger_worker` without a login: through `SET ROLE` from the single superuser session, or the documented option naming the user a PGlite instance runs as. Ledger's start checks `current_user`, so `SET ROLE` would pass them; whether a role's password and `LOGIN` mean anything there is a question.
- One connection is the real obstacle. Ledger opens transactions on several connections at once, and a transaction that waits for a lock held by another connection's open transaction would wait for ever on a server that runs one connection at a time. The workers and the API would have to share one queue of statements, and every place that holds one connection while using another (a scoped transaction that reads through the pool, a worker that checks its lease on a second client) would have to be found first. Advisory locks would always be granted and fencing would never be exercised, which is not the same as being kept.
- Partitioning, deferred constraint triggers, `SECURITY DEFINER` and the `jsonb` features are core PostgreSQL and expected to work; that the whole migration set runs is the first thing to check.

**Embedded PostgreSQL binaries** (for example the `embedded-postgres` package for Node, which unpacks the PostgreSQL server binaries published by the zonky project for each platform and runs them as a child process) are the other kind of candidate. It is a real PostgreSQL server, so roles with passwords, several connections, locks and row-level security are what Ledger already runs on; nothing in Ledger would change. The cost is a download of native binaries for each platform, a child process to start and stop, and licences to check for each binary package. Not tried either.

No other embedded engine is a candidate: Ledger's schema is PostgreSQL's (row-level security, PL/pgSQL triggers), so SQLite or DuckDB would mean a second schema.

## Result

Not settled. Nothing was run against an embedded database, so nothing above is a result. From the inventory, PGlite's single connection is the likely obstacle and real PostgreSQL binaries the likely way through; one command and no Docker looks reachable with the second, at the cost of a native download, and doubtful with the first without changing how Ledger uses connections.

It is worth a short follow-up, in this order:

1. In a scratch folder outside the repository, install PGlite and run the 85 migrations through it as its superuser, with `DATABASE_APP_PASSWORD` and `DATABASE_WORKER_PASSWORD` set. Report the first statement that fails, if one does.
2. `SET ROLE ledger_app`, set `ledger.tenant_id` and read a seeded organization's rows and another's: the other's must not appear. Try an `UPDATE` of `journal_events`: the append-only trigger must refuse it.
3. Take `pg_advisory_xact_lock` in one transaction and the same lock from a second connection through `pglite-socket`: does the second wait, fail, or get it?
4. Run `pnpm test:integration` with the connection strings pointing at `pglite-socket`, and note which tests hang.
5. The same five steps with `embedded-postgres`, where steps 3 and 4 are expected to behave as on any PostgreSQL.

If PGlite fails at step 3 or 4 and the binaries pass, the follow-up becomes a one-command start built on them.
