import { runSmsRehearsalCli, type SmsRehearsalCliResult } from './sms-rehearsal-cli.js';

export type { SmsRehearsalCliResult } from './sms-rehearsal-cli.js';

export function prepareHostedSms(env: NodeJS.ProcessEnv = process.env): Promise<SmsRehearsalCliResult> {
  return runSmsRehearsalCli({ ...env }, Date.now, { hostedOnly: true, silent: true });
}
