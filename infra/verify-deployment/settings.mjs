// The verification's fixed names, ports and people. They match verify.env, Caddyfile and keycloak-realm.json.
export const urls = {
  web: 'https://ledger.localhost:18443/',
  api: 'https://ledger-api.localhost:18443',
  identityProvider: 'https://id.localhost:18443',
  issuer: 'https://id.localhost:18443/realms/ledger',
  objects: 'http://127.0.0.1:18333',
};

export const organization = { name: 'Example Ridge Survey', id: 'tenant-example-ridge-survey' };

/** Two people with accounts in the imported realm; each subject is the Keycloak user's ID. */
export const people = {
  administrator: {
    name: 'Avery Example',
    username: 'avery',
    password: 'avery-local-password',
    subject: '5d0a6c1e-7f3b-4c2a-9e81-0a4f2b6c8d10',
  },
  pilot: {
    name: 'Jordan Example',
    username: 'jordan',
    password: 'jordan-local-password',
    subject: '8b2e4f60-1c9d-4a7e-b3f2-6d5c0e9a1b20',
  },
};

export const storage = {
  bucket: 'ledger',
  accessKeyId: 'verify-access',
  secretAccessKey: 'verify-secret-verify-secret',
};
