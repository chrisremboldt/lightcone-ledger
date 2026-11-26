# Deploy Ledger

This guide takes you from an empty server to your own organization in Ledger: its people signed in, its rule packs adopted and its records imported. It covers the container image, PostgreSQL and its database roles, object storage or files on disk, every environment variable, migrations, creating the organization, sign-in, credentials for sources and services, the message broker, backups, health checks, and what is not hardened. [Ledger Lite](#ledger-lite) is the smallest arrangement: one Ledger container and plain PostgreSQL.

Ledger is pre-release. Read [Status and limits](../README.md#status-and-limits) first. Ledger keeps a record and checks it against the rules your organization adopts; it reports what is on file and what is not. It does not make anyone conform to a regulation.

Commands marked **unverified** were written from the code, the configuration or a provider's published documentation, and were not run for this guide; each says why. Everything else was run, as [What was run for this guide](#what-was-run-for-this-guide) lists.

### What was run for this guide

On one computer (Docker 29 with Compose 5.5, arm64), in containers of its own, with `*.localhost` names in place of real ones and certificates from a local certificate authority. [`infra/verify-deployment`](../../infra/verify-deployment/README.md) repeats all of it with one command, `node infra/verify-deployment/verify.mjs all`; run it again before you rely on a new version.

- `infra/compose.production.yaml` with its `database`, `storage`, `proxy` and `keycloak` profiles: the image, PostgreSQL 17, SeaweedFS 4.55, Caddy 2.10.2 and Keycloak 26.4.0 with its own database. That run used PostgreSQL 17 with PostGIS 3.5, before Ledger stopped needing PostGIS; since then the migrations and the integration tests were run against the official `postgres:17-alpine` image that every Compose file now uses, and `verify.mjs` was not run again.
- TLS at the proxy for three names, the web app (`ledger.localhost`), the API (`ledger-api.localhost`) and Keycloak (`id.localhost`); the API reading Keycloak's discovery and keys over https through the proxy; the API's answer to a cross-origin request from the web app's origin.
- Migrations and `create-organization.js` from the image, through `docker compose run` of the `setup` service, the only service given the owner's connection (`ledger-owner.env`); the `ledger` service started without it.
- Keycloak as in [the example](#example-keycloak-self-hosted): the realm, the public client with PKCE, two people. In a headless Chromium: the administrator signed in at Keycloak, added the second person on the People screen tied to their Keycloak user ID, and signed the safety policy with **Confirm it’s you**, which made Keycloak ask for the password again (the signature records `openid_connect` and the time of that sign-in); the second person then signed in with their own account. Records were imported and the Part 107 pack adopted with the command-line client, using the ID token the web app received.
- The object store kept the first bytes of a retried write and refused other bytes for the same key ([section 3](#3-object-storage)).
- The organization's own pack file placed in the folder the `ledger` service mounts ([Your own rule packs](#your-own-rule-packs-in-the-deployment)): offered for adoption as the organization's file, its adoption printed.
- The backup in [section 9](#9-backups-and-restoring) of that deployment, taken and checked by `infra/backup.mjs`, restored into empty containers: both people signed in, the records, coverage and people read the same, the journal's hash chains verified with the same heads, and records produced after the restore, with their originals, verified offline.
- The API and the workers as two containers, the workers evaluating a new import; `credential:issue`, `broker:files` and the broker profile from the image; the position adapter as its own container (the `adapter` profile), submitting every message an aircraft account published to the broker, and under the image's supervisor, where it signed in and subscribed ([section 10](#10-connect-a-source-run-an-adapter)); the realm import command of the Keycloak example.
- `infra/compose.try.yaml` with an image built from the checkout (`up --build`; the published image was not pulled, as none had been published): the migrations ran by themselves, the organization was created with the `setup` service, its development token was accepted over HTTP and on the web app's sign-in screen, `/readyz` answered as `ledger_app`, the API logged its development sign-in line, the `client` service ran `me` and imported a records file, whose bytes were kept in the volume, and the records were there after `down` and `up`.

Not run: `infra/compose.lite.yaml` and its backup with `--files` ([Ledger Lite](#ledger-lite); its one process was run from a checkout, not from the image), the nightly schedule line for the backup (the script was run, not from cron), a real host name with certificates the proxy obtains itself (needs a public server), Google Workspace and Microsoft Entra ID (need accounts), and Keycloak's admin console clicked through by hand (the realm was imported from a file with the same settings).

## Try Ledger on one computer

`infra/compose.try.yaml` starts Ledger from the published image beside PostgreSQL, with Docker and nothing else, for someone deciding whether Ledger is for them. **It is not a start for a server**, and differs from one on purpose:

- It runs the image with `LEDGER_ENV=local` (and `NODE_ENV=development`), set in that file and nowhere else. The API then accepts development tokens, and the web app, which asks the API at start, offers **Use a development token** on its sign-in screen, marked "Local development". At start the API logs one line saying development sign-in is on and that this is not a start for a server. A server runs the image's own `LEDGER_ENV=staging` and `NODE_ENV=production`: its API refuses development tokens and reports none to the web app, which then offers none.
- It keeps uploaded and imported files in a Docker volume (`ledger-try-files`), written once, instead of object storage, and needs no identity provider.
- It publishes Ledger on `127.0.0.1` only, and PostgreSQL not at all. Its passwords are fixed values in the file. Never publish its port beyond the computer, and never put it behind a proxy.

From a checkout:

```sh
docker compose -f infra/compose.try.yaml up -d --wait
docker compose -f infra/compose.try.yaml run --rm setup apps/api/dist/create-organization.js \
  --name "Example Aerial Survey" --time-zone America/Denver --admin "Avery Example"
```

`up` pulls the image, runs the migrations (the `setup` service, which exits once they are done; it runs them again, applying nothing, on every start), starts Ledger and waits until `/readyz` answers. If the image cannot be pulled, for example before one is published, Compose builds it from `infra/Dockerfile` instead; `--build` builds it again from the checkout. `LEDGER_IMAGE` names another image, for example a release pinned by its digest, and `LEDGER_TRY_PORT` another port of the computer (default 4000). The second command creates the organization and prints the administrator's development token once, and where to open the web app: `http://127.0.0.1:4000`, **Use a development token**. Its `setup` service is the only one given the database owner's connection. A lost token is replaced, and a token for another person issued, with `docker compose -f infra/compose.try.yaml run --rm setup apps/api/dist/issue-development-token.js --organization <id> --for "<the person's name>"`, or on the People screen.

The organization's own rule pack files go in `packs/` at the checkout's root (make it with `mkdir -p packs` before the first start; otherwise Docker makes it, on Linux owned by root), as on a server ([Your own rule packs in the deployment](#your-own-rule-packs-in-the-deployment)); `docker compose -f infra/compose.try.yaml restart ledger` reads them. `docker compose -f infra/compose.try.yaml down` stops it and keeps the records in their volumes; `down -v` deletes them.

### The command-line client against it

The image holds the command-line client. The `client` service runs it against this start's API, in the folder the command is typed in, which it mounts, so files named on the command line are read and written there:

```sh
mkdir -p .ledger && printf 'LEDGER_TOKEN=%s\n' '<the development token>' > .ledger/credentials
docker compose -f infra/compose.try.yaml run --rm client me
docker compose -f infra/compose.try.yaml run --rm client records import aircraft.identity organization/records/aircraft.csv
```

Each `pnpm ledger <command>` in the guides is `docker compose -f infra/compose.try.yaml run --rm client <command>` here. The credential is read from `LEDGER_TOKEN` in the shell, or from `.ledger/credentials` in the folder the command is typed in (git ignores it in this checkout); a credential is never given as an argument. A coding agent does the same. The client runs as user 1000 in the container: on Linux, a file it writes into the folder belongs to that user. From a checkout with Node 24 and pnpm (as in the [README](../../README.md#from-a-source-checkout), `pnpm install --frozen-lockfile && pnpm build`), `pnpm ledger` reaches the same API at `http://127.0.0.1:4000`, its default; set `LEDGER_API_URL` in `.ledger/credentials` for another `LEDGER_TRY_PORT`.

## Ledger Lite

Ledger Lite is the smallest arrangement of a deployment, for a small operation: the same image and the same code, in fewer pieces. `infra/compose.lite.yaml` runs

- one Ledger container, which runs the API, the web app and the workers in one Node process (the image's `one-process` command);
- plain PostgreSQL 17 (`postgres:17-alpine`); a managed PostgreSQL 17 serves as well;
- the original files on a volume (`ledger-lite-files`) instead of in object storage ([Files on disk](#files-on-disk));
- no broker, no object store, no identity provider of its own.

It is a deployment, not a trial: the image's `LEDGER_ENV=staging`, people sign in through your identity provider ([section 6](#6-sign-in)) and development tokens are refused. Row-level security, the append-only history and the workers' leases are the same as in the split start: the API connects as `ledger_app` and the workers as `ledger_worker`, each with its own connections, and the workers take and fence their leases exactly as in a process of their own ([`docs/design/ledger-lite.md`](../design/ledger-lite.md)). One process means one event loop: a long evaluation delays the API's answers while it runs. Move to `infra/compose.production.yaml` when that matters; the database and the files move with you (copy the files into the bucket with `copy-bucket.mjs upload`).

From the checkout, with `ledger.env` and `ledger-owner.env` at its root as in [The smallest deployment](#the-smallest-deployment) (leave out the `S3_` settings; `OBJECT_STORE` and `OBJECT_STORAGE_DIR` are set by the file):

```sh
mkdir -p packs
docker compose --env-file ledger.env --env-file ledger-owner.env -f infra/compose.lite.yaml up -d --wait
docker compose --env-file ledger.env --env-file ledger-owner.env -f infra/compose.lite.yaml run --rm setup \
  apps/api/dist/create-organization.js --name "<organization>" --time-zone <IANA zone> --admin "<your name>" \
  --sign-in-issuer <issuer> --sign-in-subject <your user id there>
```

`up` runs the migrations (the `setup` service, which exits once they are done, on every start), then starts Ledger and waits until `/readyz` answers. Ledger listens on `127.0.0.1:4000` (`LEDGER_LITE_PORT` moves it): put a TLS proxy in front of it, as in [The smallest deployment](#the-smallest-deployment). The backup is the database and the files volume together ([section 9](#files-on-disk-in-the-backup)). **Unverified**: the file was not brought up for this guide (`node infra/verify-deployment/check-lite.mjs` is the check, and needs the image built); the one process it runs was run from a checkout with `LEDGER_ENV=staging` against plain PostgreSQL, where it answered `/readyz` as `ledger_app`, served the web app, refused a development token, completed leased work and stopped cleanly on `SIGTERM`.

From a checkout without Docker, the same process is `node apps/api/dist/one-process.js`, with the settings of `ledger.env` in its environment and `OBJECT_STORE=disk` and `OBJECT_STORAGE_DIR=<an absolute folder that exists>` for files on disk.

## What you run

| Part | What it is | How it starts |
| --- | --- | --- |
| API and web app | Fastify server: every read and write, including the web app's. In the image it also serves the built web app from its own origin, so browsers reach both at one address. Listens on `PORT` (4000). Connects as the database role `ledger_app`. | The image, or `node apps/api/dist/main.js` |
| Workers | Leased, fenced background work: projections, rule evaluations, deadlines. No HTTP port. Connects as the database role `ledger_worker`. | The image, or `node apps/workers/dist/main.js` |
| PostgreSQL 17 | The journal, projections, work queue and outbox. No extension is needed. | Your database service |
| Object storage (S3-compatible), or a folder on disk | The original bytes of every upload and import. | Your storage service, or a disk or volume ([Files on disk](#files-on-disk)) |
| MQTT broker (optional) | Only for sources that report over MQTT, such as DJI Cloud API telemetry. Its accounts come from your sources on record; see [The message broker](#the-message-broker). | Mosquitto, as its own service |

A production start of the image runs the API, the web app and the workers, and nothing else. The emulators of outside systems and the simulator are development tools for the fictional world: they start only when asked, and a deployment needs none of their settings.

Only the API needs to be reachable from browsers and sources. Put it behind a reverse proxy or load balancer that terminates TLS; the API itself speaks plain HTTP.

## The smallest deployment

One small server runs everything: Ledger, its database and object store, Keycloak with its own database, and Caddy, which obtains certificates for the three names by itself. Every service is a profile of `infra/compose.production.yaml`. Each step says who does it: **the agent** (the operator's coding agent, on the server) or **a person** (someone at the organization, with the accounts and the decisions). Run on one computer for this guide except steps 1, 2 and the certificates Caddy obtains, which need a public server ([What was run](#what-was-run-for-this-guide)).

1. **A person** rents a Linux server with Docker Engine and the Compose plugin 2.24 or later, at least 2 processors, 4 GB of memory (8 GB is more comfortable: Keycloak and the image build use most of it) and 40 GB of disk, and gives the agent a shell on it.
2. **A person** creates three DNS records at the organization's domain, each pointing at the server's public address: `ledger.example.org`, `ledger-api.example.org` and `id.example.org`, and opens ports 80 and 443 to the server (Caddy answers the certificate authority's checks on them). Nothing else needs to be open; SSH is the person's choice.
3. **The agent** clones the repository on the server, installs Node 24 and pnpm, and runs `pnpm install --frozen-lockfile && pnpm build` (for the checks and backup scripts below; the image builds itself). It makes the folder for the organization's own pack files, `mkdir -p packs`, which the `ledger` service mounts (git ignores it).
4. **The agent** writes two files at the checkout's root, each readable by the server's administrator only (`chmod 600`), never committed. Each password is a new random value (`openssl rand -hex 24`). `ledger-owner.env` holds the database owner's connection, which only migrations and the setup commands are given:

   ```sh
   LEDGER_DATABASE_OWNER_PASSWORD=<owner password>
   DATABASE_ADMIN_URL=postgresql://ledger_owner:<owner password>@postgres:5432/ledger
   ```

   `ledger.env` holds everything else, which the API and the workers are given; it never holds the owner's connection (the API and the workers refuse to start with it):

   ```sh
   LEDGER_ENV=staging
   DATABASE_URL=postgresql://ledger_app:<app password>@postgres:5432/ledger
   WORKER_DATABASE_URL=postgresql://ledger_worker:<worker password>@postgres:5432/ledger
   DATABASE_APP_PASSWORD=<app password>
   DATABASE_WORKER_PASSWORD=<worker password>
   S3_ENDPOINT=http://objects:8333
   S3_BUCKET=ledger
   S3_REGION=us-east-1
   S3_ACCESS_KEY_ID=<random>
   S3_SECRET_ACCESS_KEY=<random>
   CORS_ORIGINS=https://ledger.example.org
   LEDGER_OIDC_ISSUER=https://id.example.org/realms/ledger
   LEDGER_OIDC_CLIENT_ID=ledger-web
   LEDGER_OIDC_LABEL=Example ID
   LEDGER_DEPLOYMENT_NAME=<the organization's name>
   KEYCLOAK_URL=https://id.example.org
   KEYCLOAK_DB_PASSWORD=<random>
   KEYCLOAK_BOOTSTRAP_PASSWORD=<random>
   ```

   The storage profile's SeaweedFS takes its one key from `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. The agent hands `KEYCLOAK_BOOTSTRAP_PASSWORD` to the person who will administer Keycloak, by a channel the organization uses for passwords.
5. **The agent** writes `Caddyfile` at the checkout's root. Caddy obtains and renews the certificates itself, and writes no access log unless told to, so the addresses of people sending safety reports through a reporting link are not logged:

   ```text
   ledger.example.org, ledger-api.example.org {
   	reverse_proxy ledger:4000
   }

   id.example.org {
   	reverse_proxy keycloak:8080
   }
   ```

6. **The agent** starts everything but Ledger, creates the bucket and checks it keeps written bytes:

   ```sh
   printf '#!/bin/sh\nexec docker compose --env-file ledger.env --env-file ledger-owner.env -f infra/compose.production.yaml --profile database --profile storage --profile proxy --profile keycloak "$@"\n' > ledger-compose.sh
   chmod +x ledger-compose.sh
   ./ledger-compose.sh up -d --wait postgres objects keycloak proxy
   ./ledger-compose.sh exec objects sh -c 'echo "s3.bucket.create -name ledger" | weed shell'
   S3_ENDPOINT=http://127.0.0.1:8333 node --env-file=ledger.env infra/verify-deployment/check-object-store.mjs
   ```

   (A variable set before `node` wins over the file: the store is published on the server's own address only.) Both files go to Compose, which gives the database its owner password; the `ledger` service is given `ledger.env` only, and the `setup` service, which runs migrations and the setup commands, both. Then it builds the image and runs the migrations: `./ledger-compose.sh build ledger`, then `./ledger-compose.sh run --rm --no-deps setup packages/persistence/dist/migrate.js`. `ledger.env`, `ledger-owner.env`, `Caddyfile`, `keycloak/`, `ledger-compose.sh` and `backups/` at the checkout's root are ignored by git.
7. **The agent** writes and imports the realm, as in [step 2 of the Keycloak example](#example-keycloak-self-hosted).
8. **A person** signs in to `https://id.example.org/admin` as `bootstrap-admin`, creates a permanent Keycloak administrator for themselves and deletes the bootstrap account, then creates each person's account in the `ledger` realm and sets a temporary password ([step 3](#example-keycloak-self-hosted)). They give the agent the first administrator's Keycloak user **ID**; passwords go only to their owners.
9. **The agent** creates the organization tied to that ID ([step 5](#example-keycloak-self-hosted)), starts Ledger with `./ledger-compose.sh up -d --wait ledger`, and checks `curl https://ledger-api.example.org/readyz` and `curl https://ledger-api.example.org/v1/sign-in` ([step 4](#example-keycloak-self-hosted)).
10. **A person**, the first administrator, opens `https://ledger.example.org`, signs in, and adds everyone else on **People** with their Keycloak user IDs. Their [first day](#your-first-day) follows.
11. **The agent** puts the organization's own pack files (its waiver, its manual) in `packs/` and restarts Ledger, as [Your own rule packs in the deployment](#your-own-rule-packs-in-the-deployment) says; **a person** adopts each.
12. **The agent** takes a first backup with `infra/backup.mjs` and adds the schedule line that runs it every night ([section 9](#take-a-backup)); **a person** decides where the copy off the server lives and for how long, and has a restore drill run on a schedule. A backup that has not been restored is not known to work.

To use Microsoft Entra ID instead of Keycloak, leave out the `keycloak` profile, the `id` name and steps 7 and 8, and follow [Microsoft Entra ID as the identity provider](#microsoft-entra-id-as-the-identity-provider) (unverified). Google Workspace goes through Keycloak ([Google Workspace](#google-workspace-as-the-identity-provider)).

## 1. Build and start the container image

The image in `infra/Dockerfile` builds the API, the workers and the web app from one checkout. Build it from the repository root. Nothing about sign-in is built in: the web app reads it from the API (see [Sign-in](#6-sign-in)).

```sh
docker build -f infra/Dockerfile -t ledger:local .
```

The build fails if the web app contains demonstration code or the fictional people's credentials (`tools/check-production-build.mjs`). Its sign-in screen offers a development token only when the API reports that it accepts them, which with the image's `LEDGER_ENV=staging` it never does. The web app calls the API with relative URLs, so it needs no API URL: the API serves it from the same origin.

Each published release of Ledger is also an image in the GitHub Container Registry, `ghcr.io/<owner>/<repository>` of the repository it was released from in lower case (for this repository, `ghcr.io/chrisremboldt/lightcone-ledger`), built for linux/amd64 and linux/arm64 by `.github/workflows/image.yml`. It is tagged with the release's tag, and `latest` for a release that is not a pre-release. The workflow run's summary gives its digest. To run it instead of building, put `image: ghcr.io/chrisremboldt/lightcone-ledger@sha256:<digest>` for the `ledger`, `setup` and `adapter` services of `infra/compose.production.yaml` (or tag it `ledger:local` after pulling): a digest names exactly the image that was built, where a tag can be moved. The workflow can also be run by hand from the repository's Actions page; it then builds both platforms and publishes nothing unless its **publish** box is ticked, and then only as `sha-<commit>`.

The image sets `NODE_ENV=production`, `LEDGER_ENV=staging`, `HOST=0.0.0.0`, `PORT=4000` and `LEDGER_WEB_DIR=/app/apps/web/dist`. Outside local development Ledger always runs with `LEDGER_ENV=staging`: the API refuses to start with development sign-in when `NODE_ENV=production`.

Put your settings in an env file, `ledger.env` here, with the variables marked required in [Environment variables](#4-environment-variables), and start it. The database owner's connection (`DATABASE_ADMIN_URL`, and `LEDGER_DATABASE_OWNER_PASSWORD` for the database profile) goes in a second file, `ledger-owner.env`, which only migrations and the setup commands are given: with `LEDGER_ENV=staging` the image's supervisor, the API and the workers refuse to start when their environment holds it, and say which variable to remove.

```sh
docker run -d --name ledger --env-file ledger.env -p 4000:4000 --restart unless-stopped ledger:local
```

or, from a checkout with `ledger.env` at its root, with Docker Compose 2.24 or later:

```sh
docker compose --env-file ledger.env --env-file ledger-owner.env -f infra/compose.production.yaml up -d --wait
```

which builds the same image, publishes the API on `127.0.0.1:4000` only (put the TLS proxy in front of it) and waits until `/readyz` answers. The same file can start, each only with its profile, the database (`--profile database`), an object store (`--profile storage`), the TLS proxy (`--profile proxy`), Keycloak (`--profile keycloak`), the message broker and an adapter; [The smallest deployment](#the-smallest-deployment) uses it on one server. `--env-file ledger.env --env-file ledger-owner.env` gives those services their passwords from the two files (the variables are listed in `.env.example`); the `ledger` service's own environment is `ledger.env` alone. The `setup` service runs one migration or setup command with both files: `docker compose --env-file ledger.env --env-file ledger-owner.env -f infra/compose.production.yaml run --rm --no-deps setup <script> [arguments]`.

Its entrypoint (`infra/scripts/runtime-entrypoint.mjs`) drops to UID/GID 1000 and runs a supervisor (`infra/scripts/supervise.mjs`) that starts, in order:

1. the API, and waits until `GET /readyz` reports the `ledger_app` role;
2. the workers.

If either exits, the supervisor stops the other and exits non-zero, so let your orchestrator restart the container. Open `https://<your host>/` for the web app.

The supervisor starts the emulators only when `LEDGER_EMULATORS=1` is set, or when `SIMULATOR_RUNTIME_MODE` asks for the simulator; leave both unset. A unit test (`tests/unit/production-start.test.ts`) fails if the image's own settings would start either.

To run the API and the workers as separate containers instead, bypass the supervisor:

```sh
docker run -d --env-file ledger.env --user 1000:1000 -p 127.0.0.1:4000:4000 --entrypoint node ledger:local apps/api/dist/main.js
docker run -d --env-file ledger.env --user 1000:1000 --entrypoint node ledger:local apps/workers/dist/main.js
```

Each container needs to reach the database and the object store by the names in `ledger.env`: on a Compose network, add `--network <project>_default`.

You can run any number of worker processes: each leases its own work and a worker that loses its lease cannot commit.

To serve the web app from another host instead, build it with the API's public URL and serve `apps/web/dist` from any static host, and leave `LEDGER_WEB_DIR` unset for the API:

```sh
VITE_API_URL=https://ledger-api.example.org pnpm --filter @ledger/web build
pnpm check:production-build
```

## 2. PostgreSQL and the database roles

Use PostgreSQL 17. Ledger needs no extension, so any PostgreSQL 17 serves, a managed one included; the Compose files use the official image `postgres:17-alpine`, built for both linux/amd64 and linux/arm64 (pinned by digest). Create one database for Ledger.

A database made before Ledger stopped needing PostGIS is recreated, not converted: two of its migrations changed in place, so the migrations refuse it (`no longer matches its immutable checksum`). Drop it and run the migrations into an empty one.

Ledger uses three roles:

| Role | Used by | What it may do |
| --- | --- | --- |
| The owner (any name you choose) | Migrations and `pnpm org:create`, through `DATABASE_ADMIN_URL` | Owns every table. Creates `ledger_app` and `ledger_worker` on the first migration. |
| `ledger_app` | The API, through `DATABASE_URL` | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`, with only the grants the migrations give it. |
| `ledger_worker` | The workers, through `WORKER_DATABASE_URL` | Likewise non-owner and without row-level-security bypass. |

The role names `ledger_app` and `ledger_worker` are fixed. On startup the API refuses to run unless it is connected as `ledger_app` and that role is not a superuser, cannot bypass row-level security and does not own the tables; the workers check the same for `ledger_worker`. Every tenant table has a row-level security policy that admits only the rows of the tenant the request authenticated as, so one organization never reads another's records even if the API had a bug in a query.

The owner needs, the first time migrations run:

- `CREATEROLE`, to create `ledger_app` and `ledger_worker`, unless you create them yourself first with the attributes above. Their passwords come from `DATABASE_APP_PASSWORD` and `DATABASE_WORKER_PASSWORD` and are set only when the role is created; change one later with `ALTER ROLE`.

No superuser is needed: the whole migration set was run for this guide on the official `postgres:17-alpine` image by an owner with only `LOGIN CREATEROLE`, into an empty database it owned, with `LEDGER_ENV=staging`.

Roles are shared by every database in a PostgreSQL cluster. Give Ledger its own cluster, or at least do not reuse these role names for anything else.

## 3. Object storage

Ledger keeps the original bytes of every upload and import written once and never overwritten: in an S3-compatible bucket, or in a folder on disk ([Files on disk](#files-on-disk)). With `LEDGER_ENV=staging` it uses S3 unless the deployment names the disk store, and refuses to start without `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.

- The store must honour conditional writes (`If-None-Match: *` on `PutObject`); Ledger relies on it so a retried upload never replaces stored bytes. **A store that ignores the header accepts the write and replaces the bytes, and Ledger cannot tell.** Check yours before you rely on it, from a checkout after `pnpm build`, with `S3_ENDPOINT` reachable from where you run it:

  ```sh
  node --env-file=ledger.env infra/verify-deployment/check-object-store.mjs
  ```

  It writes one small object under `ledger-store-check/` through Ledger's own storage code, writes it again with the same bytes and with other bytes, and reads it back. `"status":"keeps_first_bytes"` means the store honours the header; `replaces_stored_bytes` (exit code 1) means do not use it. Run for this guide: SeaweedFS 4.55 (`chrislusf/seaweedfs`, the `storage` profile of `infra/compose.production.yaml`) kept the first bytes. Garage 2.1.0 and the Versity S3 gateway 1.0.18 (POSIX backend) replaced them, and must not be used as they are. Hosted providers were not checked here; run the script against yours.
- Requests use path-style addressing. Set `S3_ENDPOINT` for anything other than Amazon S3, and `S3_REGION` where the provider needs one (`auto` is the default).
- Give the API and workers one key limited to that bucket: they read and write objects and need nothing else. Ledger creates no bucket: create it first (with the `storage` profile: `docker compose --env-file ledger.env -f infra/compose.production.yaml exec objects sh -c 'echo "s3.bucket.create -name ledger" | weed shell'`).
- Turning on bucket versioning or object lock adds protection against a deleted object (**unverified** with Ledger: how each is turned on, and what it costs, is the provider's; Ledger never deletes or overwrites an object, so neither changes what it does).

### Files on disk

A deployment may keep the files in a folder instead, for a small operation on one server ([Ledger Lite](#ledger-lite) does). Set `OBJECT_STORE=disk` and `OBJECT_STORAGE_DIR` to the folder, an absolute path:

- The folder must exist and be writable by the process. The API, the workers and the one-process start refuse to start otherwise, and say which folder; Ledger does not create it, because a folder that is not there usually means a disk or volume that was not mounted. Without `OBJECT_STORE=disk` a deployment never uses a folder, so files cannot land unnoticed in a container's own short-lived storage.
- In the image the folder is `/data/ledger/files`, and nothing else: the image refuses to start with another, or without a volume mounted at `/data`. It creates the folder on that volume, owned by its own user (1000) with mode 700. `infra/compose.lite.yaml` sets both variables and mounts the volume.
- Each file is written to a temporary name, flushed to disk and linked into place, so a file is either whole or absent; a second write of the same key with other bytes is refused, as with a bucket.
- Digests are checked exactly as with object storage: every read compares the bytes with the length and SHA-256 the database recorded for them before using them, and refuses them if they differ.
- The API and the workers must see the same folder. With them in one process, or in one container, that is given; as separate containers, mount the same volume into both.
- Back the folder up with the database, after it ([Files on disk in the backup](#files-on-disk-in-the-backup)).

## 4. Environment variables

Set these for the API, the workers, migrations and the setup commands. One env file serves the API and the workers, and migrations and the setup commands read it too; the owner's connection is in a second file that only migrations and the setup commands are given. `.env.example` lists every variable Ledger reads, each with a line saying what it is for and whether production needs it; its values are fixtures for the local stack, so never use them anywhere else. A unit test (`tests/unit/env-example.test.ts`) checks that `.env.example` lists every variable the code reads and nothing else.

| Variable | Used by | What it is for |
| --- | --- | --- |
| `LEDGER_ENV` | all | `staging` outside local development (the image sets it). `local` and `test` allow development tokens and must never face a network. |
| `NODE_ENV` | all | `production` in a deployment (the image sets it); with it, any `LEDGER_ENV` other than `staging` is refused. |
| `HOST`, `PORT` | API | Where the API listens. The image sets `0.0.0.0:4000`. |
| `LEDGER_WEB_DIR` | API | The built web app the API serves from its own origin. The image sets it; unset, the API serves no web app. |
| `DATABASE_ADMIN_URL` | migrations, `org:create`, `credential:issue`, `broker:files` | The owner's connection string, in `ledger-owner.env`. With `LEDGER_ENV=staging` the API, the workers and the image's supervisor refuse to start when they are given it (or `LEDGER_DATABASE_OWNER_PASSWORD`). |
| `DATABASE_URL` | API | `postgresql://ledger_app:<password>@<host>:5432/<database>`. Required. |
| `WORKER_DATABASE_URL` | workers | `postgresql://ledger_worker:<password>@<host>:5432/<database>`. Required. |
| `DATABASE_APP_PASSWORD` | migrations | The password `ledger_app` is created with. Required with `LEDGER_ENV=staging` (`LEDGER_APP_PASSWORD` is read too). |
| `DATABASE_WORKER_PASSWORD` | migrations | The password `ledger_worker` is created with. Required with `LEDGER_ENV=staging`. |
| `DATABASE_POOL_SIZE` | API, workers | Connections per process. Default 10. |
| `OBJECT_STORE` | API, workers | `s3` or `disk`. Unset, `s3` with `LEDGER_ENV=staging`. (`OBJECT_STORAGE_BACKEND` is read too.) |
| `OBJECT_STORAGE_DIR` | API, workers | With `disk`, the folder for the files, an absolute path that exists and is writable; in the image `/data/ledger/files` ([Files on disk](#files-on-disk)). Required with `disk`. |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | API, workers | The bucket and its key. Required with `s3`. |
| `S3_ENDPOINT`, `S3_REGION` | API, workers | The provider's endpoint and region, where it needs them. |
| `LEDGER_OIDC_ISSUER`, `LEDGER_OIDC_CLIENT_ID`, `LEDGER_OIDC_LABEL`, `LEDGER_OIDC_CHECK_AUTHORIZED_PARTY`, `LEDGER_OIDC_ISSUERS`, `LEDGER_DEPLOYMENT_NAME` | API, `org:create` | Sign-in through OpenID Connect: see [section 6](#environment-variables). An issuer is required with `LEDGER_ENV=staging`. |
| `CORS_ORIGINS` | API | Comma-separated origins of the web app, for example `https://ledger.example.org`. With the image serving the web app this is the address people open. Browsers from any other origin are refused, and with `LEDGER_OIDC_CHECK_AUTHORIZED_PARTY=true` an ID token's `azp` must name one of these origins or the client id. `WEB_ORIGINS` takes precedence if set. |
| `LEDGER_PACKS_DIR` | API, workers | The folder of your own rule pack files (`*.pack.json`), for example a waiver you built with `pnpm pack:build`. Both processes read it at startup: give both the same absolute path and restart both after changing it. Unset: built-in packs only. `infra/compose.production.yaml` sets it for you: it mounts `packs/` at the checkout's root into the `ledger` service, read-only, as `/packs`, and sets `LEDGER_PACKS_DIR=/packs` there (see [Your own rule packs](#your-own-rule-packs-in-the-deployment)); do not set it in `ledger.env`. See [Write a rule pack](write-a-rule-pack.md). |
| `LEDGER_EXAMPLE_PACKS` | API, workers | Leave unset. An organization of your own is offered only the packs that quote a regulation (Part 107, and the proposed Part 108 in shadow) and your own pack files; the invented example and demonstration packs, which name fictional organizations, are offered only to the seeded fictional organizations of a local stack. `1` offers them to every organization; give both processes the same value. |
| `LEDGER_SMTP_HOST`, `LEDGER_SMTP_PORT`, `LEDGER_SMTP_SECURE`, `LEDGER_SMTP_USER`, `LEDGER_SMTP_PASSWORD`, `LEDGER_SMTP_FROM` | API, workers | The mail server email notices go through. Unset `LEDGER_SMTP_HOST`: no email is sent. See [Notices](#notices-by-email-and-webhook). |
| `LEDGER_PUBLIC_URL` | API, workers | The address people open Ledger at, such as `https://ledger.example.org`; every link in a notice starts with it. Required with `LEDGER_SMTP_HOST`. |

The web app reads one variable when it is built, and nothing about sign-in:

| Variable | What it is for |
| --- | --- |
| `VITE_API_URL` | The API's public URL, only when the web app is served from another host. Empty means the same origin. |

Leave everything else in `.env.example` unset in a deployment: those variables configure the development tools (`LEDGER_EMULATORS`, `SIMULATOR_*`, `EMULATOR_*`, `AIRSPACE_*`, `PARTNER_API_KEY`, `DJI_*`), the fictional seeded organizations (the last block of `.env.example`, headed "The seeded fictional organizations", which can be deleted whole) or the checks. A production start needs no emulator credential, real or dummy.

## 5. Run the migrations

Migrations are SQL files in `packages/persistence/migrations`, applied in order inside one transaction under an advisory lock, each recorded with its checksum. Running them again applies only the new ones, and refuses to continue if an applied file has changed. Run them before starting a new version of the API and workers.

From a checkout with the env file loaded:

```sh
pnpm build
pnpm db:migrate
```

From the image:

```sh
docker run --rm --env-file ledger.env --env-file ledger-owner.env --user 1000:1000 --entrypoint node ledger:local packages/persistence/dist/migrate.js
```

`node packages/persistence/dist/migrate.js` was run for this guide from the image, through `docker compose run`, against an empty database with `LEDGER_ENV=staging`, and again after a restore, where it applied nothing.

Never run `pnpm db:seed` on a deployment. The seeds create the fictional organizations and their development tokens, and refuse to run when `LEDGER_ENV=staging` or `NODE_ENV=production`.

## 6. Sign-in

People sign in through OpenID Connect, with any provider that implements it: one you run yourself, such as Keycloak, or a hosted one. Ledger has no passwords of its own and names no provider in its code. Nothing in this section needs an account with anyone else.

### How sign-in works

- **The web app** signs a person in with the authorization code flow and PKCE, as a public client: it holds no secret. It sends the person to the provider, checks the answer belongs to the sign-in it started (state and nonce), and keeps the tokens in memory only. Reloading the page returns to the sign-in screen; the provider's own session usually lets the person straight back in with one click. Where the provider issues a refresh token, the web app renews the session quietly before the ID token expires; otherwise the person returns to the sign-in screen when it does.
- **The web app learns where to sign in from the API.** Before anyone signs in it reads `GET /v1/sign-in`: the deployment's name, each issuer, its client id and the provider's endpoints. Nothing about sign-in is built into the web app, so one build serves any deployment.
- **The API** accepts the person's ID token as a bearer token. It verifies the signature against the provider's published keys (discovered from the issuer, cached, and fetched again when a token names a key it does not know, at most once every 30 seconds), the issuer, the audience (the client id), the expiry and the not-before time, with 30 seconds of clock tolerance. Only asymmetric signatures (RS, PS, ES and EdDSA) are accepted: `none` and shared-secret (HS) tokens are refused. A token from an issuer that is not configured is refused without contacting anyone. A verified token resolves to the Ledger person tied to that issuer and subject; a token for an account no one is tied to, or for a deactivated person, is refused.
- **Other credentials.** A service token (`ledger-service-…`) is accepted for a source or service, never for a person; an administrator issues, lists and revokes one on the People screen under **Sources and services**, or issues the first with `pnpm credential:issue` (see [Sources and services](#sources-and-services)). Development tokens (`ledger-dev-…`) are refused unless `LEDGER_ENV` is `local` or `test`. On a local or test database an administrator issues one to any person on the People screen, so several people can try Ledger on one computer; with `LEDGER_ENV=staging` that is refused, and every person signs in through the provider as this section describes. Development tokens are for a trial on a computer that faces no network, never for real use by several people.

**Signing needs a fresh sign-in.** Signing a risk acceptance or a controlled document requires the person to have signed in at the provider within the last five minutes. The web app's **Confirm it's you** opens the provider in a separate window with `max_age=0` and `prompt=login`, so the provider asks for the person's credentials again; the API then checks the ID token's `auth_time` claim. Allow pop-up windows for the web app's address. **A provider that does not put `auth_time` in its ID tokens cannot satisfy this: no one can sign there.** Check it before you rely on it (see the last step of the example below).

### What to create at your provider

Whatever the provider calls them, Ledger needs:

1. **A client for the web app**: OpenID Connect, authorization code flow ("standard flow"), **public** (no client secret, no client authentication), **PKCE required with S256**. Turn off the implicit flow and password ("direct access") grants; Ledger uses neither.
2. **Redirect URI**: the web app's address with a trailing slash, for example `https://ledger.example.org/`. Allow the same address as the post-logout redirect URI, so **Sign out** returns to Ledger.
3. **Allowed web origin (CORS)** for the token endpoint: the web app's origin, for example `https://ledger.example.org`. The browser calls the token endpoint directly.
4. **ID tokens** that carry `iss`, `sub`, `aud` (the client id), `exp` and `auth_time`, signed with an asymmetric algorithm. If they carry `azp`, it must be the client id, unless the provider puts the web app's origin there; then set `LEDGER_OIDC_CHECK_AUTHORIZED_PARTY=true`.
5. **Accounts only for your people.** Turn off self-registration. An account at the provider gives no access on its own: a person must also be added in Ledger and tied to it.
6. **https** for the issuer and its discovery document (`<issuer>/.well-known/openid-configuration`), its keys and its endpoints. The API fetches the discovery document and keys from the server it runs on, so the issuer's address must resolve there too; browsers use the authorization and token endpoints.

The ID token's lifetime decides how often the session is renewed; five to fifteen minutes is usual. Refresh tokens, if the provider issues them to a public client, keep people signed in across renewals.

### Environment variables

The API and `pnpm org:create` read these. The web app reads nothing about sign-in at build time.

| Variable | What it is for |
| --- | --- |
| `LEDGER_OIDC_ISSUER` | The issuer, exactly as it appears in the `iss` claim, for example `https://id.example.org/realms/ledger`. Required with `LEDGER_ENV=staging`: the API refuses to start without an issuer. |
| `LEDGER_OIDC_CLIENT_ID` | The web app's client id. Every accepted ID token must carry it as its audience. |
| `LEDGER_OIDC_LABEL` | Optional. What the sign-in and People screens call the provider. Defaults to the issuer's host name. |
| `LEDGER_OIDC_CHECK_AUTHORIZED_PARTY` | Optional, `true` or unset. Requires an `azp` claim naming the client id or one of the web app's origins in `CORS_ORIGINS`. Only for a provider that sets `azp` to the origin. |
| `LEDGER_OIDC_ISSUERS` | Instead of the four above, several issuers as a JSON list: `[{"issuer":"https://id.example.org/realms/ledger","clientId":"ledger-web","label":"Example ID"},{"issuer":"…","clientId":"…","checkAuthorizedParty":true}]`. Set one or the other, not both. |
| `LEDGER_DEPLOYMENT_NAME` | Optional. The name the sign-in screen shows, for example your organization's. Defaults to `Ledger`. |
| `CORS_ORIGINS` | The web app's origins (see [section 4](#4-environment-variables)). The API takes requests only from them. |

The issuer, its discovery document, its keys and its endpoints must be `https` URLs. Plain `http` is accepted only for `localhost`, `127.0.0.1` or `[::1]`, and only with `LEDGER_ENV` `local` or `test`. A setting the API cannot use stops it at startup with a message saying which.

With several issuers, the sign-in screen offers one button for each, and the People screen asks which one a person signs in through.

### How a person is tied to their account

Each Ledger person holds at most one sign-in account: an issuer and a subject. The subject is the `sub` claim of the ID tokens the provider issues for that person, usually its internal user id (in Keycloak, the user's **ID**, a UUID, not their username). Ledger stores the pair with the person and never returns it in a read; the People screen shows only whether an account is tied. One account can be tied to only one person.

- **The first administrator** is tied by `pnpm org:create --sign-in-issuer <issuer> --sign-in-subject <subject>` ([step 7](#7-create-your-organization)). The issuer must be exactly one the API is configured with: `org:create` reads the same variables and refuses any other issuer, naming the variable to set, so the administrator is never tied to an account that could not sign in.
- **Everyone else** is tied on the People screen when they are added: create the person's account at the provider first, then enter its subject in **Sign-in account (subject)**. With more than one issuer configured, choose it under **Signs in through**. The API refuses an issuer it is not configured with.
- An account is tied when the person is added. To change a person's account, deactivate them and add them again.
- A person who signs in at the provider with an account tied to no one is refused, and the sign-in screen shows them that account: the issuer and the subject of their own token, nothing about anyone else, with a sentence saying what the administrator does with them (add the person with exactly those values, or deactivate an entry tied to another account and add them again). The API answers `401` `sign_in_account_not_tied` with the two values in `details`. An account tied to someone, active or not, is refused as before.

### Example: Keycloak, self-hosted

This example runs Keycloak beside Ledger with the `keycloak` profile of `infra/compose.production.yaml`, behind the `proxy` profile's Caddy. It uses three names: `ledger.example.org` (the web app, which the image serves with the API), `ledger-api.example.org` (the API, the same container, for the command-line client and adapters) and `id.example.org` (Keycloak). It was run for this guide with Keycloak 26.4.0, as listed in [What was run](#what-was-run-for-this-guide), with `.localhost` names on one computer; `infra/verify-deployment` repeats it. Setting names follow the Keycloak 26 admin console.

**1. Run Keycloak.** Put in `ledger.env`:

```sh
KEYCLOAK_URL=https://id.example.org
KEYCLOAK_DB_PASSWORD=<a long random password>
KEYCLOAK_BOOTSTRAP_PASSWORD=<another>
```

and start it with `docker compose --env-file ledger.env -f infra/compose.production.yaml --profile keycloak up -d --wait`. Keycloak keeps its own PostgreSQL (`keycloak-db`), apart from Ledger's; back it up too ([section 9](#9-backups-and-restoring)): it holds the user IDs Ledger ties people to. The proxy passes `X-Forwarded-*` headers, which Keycloak reads (`KC_PROXY_HEADERS=xforwarded`). Sign in to `https://id.example.org/admin` with `bootstrap-admin`, create a permanent administrator for yourself, and delete the bootstrap account (**unverified**: the run signed in to the realm, not to the admin console).

**2. Create the realm and the client.** Import them from a file: an operator's coding agent can write it, and nothing in it is secret. Save as `keycloak/ledger-realm.json` at the checkout's root, with your web app's address:

```json
{
  "realm": "ledger",
  "enabled": true,
  "registrationAllowed": false,
  "clients": [
    {
      "clientId": "ledger-web",
      "protocol": "openid-connect",
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "implicitFlowEnabled": false,
      "redirectUris": ["https://ledger.example.org/"],
      "webOrigins": ["https://ledger.example.org"],
      "attributes": {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "https://ledger.example.org/"
      }
    }
  ]
}
```

and import it once, with Keycloak stopped (run for this guide: Keycloak printed `Realm 'ledger' imported` and served the realm after it started again):

```sh
docker compose --env-file ledger.env -f infra/compose.production.yaml --profile keycloak stop keycloak
docker compose --env-file ledger.env -f infra/compose.production.yaml --profile keycloak run --rm \
  -v "$PWD/keycloak:/opt/keycloak/data/import:ro" keycloak import --file /opt/keycloak/data/import/ledger-realm.json
docker compose --env-file ledger.env -f infra/compose.production.yaml --profile keycloak up -d --wait keycloak
```

The same settings in the admin console (**unverified** by clicking; they are what the file sets): **Create realm** `ledger`; **Realm settings → Login**, **User registration** off; **Clients → Create client**, OpenID Connect, **Client ID** `ledger-web`, **Client authentication** off, **Standard flow** on, **Direct access grants** and **Implicit flow** off, **Valid redirect URIs** and **Valid post logout redirect URIs** `https://ledger.example.org/`, **Web origins** `https://ledger.example.org`, and under **Advanced**, **Proof Key for Code Exchange Code Challenge Method** `S256`. Keep the realm's default RS256 key.

Keycloak 26.4.0 puts `aud` and `azp` (both the client id) and `auth_time` in its ID tokens with the default client scopes, issues them for five minutes, and honours `max_age=0` and `prompt=login` by asking for the password again: all checked in the run.

**3. Create each person's account.** A person with the Keycloak administrator's account does this, because it sets a password: **Users → Add user** (username, email, first and last name, **Email verified** on), then **Credentials → Set password** (**Temporary** on, so the person chooses their own at first sign-in). Copy the user's **ID** from **Details**: that UUID, not the username, is the subject Ledger ties the person to. (The run created its two people from the realm file, with fixed IDs.)

**4. Configure Ledger.** Add to `ledger.env`:

```sh
LEDGER_OIDC_ISSUER=https://id.example.org/realms/ledger
LEDGER_OIDC_CLIENT_ID=ledger-web
LEDGER_OIDC_LABEL=Example ID
LEDGER_DEPLOYMENT_NAME=Example Aerial Survey
CORS_ORIGINS=https://ledger.example.org
```

Restart Ledger. `curl https://ledger-api.example.org/v1/sign-in` lists the issuer with its `authorizationEndpoint`, `tokenEndpoint` and `endSessionEndpoint`. An issuer listed without them means the API could not read `https://id.example.org/realms/ledger/.well-known/openid-configuration` from where it runs: the name must resolve from inside the container to the proxy, the certificate must be one Node trusts (a certificate from a private authority needs `NODE_EXTRA_CA_CERTS` pointing at that authority's certificate in the container), and the document must name exactly this issuer (`KEYCLOAK_URL` and the proxy headers).

**5. Create the organization**, tied to the administrator's account:

```sh
docker compose --env-file ledger.env --env-file ledger-owner.env -f infra/compose.production.yaml run --rm --no-deps \
  setup apps/api/dist/create-organization.js \
  --name "Example Aerial Survey" --time-zone America/Denver --admin "Avery Example" \
  --sign-in-issuer https://id.example.org/realms/ledger --sign-in-subject <the administrator's Keycloak user ID>
```

**6. Sign in and check signing.** Open `https://ledger.example.org`: the sign-in screen shows "Example Aerial Survey" and **Sign in**, which goes to Keycloak. Sign in with the administrator's account. On **People**, add a person with their Keycloak user ID in **Sign-in account (subject)**; they then sign in with their own account. Before relying on signatures, have someone with authority to adopt documents draft and review the safety policy, choose **Review and sign adoption** and **Confirm it’s you**: a window opens at Keycloak, which asks for the password again even though the person is signed in there. The signed record (under **Decisions and signature**) shows `"reauthentication": {"method": "openid_connect", ...}` with the time of that sign-in. If Ledger says the provider does not say when you signed in, the ID token has no `auth_time`: check that the client's **Client scopes** include `basic`, which carries it.

### Google Workspace as the identity provider

**Unverified**: no Google account was available. Written from Google's [OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) page.

**Google cannot be Ledger's provider directly.** Google's documented token exchange authenticates the client with its client secret (`client_secret`, from the Cloud Console **Clients** page), and Ledger's web app is a public client that holds no secret. Google's sign-in also lists only `none`, `consent` and `select_account` for `prompt` (not `login`), and puts `auth_time` in an ID token only when it is asked for with the `claims` parameter and enabled in its settings, so **Confirm it’s you** would not make anyone enter a password again.

Use Keycloak as Ledger's provider, as in [the example above](#example-keycloak-self-hosted), and let it send people on to Google:

1. In the Google Cloud Console, on **Clients**, **Create client**, of type web application, with the redirect URI Keycloak shows for the Google identity provider (`https://id.example.org/realms/ledger/broker/google/endpoint`). Copy its client ID and secret; set up the consent screen on **Branding**. (A person with the Workspace administrator's account does this.)
2. In Keycloak, **Identity providers → Google**, with that client ID and secret, and **Hosted domain** set to your Workspace domain, so only your organization's accounts are accepted (Google's `hd` claim).
3. Each person signs in once through **Sign in with Google** on Keycloak's page, which creates their Keycloak user. The subject Ledger ties them to is that Keycloak user's **ID**, as in step 3 of the example; not Google's `sub`, which Keycloak keeps for itself.

The environment variables are Keycloak's, as in step 4 of the example. Whether Keycloak, asked by **Confirm it’s you** for a fresh sign-in, sends a person through Google's password again was not checked: try it before relying on signatures.

### Microsoft Entra ID as the identity provider

**Unverified**: no Entra tenant was available. Written from Microsoft's pages on [OpenID Connect](https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc), [the authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [ID token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference) and [optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference).

Entra supports what Ledger's web app does: the authorization code flow with PKCE for a single-page application, with no secret, and `prompt=login`. What to create, in the [Microsoft Entra admin center](https://entra.microsoft.com) (a person with an administrator's account there does this):

1. **Entra ID → App registrations → New registration**, for *Accounts in this organizational directory only*. Copy the **Application (client) ID** and the **Directory (tenant) ID** from **Overview**.
2. **Authentication → Add a platform → Single-page application**, redirect URI `https://ledger.example.org/`. The platform must be single-page application: only its redirect URIs may redeem a code from a browser without a secret. Leave the implicit grant's boxes off. Add `https://ledger.example.org/` as a front-channel or post-logout redirect if the page offers it, so **Sign out** returns to Ledger.
3. **Token configuration → Add optional claim → ID → `auth_time`**. Without it no one can sign: Entra's v2.0 ID tokens carry `auth_time` only as an optional claim.
4. Each person's account is their Entra user.

The environment variables:

```sh
LEDGER_OIDC_ISSUER=https://login.microsoftonline.com/<Directory (tenant) ID>/v2.0
LEDGER_OIDC_CLIENT_ID=<Application (client) ID>
LEDGER_OIDC_LABEL=Microsoft
```

**The subject is not the Object ID.** Ledger ties a person to the ID token's `sub`. Entra's `sub` is different for every application: it is computed for this one application, user and tenant, so it differs from the user's **Object ID** (`oid`) that the admin center shows, and from the `sub` any other application sees. No admin center page shows it. To find a person's subject, have them sign in to Ledger once: the sign-in is refused, because no one is tied to the account yet, and the ID token the browser received carries their `sub` (in the browser's developer tools, the `Authorization` header of the refused request, decoded). This is why the first administrator's subject is hard to learn before `org:create`; an organization starting on Entra may find Keycloak in front of Entra (**Identity providers → OpenID Connect v1.0** in Keycloak) easier, with Keycloak user IDs as subjects.

ID tokens from Entra's v2.0 endpoint carry `aud` (the client ID) and no `azp`, so leave `LEDGER_OIDC_CHECK_AUTHORIZED_PARTY` unset. Refresh tokens issued to a single-page application expire after 24 hours; the person then signs in again, usually with one click.

### Try it locally with the test issuer

The repository has a small OpenID Connect issuer for tests and local development, in `tests/oidc`. It signs in a named test person without any password, so it must never face a network. It refuses to start with `NODE_ENV=production` and is not part of the container image. To try the whole sign-in on a local stack instead of development tokens:

```sh
pnpm test-issuer        # http://127.0.0.1:4010, client ledger-local; leave it running
```

Then set `LEDGER_OIDC_ISSUER=http://127.0.0.1:4010` and `LEDGER_OIDC_CLIENT_ID=ledger-local` in `.env` (the lines are in `.env.example`), restart `pnpm dev`, and tie an administrator to the test person `test-administrator`:

```sh
pnpm org:create --name "Fictional Test Survey" --time-zone America/Denver --admin "Test Administrator" \
  --sign-in-issuer http://127.0.0.1:4010 --sign-in-subject test-administrator
```

The local sign-in screen keeps its development people and adds **Sign in through 127.0.0.1:4010**; the test issuer then asks which test person signs in (`test-administrator` or `test-person`). Add a person on **People** with the subject `test-person` to try a second sign-in. `tests/integration/openid-connect.integration.test.ts` runs the same flow against it, and `tests/browser/openid-connect.spec.ts` runs it in a browser when `LEDGER_BROWSER_TEST_ISSUER` is set.

## 7. Create your organization

`pnpm org:create` creates one organization with its name and time zone, its worker, and its first administrator, on a migrated database. It connects with `DATABASE_ADMIN_URL`, as migrations do, because the organization has no one yet who could act through the API. It seeds nothing fictional.

```sh
pnpm org:create --name "Example Aerial Survey" --time-zone America/Denver --admin "Avery Example" \
  --sign-in-issuer https://id.example.org/realms/ledger --sign-in-subject 6f1c2a9e-8d41-4b7e-9c0a-2f5d3e7b1a64
```

From the image:

```sh
docker run --rm --env-file ledger.env --env-file ledger-owner.env --user 1000:1000 --entrypoint node ledger:local apps/api/dist/create-organization.js \
  --name "Example Aerial Survey" --time-zone America/Denver --admin "Avery Example" \
  --sign-in-issuer https://id.example.org/realms/ledger --sign-in-subject 6f1c2a9e-8d41-4b7e-9c0a-2f5d3e7b1a64
```

- `--time-zone` is an IANA name. Every screen shows times in it, with its short name (for example `MT`).
- `--id` sets the organization's short id; by default it is made from the name (`tenant-example-aerial-survey` above).
- The administrator may manage people and their authority, adopt rule packs, keep operator records and the safety records. They are not given authority to accept risk or to read protected safety reports: grant those to named people, the administrator included, on the People screen.
- Running it again with the same name (or `--id`) says the organization exists and changes nothing. A different name creates a second organization.
- With `LEDGER_ENV=staging` the sign-in pair is required. On a local or test database without it, the administrator gets a development token instead, printed once.

It prints exactly how the administrator signs in. The built script (`node apps/api/dist/create-organization.js`) was run for this guide against an empty migrated database with `LEDGER_ENV=staging`, twice.

### Your first day

[Set up Ledger for your organization](set-up-your-organization.md) is the full walk for the organization's own people: adding aircraft, pilots and flights as records, adopting rules, bringing your own waiver and procedures as a rule pack, and reading coverage. In short:

1. The administrator opens the web app and signs in with their account at the deployment's OpenID Connect provider.
2. **People**: add each person with their name and kind, start from a role (Dispatcher, Pilot, Safety manager, Administrator, Reader) and adjust what they may do, and give their sign-in account: the subject (`sub`) of their account at the provider. Changing what someone may do, deactivating them and reactivating them are recorded with who did it and are never deleted.
3. **Rules**: adopt the rule packs your organization works under.
4. **Records**: import your operator records (training, aircraft time and others) from CSV or JSON.
5. **Safety**: open Safety from the top bar. Its home lists what is on file and what is not: who may sign to adopt a risk matrix and documents, who holds each of the three risk acceptance authorities (low, medium and high), the risk matrix in force and who may accept each of its levels, the safety policy in force, and who records safety reports as received and is cleared to read them, with the reporting links in force. Each missing item names the one action that starts it and who may take it. The list reports what is on file; it never says a program is complete.
   - **Authority** is granted on the People screen: *Sign to adopt a risk matrix and documents*, *Accept low / medium / high risk* (higher covers lower; these are the three authorities a level of your matrix can ask for, whatever your levels are called), *Read safety reports, including who reported* and *Read restricted attachments*. Each takes effect at once; the Safety screens pick it up within a few seconds.
   - **Risk matrix**: a person who may configure safety records chooses *Start a risk matrix*. It opens on the standard 5 × 5 form in neutral wording, with three levels; rename it, edit each severity and likelihood and what it means, and set your own levels: two to six, least to most serious, each with its name, what it means for you and who may accept a risk at it (the holders of the low, medium or high acceptance authority, or nobody, for a level such as "stop the operation"). A later level never needs less authority than an earlier one. Pick the level each cell is at, then save it as a draft. A risk at a level nobody may accept is recorded as assessed and can be accepted by no one until it is reassessed with further controls ([Risk levels](../design/risk-levels.md)). A person with adoption authority reviews the whole grid and signs it; only then is it in force and hazards can be assessed on it. A later change is *Revise the matrix* on its page: a new draft version, signed again, while the signed version stays in force.
   - **Safety policy**: *Draft a safety policy* opens the document form with the type set. Review the revision, have it signed, issue it to named readers; each reader acknowledges it personally.
   - **Safety reports**: a person who writes safety records and is cleared to read reports records each report as received under *Safety reports*: how it came in, what was reported and, if given, who reported. Only cleared people can open a report's account and reporter; everyone else sees that a report was received. Each reading is retained, and the content is withheld from every export.
   - **Reports people submit themselves**: anyone signed in can choose *Report a safety concern* in the top bar, on any screen, and send what they saw, when and where, with their name on it only if they tick *Put my name on this report*. A person who may configure safety records issues a **reporting link** under *Safety reports* (a label, and an expiry if you want one); the link opens a page at `/report` that needs no sign-in. Copy the link when it is shown: Ledger keeps only a hash of it and cannot show it again. Revoke it there at once if it is passed to the wrong people. A link takes at most 20 reports an hour. Each reporter is shown a receipt code once, with which the page at `/report` tells them only whether the report is received or closed. Every submitted report is stored as sent by the organization's *Safety reporting channel*, not by a person: nothing Ledger keeps (the record, the journal, the receipt, its request log, any export) names a person who sent a report without their name, and nothing keeps the address or browser of anyone using a link. [What submitting a safety report keeps](../design/report-submission.md) lists every place in full. The Safety home names the links in force.
   - **What Ledger cannot keep out of other logs is yours to configure.** A reverse proxy, load balancer or TLS terminator in front of Ledger usually logs the address, user agent and time of every request. Configure it not to log them for `/report`, `/v1/safety-reports`, `/v1/safety-reports/receipt` and `/v1/safety-report-links/submissions`; the link's token is never in a path, so it is not in such a log. Leave PostgreSQL's statement logging with parameters off, or it logs report text. A reporter's own browser keeps the link in its history, and where you publish the link is your choice.

The same path, from `org:create` through adding a dispatcher and a pilot to adopting a pack and importing records, runs in `tests/integration/organization-setup.integration.test.ts`. The safety path, from `org:create` alone through drafting and adopting a matrix, accepting a risk under granted authority, issuing and acknowledging a policy and recording and reading a report, runs in `tests/integration/first-day-safety.integration.test.ts`, and in the browser in `tests/browser/first-day-safety.spec.ts`.

#### What needs code

These ship with Ledger. Whether a new organization can use each from the screens alone:

- **Control type *Described measure***: yes. Propose it on a hazard, rely on it in an assessment and accept the risk with it in place. A person reads it; nothing checks it automatically.
- **Control type *Operating limit***: it can be proposed and accepted on a hazard, choosing an observation type and field by title. It is checked against observations of that type (battery state, wind, position and the others the deployment registers). Those reach Ledger only from a source: an adapter for your aircraft, flight log or weather service. Add the source and issue its credential on the People screen, then run its adapter ([section 10](#10-connect-a-source-run-an-adapter)); a system no shipped adapter reads needs an adapter written for it.
- **Control type *Route avoidance area***: it can be proposed and accepted on a hazard with the map editor. It is checked when a mission's planned route is reviewed, and missions come from flights. Flights reach Ledger from an order source; the only one that ships is the order emulator for the fictional organizations. Using it needs an order adapter.
- **Indicators** (command-link losses per flight hour, low-reserve landings per 100 flights, battery reserve exceedances per flight hour, operating area excursions per flight hour, crew assignments outside duty and rest limits per 100 duty periods, and the three wind indicators): each counts findings of a shipped example pack's rule over reported flights or duty periods. A new organization can adopt those packs on the Rules screen, but the counts stay empty until an adapter reports the flights and observations the rules read. The *Try this accepted control* simulation on a control's page belongs to the fictional organizations and is not shown to others.

### Sources and services

A source is a system that reports to Ledger: an adapter that turns a vendor's messages into observations, an import job, a monitor. A service is any other system that calls the API. Each one is a principal of the organization with its own authority, added on the **People** screen with the kind "A source that reports to Ledger" or "A service", and each calls the API with a credential:

- On the **People** screen, under **Sources and services**, an administrator (anyone who may manage people) issues a credential to an active source or service with a label saying what it is for, and optionally a time after which it is no longer accepted.
- The secret is shown once, when it is issued. Ledger keeps only its SHA-256 hash: it is in no read, log or journal entry, and no one can see it again. Copy it into the source's own configuration; the source sends it as `Authorization: Bearer <secret>`.
- The list shows each credential's label, who issued it and when, its expiry and whether it was revoked; never the secret. Ledger does not yet record when a credential was last used.
- **Revoke** refuses the credential from the next request on. An expired credential is refused the same way, and so is every credential of a deactivated source or service.
- Issuing and revoking are recorded commands, with who did it and the authority they held at that moment.

The first credential of a fresh deployment can be issued before anyone has signed in, on the owner connection as `pnpm org:create` uses, and recorded under the organization's first administrator (or the administrator named with `--by`). With `--add` it adds the source or service first:

```sh
pnpm credential:issue --organization tenant-example-aerial-survey --for "Dock adapter" --label "Adapter on the hangar host" \
  --add source --capability input:write --grant dock-telemetry:position.fix
```

From the image:

```sh
docker run --rm --env-file ledger.env --env-file ledger-owner.env --user 1000:1000 --entrypoint node ledger:local apps/api/dist/issue-credential.js \
  --organization tenant-example-aerial-survey --for "Dock adapter" --label "Adapter on the hangar host"
```

It prints the secret once (run for this guide from the image, through `docker compose run`, with `--add source`). The same path, with issuing, listing, revoking, expiry and one organization kept from another's credentials, runs in `tests/integration/credentials.integration.test.ts`.

## The message broker

Only sources that report over MQTT need one. Run Mosquitto 2.0 as its own service. Its accounts and access rules come from your sources on record: `pnpm broker:files` reads them on the owner connection and writes the broker's files.

```sh
pnpm broker:files --out /srv/ledger/broker
```

- `mosquitto.conf` gives each organization its own listener: its own port, password file and access file. The listener's `mount_point` puts the organization's id in front of every topic, so a source publishes and subscribes only to its own organization's topics and never sees another's. With one organization in the database it listens on 1883; with more, name each one that uses the broker: `--listen tenant-example-aerial-survey=1883`.
- Each active source gets one account, named by its id; the command prints each id beside the source's name. A source new since the last run gets a random password, printed once; a password already in the folder is kept. A deactivated source loses its account.
- Inside its listener a source uses topic names as they are, so a device whose topics its vendor fixes (a DJI dock publishes `thing/product/<serial>/osd`) and the adapter that reads them connect to their organization's port and need no prefix.
- The files are written readable by their owner only. The broker reads them as its own user (UID 1883 in the `eclipse-mosquitto` image): `chown -R 1883:1883 /srv/ledger/broker` on a Linux server. Run for this guide on Docker Desktop for Mac, where a folder shared into a container keeps its owner whatever `chown` does: Mosquitto 2.0.22 warned that the files' owner is not `mosquitto` ("Future versions will refuse to load this file") and loaded them.

Run it again after you add, deactivate or reactivate a source, then restart the broker. With `infra/compose.production.yaml`, write the files into `broker/` at the checkout's root and start the broker with `docker compose --env-file ledger.env -f infra/compose.production.yaml --profile broker up -d`; publish each port the command gave an organization. From the image, where the checkout has no build:

```sh
docker compose --env-file ledger.env --env-file ledger-owner.env -f infra/compose.production.yaml run --rm --no-deps \
  -v "$PWD/broker:/broker" setup apps/api/dist/write-broker-files.js --out /broker
```

(the folder must be writable by UID 1000). Both were run for this guide: the broker accepted each source's account with the password printed once and refused a wrong one.

The broker's accounts are separate from the source's API credential: Mosquitto checks its own PBKDF2 password hashes and cannot check Ledger's. A source that both reads the broker and reports to Ledger holds both.

## Your own rule packs in the deployment

The organization's waiver and manual, built as pack files with `pnpm pack:build` ([Write a rule pack](write-a-rule-pack.md)), go in `packs/` at the checkout's root. `infra/compose.production.yaml` mounts that folder into the `ledger` service, read-only, at `/packs`, and sets `LEDGER_PACKS_DIR=/packs`, so the API and the workers in it both read the same files. An empty folder adds nothing: Ledger offers its built-in packs only.

1. Build each pack file into the folder from the organization's own files, kept outside the checkout or in its git-ignored `organization/` folder: `pnpm pack:build organization/waiver --out packs`. The files must be readable by the container's user (`chmod 644 packs/*.pack.json`); the folder is read only, never written.
2. Restart Ledger, which reads the folder only when it starts: `./ledger-compose.sh restart ledger`, then wait for `/readyz`.
3. Check it is offered: `pnpm ledger packs list` shows the pack with "your file" and its file name. If Ledger refuses a file it does not start, and `./ledger-compose.sh logs ledger` names the file and why.
4. Prepare the adoption as on a local Ledger, `pnpm ledger packs adopt <pack> ...` without `--reason`, and give it to the person who adopts.

A corrected version is a new file beside the old one (raise `version` in `pack.yaml` and build again); keep the old file in the folder, since the adoptions that named it still read it, then restart. `node infra/verify-deployment/verify.mjs all` places the example waiver's pack file in the folder mounted there and checks that it is offered and that its adoption prints.

## Notices by email and webhook

Ledger tells a person by email when a finding or an action is assigned to them, when an action of theirs is due within three days, once when it becomes overdue, and when a document waits for their acknowledgement; and, if they ask for one, sends a daily or weekly digest of all of it. An organization can also have every one of these but the digest posted to a webhook of its own. Both are off until you configure them. [docs/design/notices.md](../design/notices.md) describes the outbox behind them.

### Email

Set, for the API and the workers both:

| Variable | What it is for |
| --- | --- |
| `LEDGER_SMTP_HOST` | Your mail server or relay. Setting it turns email on. |
| `LEDGER_SMTP_PORT` | Its port; default 587, or 465 with `LEDGER_SMTP_SECURE=1`. |
| `LEDGER_SMTP_SECURE` | `1` for a server that speaks TLS from the first byte (port 465). Otherwise TLS is used when the server offers it. |
| `LEDGER_SMTP_USER`, `LEDGER_SMTP_PASSWORD` | The account notices are sent with, when the server asks for one. Both or neither. |
| `LEDGER_SMTP_FROM` | The address notices are sent from, such as `ledger@example.org`. Required. |
| `LEDGER_PUBLIC_URL` | The address people open Ledger at. Required: with a mail server and no public address the API and the workers refuse to start and say so. |

A notice is plain text: the organization's name, what happened in one sentence, the record's reference and title, the due date in the organization's time zone, and a link to the record. It holds no tracking and no images. A safety report, or any record whose confidentiality is not ordinary, is named by its reference and link only. Each person keeps their address and chooses which notices arrive under their name in the bar; an administrator can also set a person's address on the **People** screen, which says beside each person who has none and so gets no email.

### Webhook

An administrator sets the organization's webhook on **People**, **Notices sent**, **Webhook**: an https address (an http address is accepted only with `LEDGER_ENV=local`). Ledger makes a secret and shows it once; setting the webhook again makes a new one. Each notice is one `POST` with a JSON body:

```json
{
  "version": "ledger.notice.1",
  "id": "a notice id",
  "createdAt": "2026-11-25T14:00:00.000Z",
  "kind": "assigned",
  "event": "finding.assigned",
  "organization": { "id": "your organization id", "name": "Example Ridge Survey" },
  "assigneeId": "person-…",
  "sentence": "Avery Example assigned a finding to a person.",
  "record": { "label": "Finding", "id": "…", "reference": "…", "title": "…", "path": "/rules/findings/…", "url": "https://ledger.example.org/rules/findings/…" },
  "actionId": null,
  "dueOn": null,
  "dueAt": null,
  "timeZone": "America/Denver"
}
```

`kind` is `assigned`, `due`, `overdue` or `acknowledgement`. The person is named by `assigneeId`, their id in Ledger, never by email address. `title` is null for a safety report or a restricted record. `url` is null when `LEDGER_PUBLIC_URL` is unset.

Each call carries two headers: `Ledger-Timestamp`, the time of the call in seconds since 1970, and `Ledger-Signature`, `sha256=` followed by the HMAC-SHA256, in hex, of the timestamp, a full stop and the exact body, keyed with the secret. Check the signature over the raw bytes before parsing, and refuse a timestamp more than five minutes old. In Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, headers, rawBody) {
  const timestamp = headers['ledger-timestamp'];
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const given = String(headers['ledger-signature'] ?? '');
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  return fresh && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

Answer with any 2xx status within 10 seconds. Ledger does not follow redirects.

### What is sent, and what is not

Every notice and every attempt to send it is on record. **People**, **Notices sent** lists them, newest first, with their state: waiting, sent, failed with the reason (it is tried again after 1 minute, 5 minutes, 30 minutes and 2 hours) or given up after the fifth attempt. Nothing that causes a notice waits for it or fails because of it. A notice is recorded once; in the rare case that a worker sends one and stops before recording it, the next worker sends it again. To see where notices stand from the database, with the owner connection:

```sql
SELECT a.outcome, count(*) FROM notices n LEFT JOIN LATERAL (SELECT outcome FROM notice_attempts x
  WHERE x.notice_id=n.id ORDER BY attempt DESC LIMIT 1) a ON true GROUP BY a.outcome;
```

On a local stack, `pnpm dev` starts stand-ins for both: `.env.example` points `LEDGER_SMTP_HOST` at the emulators' mail server stand-in on port 4025, and `http://127.0.0.1:4002/_notices/webhook` receives webhook calls. Open `http://127.0.0.1:4002/_notices` to see what arrived. A recipient at `refused.example`, or a webhook address ending in `?status=500`, shows a failing server.

## 8. Health checks

- `GET /healthz` answers `{"status":"ok",...}` without touching the database: use it for liveness.
- `GET /readyz` answers `{"status":"ready","role":"ledger_app"}` only when the database answers and the API is connected as the non-owner `ledger_app` role; otherwise 503. Use it for readiness and to gate traffic.
- The workers have no HTTP endpoint. They log one JSON line per piece of work and log `Worker database operation failed` with a database error code when a pass fails. Watch for a worker process exiting, and for work that stays pending; with the owner connection:

  ```sql
  SELECT state, count(*) FROM work_items GROUP BY state;
  ```

## 9. Backups and restoring

A backup is Ledger's database and its original files together (the bucket, or the folder of [Files on disk](#files-on-disk)), and the identity provider's database if you run one: Keycloak holds the user IDs people are tied to, and a person whose Keycloak user is recreated gets a new ID and can no longer sign in. Everything below was run for this guide against the deployment in [What was run](#what-was-run-for-this-guide), holding an organization, imported records with their original files, an adoption and its evaluations, and a signed and issued document; `node infra/verify-deployment/verify.mjs backup` and `restore` repeat it. That run used PostgreSQL with PostGIS; it was not repeated with the plain `postgres:17-alpine` image, nor with files on disk.

### Take a backup

`infra/backup.mjs` takes the whole backup and checks it. Run it from the checkout's root, with Ledger running:

```sh
S3_ENDPOINT=http://127.0.0.1:8333 node --env-file=ledger.env infra/backup.mjs
```

It writes a new folder under `backups/`, named by the time it started (`backups/2026-11-24T021500Z`), with Ledger's database (`ledger.dump`), Keycloak's (`keycloak.dump`) and the bucket (`objects/` and `objects.json`), in that order, through `./ledger-compose.sh`. Then it checks what it wrote: each dump's table of contents reads back with `pg_restore --list`, every object's SHA-256 matches the one Ledger stored with it, and every object the dumped database names is in the copy with the SHA-256 the database holds for it. It prints one line of JSON and writes the same as `backup.json` in the folder: `"status":"complete"`, or `"status":"failed"` with the reason, and exits 1. `--without-keycloak` leaves out Keycloak's database for an identity provider of another kind; `--folder` writes elsewhere; `--compose` names another wrapper of `docker compose`. `node infra/verify-deployment/verify.mjs backup` runs this script and `restore` restores what it wrote.

**Every night.** The schedule line, for the server administrator's crontab (`crontab -e`), runs it at 02:15 server time and appends each run's line to `backups/backup.log`; replace `/srv/ledger` with the checkout's path and `/usr/bin/node` with the output of `command -v node`:

```text
15 2 * * * cd /srv/ledger && S3_ENDPOINT=http://127.0.0.1:8333 /usr/bin/node --env-file=ledger.env infra/backup.mjs >> backups/backup.log 2>&1
```

To see that it ran: `tail -n 1 backups/backup.log` shows the last night's line, which says `"status":"complete"` and its `finishedAt` time; `ls backups` lists one folder per night. A night with no new line did not run (cron also mails the administrator any output it could not write). The line itself is **unverified**: the script was run for this guide, by `verify.mjs`, but not from cron. Each folder holds everything a restore needs; copying the folders off the server, and removing old ones there, is the person's decision ([step 12](#the-smallest-deployment)).

The same backup by hand, in this order:

```sh
mkdir -p backups/$(date +%F) && cd backups/$(date +%F)
docker compose --env-file ../../ledger.env --env-file ../../ledger-owner.env -f ../../infra/compose.production.yaml --profile database \
  exec -T postgres pg_dump -U ledger_owner --format=custom ledger > ledger.dump
docker compose --env-file ../../ledger.env --env-file ../../ledger-owner.env -f ../../infra/compose.production.yaml --profile keycloak \
  exec -T keycloak-db pg_dump -U keycloak --format=custom keycloak > keycloak.dump
cd ../.. && S3_ENDPOINT=http://127.0.0.1:8333 node --env-file=ledger.env infra/verify-deployment/copy-bucket.mjs download backups/$(date +%F)
```

With a database of your own, `pg_dump --format=custom --file=ledger.dump "$DATABASE_ADMIN_URL"` does the same. `copy-bucket.mjs` reads the same `S3_*` settings as Ledger, checks every object against the SHA-256 Ledger stored with it, and writes `objects/` and `objects.json`; `aws s3 sync` or `rclone copy` copy the bucket as well, without that check (**unverified** here). Copy the folder off the server.

**Why this order.** `pg_dump` reads one consistent snapshot of the database. Ledger stores an upload's bytes before it commits the rows that name them, and never changes or deletes an object, so a bucket copied after the dump holds every object the dump refers to. Copied first, the bucket could miss objects of rows the dump then includes.

### Files on disk in the backup

With the files in a folder ([Files on disk](#files-on-disk)) the backup is the same three things in the same order, the dump first and the folder after it, for the same reason: Ledger writes a file before it commits the rows that name it and never changes or removes one, so a folder copied after the dump holds every file the dump names. Give `infra/backup.mjs` the folder inside the `ledger` service in place of the bucket settings, with a wrapper of `docker compose` for the Lite file, `ledger-lite-compose.sh` at the checkout's root (`chmod 700`):

```sh
#!/bin/sh
exec docker compose --env-file ledger.env --env-file ledger-owner.env -f infra/compose.lite.yaml "$@"
```

```sh
node infra/backup.mjs --files /data/ledger/files --without-keycloak --compose ./ledger-lite-compose.sh
```

It dumps the database, copies the folder out of the running `ledger` service with `tar` into `objects/`, lists every file with its SHA-256 in `objects.json`, and checks, as for a bucket, that every object the dump names is there with the SHA-256 the database holds for it. A server without Docker copies the folder itself (`rsync -a` or `cp -a`) after `pg_dump` and keeps the two together. **Unverified**: not run for this guide (the Lite file was not brought up); the check of digests against the dump is the same code as for a bucket.

To restore, restore the dump first as in the steps below, then put the files back into the empty volume before Ledger starts, owned by the image's user:

```sh
tar -C backups/<date>/objects -cf - . | ./ledger-lite-compose.sh run --rm --no-deps -T --user root --entrypoint sh ledger \
  -c 'mkdir -p /data/ledger/files && tar -C /data/ledger/files -xf - && chown -R 1000:1000 /data/ledger && chmod 700 /data/ledger /data/ledger/files'
```

Then start Ledger and check what came back as in step 7 below: records produced with `--originals` verify offline only if every original is back with its digest. **Unverified**, as above.

**Work in flight.** Nothing needs to stop for a backup. What the dump does not hold is lost on restore: anything committed after `pg_dump` began, including uploads a person or a source was told were received. Their bytes may be in the bucket copy, unreferenced, which is harmless. Work the workers had not finished (`work_items` still `pending` or `leased` in the dump) is done again after the restore: a lease lasts at most five minutes and expired leases are taken again. An upload started but not finished expires after 24 hours as it would have. A person signed in keeps their ID token until it expires; restoring Keycloak's database restores their accounts and IDs, not their sessions.

### Restore into empty containers

`pg_dump` does not include roles. On a new server, or after removing the containers and their volumes:

1. Start the empty database, Keycloak's database and the store: `./ledger-compose.sh up -d --wait postgres keycloak-db objects`.
2. Create Ledger's two roles, with the attributes the first migration gives them and the passwords in `ledger.env`:

   ```sh
   ./ledger-compose.sh exec -T postgres psql -v ON_ERROR_STOP=1 -U ledger_owner -d ledger -c \
     "CREATE ROLE ledger_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '<app password>';
      CREATE ROLE ledger_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS PASSWORD '<worker password>';
      GRANT ledger_app TO ledger_worker;"
   ```

   The last line matters: the migrations make `ledger_worker` a member of `ledger_app`, and a dump does not carry role memberships. Without it the restored Ledger starts and reads, but the workers fail with `permission denied` (`Worker database operation failed { code: '42501' }`) and new work stays pending; the run for this guide found this.

   With a database of your own, first create the owner role and an empty database.
3. Restore both dumps, as their owners, each into an empty database. Drop and create the one each image started with, so nothing in it meets what the dump creates:

   ```sh
   ./ledger-compose.sh exec -T postgres psql -U ledger_owner -d postgres -c 'DROP DATABASE ledger' -c 'CREATE DATABASE ledger'
   ./ledger-compose.sh exec -T keycloak-db psql -U keycloak -d postgres -c 'DROP DATABASE keycloak' -c 'CREATE DATABASE keycloak'
   ./ledger-compose.sh exec -T postgres pg_restore -U ledger_owner -d ledger --exit-on-error < backups/<date>/ledger.dump
   ./ledger-compose.sh exec -T keycloak-db pg_restore -U keycloak -d keycloak --exit-on-error < backups/<date>/keycloak.dump
   ```

4. Create the bucket and copy the objects back: `./ledger-compose.sh exec objects sh -c 'echo "s3.bucket.create -name ledger" | weed shell'`, then `S3_ENDPOINT=http://127.0.0.1:8333 node --env-file=ledger.env infra/verify-deployment/copy-bucket.mjs upload backups/<date>`. It writes each object only if absent, so it never replaces stored bytes.
5. Run the migrations ([section 5](#5-run-the-migrations)): they apply nothing new and check every applied checksum.
6. Start Keycloak, the proxy and Ledger: `./ledger-compose.sh up -d --wait keycloak proxy ledger`, and check `/readyz`.
7. Check what came back:
   - people sign in with their own accounts;
   - the records read as before: `pnpm ledger records list <type> --json`, `pnpm ledger coverage --json` and `pnpm ledger people list --json`, compared with the same taken before the backup;
   - the journal's hash chains verify, with the same stream heads as before the backup:

     ```sh
     ./ledger-compose.sh exec -T postgres psql -U ledger_owner -d ledger -At \
       -c "$(node infra/verify-deployment/journal-chain.mjs --query)" | node infra/verify-deployment/journal-chain.mjs
     ```

   - records produced now verify offline, originals included: `pnpm ledger records produce --reason "Restore drill" --requested-by "<who>" --out drill.zip --originals`, then the `record-production-cli.mjs` command it prints ([Verify an export](verify-an-export.md)).

Restore drills belong on a schedule.

## 10. Connect a source: run an adapter

An adapter turns a source's messages into observations, the facts the rules read: an aircraft's reported positions, a dock's measured wind, the airspace service's authorizations, a weather station's published reports and forecasts, published flight restrictions. The adapter process runs one adapter for one source. It receives the source's messages over the source's own transport (a subscription to the message broker for the aircraft and dock adapters, reading the service on an interval for the airspace authorization, weather and flight restriction adapters), translates each one with the adapter exactly as it is registered in `packages/adapters`, and submits it through the public API with its original bytes, signed in with the credential an administrator issued for that source. It writes nothing to the database and is given no database setting. The production start never runs one unless you ask (`tests/unit/production-start.test.ts` checks this).

Run one process per source and adapter: an aircraft whose positions and battery you both want is two processes.

| Adapter | Reads | Produces | Bound by |
| --- | --- | --- | --- |
| `dji-cloud-api-osd-position` | the aircraft's periodic state message on `thing/product/<aircraft serial>/osd` | `position.fix` | `--device`, `--gateway` |
| `dji-cloud-api-osd-battery` | the same message | `battery.state` | `--device`, `--gateway` |
| `dji-cloud-api-dock-wind` | the dock's periodic property message on `thing/product/<dock serial>/osd` | `weather.wind` | `--dock`, `--site`, `--dock-model` |
| `airspace-link-laanc-authorization` | `GET /v1/operations/<operation>/laanc` on the airspace service | `airspace.authorization` | `--operation`, `--flight` |
| `published-metar-observations` | `GET /api/data/metar?ids=<stations>&format=json` on the Aviation Weather Center data API, a public service | `weather.wind`, `weather.visibility` | `--stations` |
| `published-taf-forecasts` | `GET /api/data/taf?ids=<stations>&format=json` on the same service | `weather.forecast` | `--stations` |
| `published-flight-restrictions` | `GET /tfrapi/exportTfrList` on the FAA TFR service (tfr.faa.gov), a public service, then each listed `GET /download/detail_<year>_<number>.xml` | `airspace.restriction` | `--regions` |

`pnpm adapter:run --help`, or any mistake in its settings, prints every flag and the environment variable that can give it instead (listed in `.env.example`). Secrets come from the environment only: `LEDGER_API_CREDENTIAL`, `ADAPTER_BROKER_PASSWORD`, `ADAPTER_SERVICE_TOKEN` and `ADAPTER_SERVICE_API_KEY`. A flag that looks like one is refused. The weather and flight restriction services are public: they take no secret, and the process sends them only the station ids (or nothing, for the restriction list) and a user agent naming the program (`ledger-adapter-host`), nothing about the organization.

### How far each adapter has been checked

Every shipped adapter but three is at fidelity `synthetic_contract`: built from the source's documentation and run against the emulators in `apps/emulators` only. None of those has read a message from a real aircraft, dock or airspace service. The weather report, forecast and flight restriction adapters are at `captured_source_replay`: their golden files hold answers fetched from the live services, and they were built against them. The process prints the fidelity, the adapter's version and its limitations when it starts, and every observation carries them. Before you rely on one, check it against your own equipment:

**Aircraft position** (`dji-cloud-api-osd-position`)

- **Which height your aircraft reports.** The adapter reads `height` as height above the WGS84 ellipsoid, as the documentation states it. With the aircraft on its pad, compare the reported height with the pad's ellipsoid height (its elevation above mean sea level plus the geoid separation there). If it reads near zero, your aircraft reports height above the takeoff point and the adapter mislabels it. Either way, the height rules never compare an ellipsoid height with a limit above ground level: they name it, count it and rest on the plan.
- The speed: fly a steady, known ground speed and compare `groundSpeedMetersPerSecond` (the adapter reads the documented meters per second as they are).
- The clock: each observation's time is the aircraft's own clock. Compare it with the time the log says a message arrived.
- The serials: `--device` is the aircraft's serial in its topic, `--gateway` the dock or controller the message names. A message naming another gateway is refused and logged.
- No fix quality is reported (`fix: unknown`), and a gap between positions does not show that messages were lost.

**Aircraft battery** (`dji-cloud-api-osd-battery`)

- Compare the reported total and per-pack percentages with the controller's display, on the ground and once in flight.
- Check which of the landing and return-to-home reserve levels your model reports; the adapter carries only what the message holds.

**Dock wind** (`dji-cloud-api-dock-wind`)

- Name the model with `--dock-model` (`dock2`, `dock3` or `dock4`): the message does not say which dock sent it. The first-generation dock's wind is refused, because its two official sources disagree on the scale.
- The wind is the dock's own sensor, at the dock's height and place, in meters per second with no averaging period and no gusts. Compare it with a hand anemometer beside the dock.
- `--site` is the site the dock stands at; the observation is about that site.

**Airspace authorization** (`airspace-link-laanc-authorization`)

- It was checked against the service's published schema and its emulator, not against the service's sandbox. Run it against the sandbox first.
- `ADAPTER_SERVICE_TOKEN` is an access token the service issued to a person who signed in. It expires (the emulator's expire after an hour); when the service refuses it the process stops and says so. Getting a fresh one is yours to arrange: the process does not sign in or refresh tokens.
- `--operation` is the service's operation id; `--flight` the Ledger flight it was requested for. Each change of the operation's authorizations becomes one observation per authorization; reading the same response again changes nothing.
- The ceiling is the record's altitude, stated in feet above ground level and converted; a polygon with holes keeps only its outer boundary. Compare one authorization in Ledger with the service's own screen.
- Read no more often than the service's rate limits allow (`--poll-seconds`, default 60).

**Published weather reports** (`published-metar-observations`)

- **What was checked.** On 2026-11-25 the service's OpenAPI document (version v4.0, pinned by digest in the adapter's descriptor) was read, and three requests fetched the current and recent reports of 28 large public airports in the United States, Europe and Asia, 210 reports in all. The adapter was built against those bytes: its golden files in `packages/adapters/src/golden/published-metar-observations/` are 13 of those reports exactly as the service sent them (wind in knots and in meters per second, gusts, calm, a variable direction and a direction range, AUTO and COR reports, a SPECI, visibility in whole and mixed-fraction statute miles, in metres, 9999 and CAVOK), and 6 constructed cases for forms the fetch did not contain (NIL, a missing wind, `M1/4SM`) and for refusals. The emulator serves 68 of the fetched reports in the service's shape at `/api/data/metar` on port 4002. The same report fetched twice, 80 seconds apart, came back byte for byte the same.
- **What was not checked.** A poll running for hours or days; the service's rate limit (100 requests a minute, by its documentation) or what it answers when a client exceeds it; an outage, a 5xx answer or a slow answer; a report from a station outside those 28; the forms the fetch did not contain, which only unit tests and constructed cases exercise (`KMH`, `P6SM`, `0000`, `NDV`, a missing visibility, NIL, `M1/4SM`). Forecasts and flight restrictions are read by their own adapters, below.
- `--stations` maps each station to the organization's sites: `KORD=<site>@14.2km;KMDW=<site>`. The station is not the site: every observation names the station and the distance you give, or says that no distance is on record. Nothing picks the nearest station or interpolates between two. A report from a station you did not name is refused.
- The values are the report text's: the service's own decoded fields beside it are not read, and they differ from the text for reports in meters per second, which the service converts to knots. The time is the report's day, hour and minute, with month and year from the fetch.
- Visibility is the prevailing visibility, a bound for `9999`, CAVOK, `M` and `P`. A report from the United States states 10 statute miles at most. No rule shipped today reads a `weather.visibility` observation: the visibility rules read what a preflight assessment or the flight record states.
- It reads every five minutes by default (`--poll-seconds`): stations report about once an hour, and specially between. Each answer is cut into its reports, and only the reports the previous answer did not hold are handed over, so a report is submitted once; a restart submits the current reports again under the same idempotency keys, which changes nothing.
- Each report becomes one `weather.wind` and one `weather.visibility` observation per configured site, about that site, with the station's position. Each names the station in `stationId`, and the distance you give in `stationDistanceMeters`. Give the source's credential a grant for both types.
- **How old a report a rule reads.** A rule that reads the wind at takeoff reads the latest report at or before the takeoff only when it is at most 90 minutes older than the takeoff, unless the rule states another greatest age. An older report is not read: the result says when it was reported, how long before the takeoff, by which station, and that none within the limit is on file. A wind the site's own sensor measured (it names no station) keeps no such limit unless the rule states one.

  ```sh
  pnpm adapter:run published-metar-observations --api-url https://ledger.example.org \
    --credential-label "Weather reports on the hangar host" \
    --service-url https://aviationweather.gov --stations "KORD=RIDGE-SITE-1@14.2km"
  ```

**Published weather forecasts** (`published-taf-forecasts`)

- **What was checked.** On 2026-11-26 the service's OpenAPI document was read again (the same digest as the day before), and two requests fetched the current forecasts of 24 large public airports in North and South America, Europe, Asia, the Middle East and Australia. The adapter was built against those bytes: 9 of them are golden files in `packages/adapters/src/golden/published-taf-forecasts/` exactly as the service sent them (from groups, gusts, a variable wind, wind in meters per second, visibility in metres, in whole and mixed-fraction statute miles, `P6SM` and CAVOK, temporary, becoming, probability and probability-temporary groups, amended forecasts, wind shear and remark groups), and 8 are constructed cases (NIL, CNL, a group it cannot read, refusals). For every one of the 24, the validity, the issue time and each period's start, end and wind speed were compared with the values the service decodes beside the text; they agreed except where the service treats a becoming group as lasting to the next change, which the adapter does not (it keeps each group's own period). The emulator serves all 24 at `/api/data/taf`.
- **What was not checked.** A poll running for hours or days; the rate limit; an outage; a forecast crossing the end of a month (only unit tests place one); a correction (COR); forms the fetch did not contain.
- A forecast is a `weather.forecast` record of what was forecast and when: its issue time, the time it covers, and each period with the wind and visibility it states. It is never written as `weather.wind` or `weather.visibility`, so no rule about measured weather reads one. Cloud, weather, wind shear and temperature groups stay in each period's text and in the retained original.
- `--stations` is the weather report adapter's: the station is not the site, and every forecast names the station and the distance you give. It reads every 15 minutes by default: forecasts are issued about every six hours and amended between. Each forecast, and each amendment, is kept; a newer one does not replace an older one. Give the credential a grant for `weather.forecast`.
- No shipped rule reads a forecast.

  ```sh
  pnpm adapter:run published-taf-forecasts --api-url https://ledger.example.org \
    --credential-label "Weather forecasts on the hangar host" \
    --service-url https://aviationweather.gov --stations "KORD=RIDGE-SITE-1@14.2km"
  ```

**Published temporary flight restrictions** (`published-flight-restrictions`)

- **What exists without an account.** The FAA publishes, with no account and no key, a JSON list of the temporary flight restrictions in effect or scheduled (`/tfrapi/exportTfrList`: the notice id, a type, the center, the state and a description, but no times, altitudes or area) and, for each, a detail document (`/download/detail_<year>_<number>.xml`) holding the notice id, the issue, effective and expiry times, each area's floor, ceiling and schedule, and each area's boundary as a list of corners. The adapter reads both. No published description of the detail document was found.
- **What was checked.** On 2026-11-26 the list (50 entries) and nine detail documents were fetched: security, hazard, VIP, air show and public-gathering restrictions, one with three areas at different times, two with a daily schedule, one with no expiry, two that publish no boundary. For each, the times the adapter reads were compared with the times written in the notice's own text in the same document: the document writes them without a time zone, and they are UTC. That comparison, and a run of the adapter's tests over all nine documents, were done on the unedited documents before anything was committed, and agreed. Six of the nine are committed, and they are not byte for byte what the service sent: contact names, contact organizations, telephone numbers and contact radio frequencies were replaced with neutral values, and the names of agencies other than the FAA and of a company's venue with a neutral description; three that named a police department, a federal agency or a company were left out, since the six kept cover every shape the adapter reads. Everything the adapter reads (identifier, times, altitudes, areas) is as published on 2026-11-26. Five of the six are golden files in `packages/adapters/src/golden/published-flight-restrictions/`, with five constructed refusals; the emulator serves the six and their list entries.
- **What was not checked.** A poll running for hours or days; the service's rate limits; an outage; a restriction that changes its detail document without changing its list entry (read again only when the entry changes, or after a restart); schedules other than daily; an altitude given as a flight level (reported as not read); restrictions whose boundary is published other than as corners.
- `--regions` names circles around the organization's sites: `RIDGE-AREA-1=RIDGE-SITE-1@39.97,-86.13,5km`. Each restriction area whose published boundary touches a circle becomes one `airspace.restriction` observation about that circle's site, naming the region. Whether a boundary touches a circle is computed by the adapter, on a flat projection centered on the circle (radius at most 100 km). The operating areas recorded in Ledger are not read by the adapter: give it circles that hold them. A restriction that touches no circle is not recorded and its document is not kept.
- What a restriction restricts and allows (its instructions and exceptions) is in its text, kept in the retained document; Ledger records that it is on file, not whether a flight may be made. A restriction the authority withdraws stays on file as published.
- It reads the list every 10 minutes by default and reads each new entry's document once. Give the credential a grant for `airspace.restriction`. No shipped rule reads a restriction.

  ```sh
  pnpm adapter:run published-flight-restrictions --api-url https://ledger.example.org \
    --credential-label "Flight restrictions on the hangar host" \
    --service-url https://tfr.faa.gov --regions "RIDGE-AREA-1=RIDGE-SITE-1@39.97,-86.13,5km"
  ```

**NOTAMs** (not built)

- The FAA's NOTAM service (its NOTAM API) issues a client id and secret to a registered account, and its documentation is published on the account portal; no description of its response format was found without an account. No adapter or emulator was built from memory. An operator with an account who wants one would compare: the response's notice identifier, its effective and expiry times and their zone, the location and area fields, the altitudes and their reference, how a cancelled or replaced notice is shown, and paging. Temporary flight restrictions, which are NOTAMs, are read from the public restriction service above.

### Add the source, its credential and its broker account

1. Add the source and issue its credential, as in [Sources and services](#sources-and-services). It needs `input:write` and an observation grant for each type its adapter produces, under the source id its observations will carry:

   ```sh
   pnpm credential:issue --organization tenant-example-aerial-survey --for "Hangar dock aircraft" \
     --label "Position adapter on the hangar host" \
     --add source --capability input:write --grant hangar-aircraft:position.fix
   ```

   Keep the label: the process names it when Ledger refuses the credential, and it is how you find the credential to revoke on the People screen.

2. For an aircraft or dock adapter, give the source its broker account: run `pnpm broker:files` again and restart the broker, as in [The message broker](#the-message-broker). The account is the source's id, which the command prints beside its name, with the password it prints once. The aircraft or dock itself publishes with an account of its own: add it as another source (it needs no API credential), so revoking one does not cut off the other.

### Start it

The same settings work in every form. On a host with a checkout (the process was run for this guide against the emulated airspace service and an API in the integration suite, and by hand against a local Mosquitto broker loaded with the files `pnpm broker:files` wrote: it signed in with an issued credential, subscribed with the source's broker account, submitted the aircraft messages published to it and stopped cleanly; it has not read a message from real equipment):

```sh
export LEDGER_API_CREDENTIAL='<the secret>' ADAPTER_BROKER_PASSWORD='<the broker password>'
pnpm adapter:run dji-cloud-api-osd-position --api-url https://ledger.example.org \
  --credential-label "Position adapter on the hangar host" \
  --broker-url mqtts://broker.example.org:8883 --broker-username <source id> \
  --device <aircraft serial> --gateway <dock serial>
```

As its own container from the image. Put the settings and secrets in `adapter.env` (`LEDGER_ADAPTER`, `LEDGER_API_URL`, `LEDGER_API_CREDENTIAL`, `LEDGER_CREDENTIAL_LABEL`, `ADAPTER_*`), then:

```sh
docker run -d --name ledger-adapter-hangar --env-file adapter.env --restart unless-stopped ledger:local adapter
```

or, with `adapter.env` at the checkout's root, `docker compose --env-file ledger.env -f infra/compose.production.yaml --profile adapter up -d`. Run for this guide with the position adapter: it signed in with an issued credential, subscribed with its broker account, submitted the seven messages an aircraft account published to it, and on `docker stop` reported every message submitted. On the compose network the API is `http://ledger:4000` and the broker `mqtt://broker:1883`, which carry secrets without TLS: set `ADAPTER_PRIVATE_NETWORK=1` to allow that on a network you control. For a second source, copy the `adapter` service with its own env file.

Under the image's supervisor, beside the API and the workers (run for this guide: it signed in and subscribed after `runtime_dependencies_ready`): set `LEDGER_ADAPTER` and the adapter's settings in `ledger.env`. The supervisor starts it after the workers with only its own settings (the API defaults to the one in the same container), stops it first so it can submit what it holds, and keeps the API and workers running if it exits; its exit is logged as `adapter_exit`. One adapter runs this way; for more, run each as its own container.

### What its log shows

One JSON line per event on standard output, each with `at`, `adapter`, `event` and a `message` in words. A process that is working shows, in order:

```text
{"event":"starting","message":"dji-cloud-api-osd-position 1.0.0 reads DJI Cloud API (...). Fidelity synthetic_contract: built from the source’s documentation and run against an emulator only; not checked against your equipment or a live service.","limitations":[...]}
{"event":"signed_in","message":"Signed in to Example Aerial Survey as Hangar dock aircraft with the credential labelled \"Position adapter on the hangar host\"; submitting under the source id hangar-aircraft."}
{"event":"broker_subscribed","message":"Subscribed to thing/product/<aircraft serial>/osd as <source id>."}
{"event":"first_submitted","message":"Ledger accepted the first message: 1 observation(s), receipt receipt-..."}
{"event":"summary","message":"Received 60, submitted 60 (60 observations), translation refused 0, Ledger refused 0, dropped 0, queued 0."}
```

A summary follows every minute. The airspace, weather and flight restriction adapters show `polling` in place of `broker_subscribed`. No line carries a secret or a message's content. The other events:

- `ledger_unreachable`, `submission_failed_retrying`, `broker_disconnected`, `poll_failed_retrying`: it cannot reach Ledger, the broker or the service, and tries again, waiting longer each time up to a minute, with jitter. A payload is submitted again under the same idempotency keys, so a retry or a restart never records it twice.
- `queue_full_dropping_oldest`, then `queue_recovered` with the count: Ledger was unreachable long enough to fill the queue (`--queue-limit`, 10,000 messages). For positions, battery, wind and weather reports the oldest are dropped and counted. The airspace adapter drops nothing: it stops reading the service until there is room.
- `message_rejected`: the adapter will not translate a message (for example one naming another gateway), with the reason; logged once per reason per minute and counted in the summary.
- `payload_refused`: Ledger refused a payload as it is (its status and error code); it is not sent again.
- `cannot_start` or `stopping_on_refusal`: Ledger refused the credential (naming its label), the credential lacks a grant, the broker refused the account, or the service refused its token. The process exits with code 1: fix the cause and start it again. A restart loop will not.
- `stopping`, then `stopped`: on SIGTERM or SIGINT it stops receiving, submits what it holds for up to `--shutdown-seconds` (10), and exits 0, or 1 if any were left. Messages the broker had not yet delivered wait for the next start in the broker's session, for a day and up to the broker's queue limit (200 messages in the configuration `pnpm broker:files` writes).

Then open the flight in the web app: the adopted rules' results name the flown values and the authorization they read. The same path, from the emulated service and aircraft through the process to a Part 107 rule's result, runs in `apps/adapter-host/tests/adapter-process.integration.test.ts`; its case against a running local broker is skipped when none is reachable, and was skipped for this guide.

## What is not hardened

- **The emulators and the simulator** are development tools for a simulated flight operation. They are not hardened for exposure to a network and a production start never runs them. If you set `LEDGER_EMULATORS=1`, they listen on the container's loopback address only; do not publish port 4002.
- **The MQTT broker** that `pnpm broker:files` configures listens without TLS. Put it on a private network, or add a TLS listener to the generated configuration yourself (**unverified**: this guide gives no steps for it, and `pnpm broker:files` overwrites the file on each run, so a listener you add must be added again). Restart it after each run of the command.
- **Credentials** are not rate limited, and Ledger does not record when one was last used.
- **The API has no TLS and no rate limiting of its own** beyond bounded request sizes and connection limits, and the per-link limit on reports sent through a reporting link; put it behind a proxy that terminates TLS.
