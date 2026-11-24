# Verify a deployment

This folder repeats, on one computer, the deployment that [Deploy Ledger](../../docs/guides/deploy.md) describes, and checks that its backup restores. Run it before a release, or after changing the image, `infra/compose.production.yaml`, sign-in or anything a backup holds. It is not part of `pnpm verify`.

```sh
pnpm install && pnpm build        # the client, the record files and the checks run from the checkout
npx playwright install chromium   # once, if no Chromium is installed for Playwright
node infra/verify-deployment/verify.mjs all
node infra/verify-deployment/verify.mjs remove
```

It needs Docker with Compose 2.24 or later, `openssl` and Node 24. It builds the image as `ledger-verify:local` if that image does not exist (about ten minutes the first time). `--project <name>` changes the Compose project (default `ledger-verify`), and `--image <name>` uses an image you built.

## What it starts

`infra/compose.production.yaml` with its `database`, `storage`, `proxy` and `keycloak` profiles, with `compose.yaml` from this folder laid over it:

| Service | What it is | Reached from this computer at |
| --- | --- | --- |
| `ledger` | The image: the API, the web app and the workers | `https://ledger.localhost:18443` and `https://ledger-api.localhost:18443` |
| `postgres` | PostgreSQL 17 with PostGIS 3.5 | not published |
| `objects` | SeaweedFS 4.55, S3-compatible, honouring conditional writes | `http://127.0.0.1:18333` |
| `keycloak`, `keycloak-db` | Keycloak 26.4.0 with its own PostgreSQL, the realm `ledger` imported from `keycloak-realm.json` | `https://id.localhost:18443` |
| `proxy` | Caddy 2.10.2, terminating TLS for the three names | `127.0.0.1:18443` |

Every port is on `127.0.0.1` in the 18000s, so it runs beside a local development stack. `*.localhost` names reach this computer without editing any system file. A real deployment uses real names; see the guide.

TLS uses a local certificate authority that `verify.mjs` makes with `openssl` in `.local/verify-deployment/certs`. Nothing is added to the computer's trust store: the API container is given the authority's certificate (`NODE_EXTRA_CA_CERTS`), the client and the checks pass it per request, and the headless Chromium is given the server certificate's public key (`--ignore-certificate-errors-spki-list`).

`verify.env` holds the deployment's settings, `verify-owner.env` the database owner's connection (given only to the `setup` service, which runs the migrations and `create-organization.js`, never to the `ledger` service), and `keycloak-realm.json` two people, Avery Example and Jordan Example, with their passwords. All of them are public fixtures for this run only.

## What it does and checks

`all` runs the four steps in order; each can be run alone.

1. **start**: certificates; the database, storage, Keycloak and the proxy; the bucket; `check-object-store.mjs` (a retried write keeps the stored bytes and other bytes are refused); migrations and `create-organization.js` from the image through the `setup` service, as the guide runs them; the example waiver's pack file built into `.local/verify-deployment/packs`, which `compose.yaml` mounts where `infra/compose.production.yaml` mounts the checkout's `packs/`; the `ledger` service; `/readyz` and `/v1/sign-in` through the proxy, and the API's answer to a cross-origin request from the web app's origin.
2. **populate**: in the browser, Avery signs in at Keycloak. With the ID token the web app received, the command-line client checks that the waiver's pack file is offered for adoption as the organization's own file and that its adoption prints, imports the files in `records/` (their originals are stored in the bucket) and adopts the Part 107 pack; the workers evaluate it. In the browser Avery adds Jordan on the People screen, tied to Jordan's Keycloak user ID, drafts, reviews and signs the safety policy with **Confirm it’s you** (Keycloak asks for the password again) and issues it to Jordan. Jordan then signs in with their own account.
3. **backup**: reads back the records, coverage and people as Avery and checks the journal's hash chains (`journal-chain.mjs`); then runs `infra/backup.mjs`, the guide's backup script, through a `ledger-compose.sh` of this deployment: `pg_dump` of Ledger's database, `pg_dump` of Keycloak's, and the bucket copied with `copy-bucket.mjs`, in that order, into a new folder under `.local/verify-deployment/backups`, each checked.
4. **restore**: removes every container and volume, starts empty ones, creates `ledger_app` and `ledger_worker`, restores both dumps that backup wrote, copies the objects back, runs the migrations (nothing new to apply) and starts Keycloak, the proxy and Ledger. It then checks that both people sign in, that the records, coverage and people read exactly as before the backup, that the journal's chains verify with the same stream heads, that the restored store still keeps written bytes, and that records produced after the restore, with their originals, verify offline with `tools/verifier/record-production-cli.mjs`.

Each step prints one JSON line per thing it did. A failure prints `{"step":"failed",...}` and exits 1, and leaves the containers running so you can look: `docker compose -p ledger-verify ... logs` (the full command is in `verify.mjs`, function `compose`).

## The scripts an operator can use on their own deployment

- `check-object-store.mjs`: whether a bucket honours conditional writes. `node --env-file=ledger.env infra/verify-deployment/check-object-store.mjs` with `S3_ENDPOINT` reachable from where it runs.
- `copy-bucket.mjs download|upload <folder>`: the bucket to a folder and back, checking every object's SHA-256; an upload never replaces an object.
- `journal-chain.mjs`: checks every hash chain in the journal from what `psql` prints, as its header shows.

## Removing it

```sh
node infra/verify-deployment/verify.mjs remove   # the containers, their network and every volume
docker image rm ledger-verify:local              # the image it built, if you want it gone
rm -rf .local/verify-deployment                  # certificates, backups and read-backs
```

The pulled images (`imresamu/postgis`, `chrislusf/seaweedfs`, `quay.io/keycloak/keycloak`, `caddy`) stay until you remove them with `docker image rm`.
