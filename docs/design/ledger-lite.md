# Ledger Lite

Status: built. Code: `packages/persistence/migrations/0004_durable_telemetry.sql` (the position columns), `packages/persistence/src/objects.ts` (`objectStoreSetting`, `assertObjectStoreReady`), `apps/workers/src/runtime.ts` (`startWorkers`), `apps/api/src/one-process.ts`, `infra/scripts/runtime-config.mjs` and `runtime-entrypoint.mjs` (the image's `one-process` command), `infra/compose.lite.yaml`, `infra/backup.mjs --files`. Tests: `tests/unit/files-on-disk.test.ts`, `tests/unit/production-start.test.ts`, `tests/integration/one-process.integration.test.ts`.

Ledger Lite is the name of an arrangement, not of a product: the same code and the same image as any deployment, in fewer pieces. Plain PostgreSQL 17, one Ledger container that runs the API, the web app and the workers in one Node process, and the original files on a volume. No object store, no broker. People sign in through an identity provider exactly as in the split deployment.

## No PostGIS

PostGIS held one column, `telemetry_samples.position`, a `geography(Point,4326)` written by one statement and read by one (the roster's last known position, through `ST_X` and `ST_Y`). Its GiST index was used by no query: every area and route is computed in code (`packages/domain/src/mission-avoidance-kernel.ts` and its callers), on the coordinates in the retained records. The column became two: `latitude` and `longitude`, `double precision`, in degrees, WGS84 as the adapters report them, with checks for -90 to 90 and -180 to 180 (which also refuse NaN and infinity). The index went with it.

The extension was the reason the Compose files pinned a third-party multi-architecture image and the reason a managed PostgreSQL needed a superuser for the first migration. Without it every Compose file uses the official `postgres:17-alpine`, and the migrations need no extension at all.

The first and fourth migrations were edited in place, once, for this. A database made before the change no longer matches their checksums and is recreated, not converted: there was no deployment to keep.

Considered: keeping PostGIS as optional. Two schemas for one column, and a test matrix for both, for nothing a query uses.

## Files on disk as a deployment's choice

The disk store (`DiskObjectStore`) was for local development only, and a deployment (`LEDGER_ENV=staging`) always used S3. The reason, read from the code: the disk store's default folder is relative (`.ledger-objects`) and is made on the first write, so a deployment that forgot to configure storage would have kept original files in the container's own layer and lost them with the container, without a word. That protection is kept and made explicit:

- A deployment uses the disk store only when it names it, `OBJECT_STORE=disk`, with `OBJECT_STORAGE_DIR` an absolute path. Unset, a deployment still uses S3.
- The API, the workers and the one-process start refuse to start when the named folder is missing, is not a folder, or is not writable by the process. Ledger does not create it: a missing folder usually means a disk or a volume that was not mounted.
- In the image the folder is fixed, `/data/ledger/files`, and the entrypoint refuses to start unless a volume is mounted at `/data` (the check it already made for the broker's files). It creates the folder there, owned by the image's user, mode 700.

Integrity is the same as with a bucket because it never was the store's: every reader compares the bytes with the length and SHA-256 recorded in the database before using them, and a write of other bytes under an existing key is refused by both stores. The backup reads the key and digest of every object from the dump and checks each copied file against it, for a bucket as for a folder.

## One process

`apps/api/dist/one-process.js` (in the image, the `one-process` command) builds the API with `createApp`, listens, then starts the workers' loop with `startWorkers`, the same function the workers' own process runs. Each keeps its own pool and role: the API connects as `ledger_app` and checks it at start; the workers connect as `ledger_worker` with `WORKER_DATABASE_URL` and check it too. Leases, fencing and the lock order are the workers' own code, unchanged, so the workers in this process take exactly the leases they would take in their own. Row-level security and the append-only triggers are the database's, and do not know how many processes there are.

On `SIGTERM` the workers finish the work they hold, then the API closes. If the workers' loop ends by itself the process stops, as the supervisor stops the split start when its workers process exits. The one-process start refuses the extras the supervisor can start beside the API and the workers (an adapter, the emulators, the simulator, the broker): an adapter runs as its own container.

The split start stays the image's default (`CMD ["supervise"]`). One process means one Node event loop: a long evaluation delays the API's answers while it runs. That is the trade for a small operation.

Considered: a setting read by the supervisor instead of a command. The supervisor would still have been a second process; a command keeps the image's default untouched and makes the arrangement visible in the Compose file.
