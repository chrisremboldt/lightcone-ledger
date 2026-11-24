// A test that writes outside the public API may run only against a database named for tests, never a real one.
export function isTestDatabaseName(name: string | undefined): boolean {
  return Boolean(name?.startsWith('ledger_test'));
}

export function isTestDatabaseUrl(url: string | undefined): boolean {
  return Boolean(url) && isTestDatabaseName(decodeURIComponent(new URL(url!).pathname.slice(1)));
}
