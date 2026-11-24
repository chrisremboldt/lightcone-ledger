import { lstat, mkdir, chown, chmod, readFile } from 'node:fs/promises';
import { adapterEnvironment, runtimeDirectories } from './runtime-config.mjs';

async function directory(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe runtime directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path, { mode: 0o700 });
  }
}
try {
  const directories = runtimeDirectories();
  if (directories.length) {
    await directory('/data');
    const mounts = await readFile('/proc/self/mountinfo', 'utf8');
    if (mounts.length > 1048576 || !mounts.split('\n').some((line) => line.split(' ')[4] === '/data'))
      throw new Error('A persistent volume must be mounted at /data');
    // Allow the dropped user to traverse the mount without listing its root.
    if (process.getuid() === 0) await chmod('/data', 0o711);
    for (const path of directories) {
      await directory(path);
      if (process.getuid() === 0) await chown(path, 1000, 1000);
      await chmod(path, 0o700);
    }
  }
  if (process.getuid() === 0) {
    process.setgroups([]);
    process.setgid(1000);
    process.setuid(1000);
  }
  if (process.getuid() !== 1000 || process.getgid() !== 1000)
    throw new Error('Long-lived runtime requires UID/GID 1000');
  const mode = process.argv[2] ?? 'supervise';
  if (mode === 'supervise') {
    const { superviseRuntime } = await import('./supervise.mjs');
    process.exitCode = await superviseRuntime();
  } else if (mode === 'verify-mqtt') await import('./verify-mqtt-runtime.mjs');
  else if (mode === 'adapter') {
    // One adapter for one source, as its own container: docker run ... ledger:local adapter <adapter> [flags].
    const { runAdapterHost } = await import('../../apps/adapter-host/dist/host.js');
    process.exitCode = await runAdapterHost(process.argv.slice(3), adapterEnvironment());
  } else throw new Error('Unsupported runtime entrypoint');
} catch {
  console.error(JSON.stringify({ event: 'runtime_bootstrap_failed' }));
  process.exitCode = 1;
}
