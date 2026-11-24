/// <reference types="vite/client" />

/** Absolute path of the fictional utility fixtures, for the local walkthrough guide. */
declare const __LEDGER_FIXTURES__: string;

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_DEV_AUTH?: string;
  readonly VITE_DEV_TOKEN?: string;
  readonly VITE_TENANT_ID?: string;
  readonly VITE_LEDGER_ENV?: string;
  readonly VITE_LEDGER_WALKTHROUGH?: string;
}
