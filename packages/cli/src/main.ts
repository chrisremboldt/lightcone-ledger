import { runCli } from './cli.js';

// pnpm runs the script from the checkout; a path, and .ledger/credentials, are read from where the command was typed.
const typedIn = process.env.INIT_CWD ?? process.cwd();
process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  folders: [...new Set([typedIn, process.cwd()])],
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
