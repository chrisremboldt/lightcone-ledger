import { runAdapterHost } from './host.js';

process.exitCode = await runAdapterHost(process.argv.slice(2), process.env);
