export async function acquireControlLease(
  emulatorUrl: string,
  adminKey: string,
  owner: 'scenario' | 'trickle',
): Promise<{ headers(): Record<string, string>; release(): Promise<void> }> {
  const url = `${emulatorUrl}/_simulation/control-lease`;
  const baseHeaders = { 'x-emulator-admin': adminKey, 'content-type': 'application/json' };
  let acquired: Response | undefined;
  const deadline = Date.now() + 30_000;
  do {
    try {
      acquired = await fetch(url, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify({ owner }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  } while (!acquired);
  if (!acquired.ok)
    throw new Error(`Cannot acquire ${owner} emulator controls (${acquired.status}): ${await acquired.text()}`);
  const { leaseId } = (await acquired.json()) as { leaseId: string };
  if (!leaseId) throw new Error('Emulator did not return a simulator control lease');
  const ownedHeaders = { ...baseHeaders, 'x-simulator-lease': leaseId };
  let lost: Error | undefined;
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing || lost) return;
    renewing = true;
    try {
      const response = await fetch(url, { method: 'PUT', headers: ownedHeaders, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Emulator control renewal returned ${response.status}`);
    } catch (error) {
      lost = error instanceof Error ? error : new Error('Emulator control renewal failed');
    } finally {
      renewing = false;
    }
  }, 10_000);
  timer.unref();
  return {
    headers() {
      if (lost) throw lost;
      return ownedHeaders;
    },
    async release() {
      clearInterval(timer);
      try {
        await fetch(url, { method: 'DELETE', headers: ownedHeaders, signal: AbortSignal.timeout(5000) });
      } catch {}
    },
  };
}
