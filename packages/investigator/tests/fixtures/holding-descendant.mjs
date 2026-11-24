import { writeFile } from 'node:fs/promises';

process.on('SIGTERM', () => {});
await writeFile(process.argv[2], JSON.stringify({ pid: process.pid }));
setInterval(() => {}, 1000);
