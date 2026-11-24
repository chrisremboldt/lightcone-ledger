# MQTT broker

Mosquitto 2.0.22, for sources that report over MQTT (for example DJI Cloud API telemetry). Nothing here names an organization: the broker's accounts and access rules come from the sources on record.

`pnpm broker:files --out <folder>` writes three kinds of file from the database:

- `mosquitto.conf`: one listener for each organization that uses the broker, each with its own port, password file and access file (`per_listener_settings true`). The listener's `mount_point` puts the organization's id in front of every topic, so a source publishes and subscribes only to its own organization's topics, and never sees another's.
- `passwords-<organization id>`: one account for each active source of that organization, named by the source's id, in Mosquitto's own PBKDF2-SHA512 encoding. A password already in the folder is kept; a source new since the last run gets a random one, printed once.
- `acl-<organization id>`: each of those accounts may read and write under its listener.

Run it again after a source is added, deactivated or reactivated, then restart the broker. A deactivated source loses its account.

**Local:** `pnpm broker:files:dev` writes the files into `infra/mqtt/accounts` (git ignores them) from the seeded fictional sources, with the fixture password `<account>-password`, and listens for Alpha on 1883 and Beta on 1884. `infra/compose.yaml` mounts that folder; until the command has run, the broker starts with no accounts and refuses every connection.

**Deployment:** see [Deploy Ledger](../../docs/guides/deploy.md#the-message-broker).

**Isolated hosted staging:** the image can also run a broker inside the container for the fictional hosted world (`DJI_MQTT_ENABLED=1`, refused outside that one staging app); `infra/scripts/mqtt-runtime.mjs` generates its files from that app's own secrets. A deployment never uses it.
