/**
 * Registers the service worker that keeps the app's own files, so the app opens without a connection
 * (docs/design/offline-entry.md). A browser without service workers opens the app only with a connection, as before.
 */
export function registerAppShell(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .catch(() => undefined);
}
