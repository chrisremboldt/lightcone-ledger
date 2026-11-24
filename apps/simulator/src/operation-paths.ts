import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

async function identity(path: string): Promise<{ path: string; inode?: string }> {
  let existing = path;
  const remaining: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(existing);
      if (remaining.length) return { path: resolve(canonical, ...remaining) };
      const metadata = await stat(existing);
      return { path: canonical, inode: `${metadata.dev}:${metadata.ino}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      remaining.unshift(basename(existing));
      existing = parent;
    }
  }
}

export async function assertSeparateOperationPaths(paths: string[], worldPath: string): Promise<void> {
  const artifacts = paths.map((path) => resolve(path));
  const world = resolve(worldPath);
  const allPaths = [...artifacts, world, `${world}.pending`, `${world}.lock`];
  if (new Set(allPaths).size !== allPaths.length)
    throw new Error('Operation artifact and world transaction paths must remain separate');
  const trees = ['history', 'delivery', 'broker'].map((suffix) => `${world}.${suffix}`);
  const [identities, reserved] = await Promise.all([
    Promise.all(allPaths.map(identity)),
    Promise.all(trees.map(identity)),
  ]);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  const overlaps = (first: string, second: string) => contains(first, second) || contains(second, first);
  for (let index = 0; index < artifacts.length; index++)
    if (
      trees.some(
        (tree, treeIndex) =>
          overlaps(artifacts[index]!, tree) || overlaps(identities[index]!.path, reserved[treeIndex]!.path),
      )
    )
      throw new Error('Operation artifacts must remain outside world-owned history, delivery and broker trees');
  for (let index = 0; index < identities.length; index++) {
    const current = identities[index]!;
    if (
      identities
        .slice(0, index)
        .some(
          (previous) =>
            previous.path === current.path || (current.inode !== undefined && current.inode === previous.inode),
        )
    )
      throw new Error('Operation artifact and world transaction paths must not alias');
  }
}
