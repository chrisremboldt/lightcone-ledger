import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { djiStagingScenarioConfig, runDjiScenario } from './dji-scenario.js';

export async function runDjiStagingScenario() {
  return runDjiScenario(djiStagingScenarioConfig());
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = djiStagingScenarioConfig(),
      report = await runDjiScenario(config);
    console.log(
      `Hosted fictional DJI MQTT scenario: ${report.status}; ${report.assertions.length} assertions. Evidence report: ${join(config.reportDirectory, 'evidence-report.json')}`,
    );
  } catch {
    console.error(
      'Hosted fictional DJI MQTT scenario failed; inspect configuration and the private evidence report if present.',
    );
    process.exitCode = 1;
  }
}
