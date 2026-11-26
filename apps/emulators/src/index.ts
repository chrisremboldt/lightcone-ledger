import { pathToFileURL } from 'node:url';
import { createEmulator, emulatorConfig } from './server.js';
import { djiFlightPublisherFromEnv } from './dji.js';
import { missingAirspaceSchemas } from './schema.js';
import { createSmtpStandIn, NoticeInbox } from './notices.js';
export { createEmulator, emulatorConfig, type EmulatorOptions } from './server.js';
export { endpointSchemas, missingAirspaceSchemas, validatePayload } from './schema.js';
export {
  DjiOsdEmulator,
  djiDockOsdBytes,
  djiOsdBytes,
  djiFlightPublisher,
  djiFlightPublisherFromEnv,
  type DjiBatteryPack,
  type DjiBatteryReport,
  type DjiDockWeatherPoint,
  type DjiEmulatorConfig,
  type DjiWorldPoint,
} from './dji.js';
export {
  djiFaultScripts,
  planScriptedFlight,
  runScriptedFlight,
  validateFaultScript,
  type DjiFaultScript,
  type DjiFaultStep,
  type DjiFlightPublisher,
  type DjiScriptClock,
  type DjiScriptMessage,
  type DjiScriptPlan,
  type ScriptedFlight,
  type ScriptedFlightProgress,
} from './dji-fault-script.js';
export {
  djiDockWindScripts,
  planDockWind,
  validateDockWindScript,
  type DjiDockScriptClock,
  type DjiDockScriptMessage,
  type DjiDockWindPlan,
  type DjiDockWindScript,
  type DjiDockWindStep,
} from './dji-dock-wind-script.js';
export { qos1ReconnectFault } from './mqtt-fault.js';
export {
  createSmtpStandIn,
  handleNoticeRequest,
  NoticeInbox,
  REFUSED_MAIL_DOMAIN,
  type ReceivedCall,
  type ReceivedMail,
} from './notices.js';
export { answerMetarRequest, recordedMetarReports, RECORDED_METAR_FILE, type MetarAnswer } from './metar.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = emulatorConfig();
  const notices = new NoticeInbox();
  const { server } = createEmulator(config, { djiFlights: djiFlightPublisherFromEnv(process.env), notices });
  // The mail server stand-in for notices: point LEDGER_SMTP_HOST and LEDGER_SMTP_PORT at it.
  const smtpPort = Number(process.env.EMULATOR_SMTP_PORT ?? 4025);
  const smtp = createSmtpStandIn(notices);
  smtp.on('error', (error) => console.log(`The mail server stand-in did not start: ${error.message}`));
  smtp.listen(smtpPort, config.host);
  server.listen(config.port, config.host, () => {
    console.log(`Vendor emulators listening at http://${config.host}:${config.port} (fictional simulation)`);
    console.log(
      `Notices stand-ins: mail at smtp://${config.host}:${smtpPort}, webhook at http://${config.host}:${config.port}/_notices/webhook; see what arrived at http://${config.host}:${config.port}/_notices`,
    );
    if (missingAirspaceSchemas().length)
      console.log(
        'The Airspace Link emulator answers 503 until its schemas are downloaded: run pnpm vendor:airspace, then restart. Ledger itself does not need them.',
      );
  });
  const stop = () => {
    smtp.close();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
