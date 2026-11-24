export const WORLD_STATE_PATH = '/data/ledger/world/operation.json';

export function simulatorRuntimeMode(env = process.env) {
  const mode = env.SIMULATOR_RUNTIME_MODE ?? (env.SIMULATOR_AUTORUN === '1' ? 'trickle' : 'off');
  if (!['off', 'trickle', 'world'].includes(mode))
    throw new Error('SIMULATOR_RUNTIME_MODE must be off, trickle or world');
  return mode;
}

/**
 * The emulators are development tools. They start only when LEDGER_EMULATORS=1 asks for them, or when a development
 * tool that drives them runs (the simulator, or the isolated staging telemetry broker). A production start, with none
 * of these set, runs the API and the workers only.
 */
export function emulatorsRequested(env = process.env) {
  if (env.LEDGER_EMULATORS !== undefined && !['0', '1'].includes(env.LEDGER_EMULATORS))
    throw new Error('LEDGER_EMULATORS must be 0 or 1');
  return env.LEDGER_EMULATORS === '1' || simulatorRuntimeMode(env) !== 'off' || env.DJI_MQTT_ENABLED === '1';
}

/** The variables that hold the database owner's connection, which only migrations and the setup commands use. */
export const OWNER_CONNECTION_VARIABLES = ['DATABASE_ADMIN_URL', 'LEDGER_DATABASE_OWNER_PASSWORD'];

/**
 * The owner-connection variables the supervisor was given where it must refuse them: outside local development and
 * tests (the image runs with LEDGER_ENV=staging). Empty when it may start.
 */
export function refusedOwnerConnection(env = process.env) {
  const ledgerEnv = env.LEDGER_ENV || (env.NODE_ENV === 'production' ? 'staging' : 'local');
  if (ledgerEnv === 'local' || ledgerEnv === 'test') return [];
  return OWNER_CONNECTION_VARIABLES.filter((name) => env[name]);
}

/** The environment without the owner connection: no process the supervisor starts is given it. */
export function withoutOwnerConnection(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !OWNER_CONNECTION_VARIABLES.includes(name)));
}

/** An adapter process starts only when LEDGER_ADAPTER names one: a production start runs none by default. */
export function adapterRequested(env = process.env) {
  return Boolean(env.LEDGER_ADAPTER?.trim());
}

/**
 * The adapter process's environment: its own settings and secrets, and the API on this host unless another is
 * named. It is not given the database, storage or sign-in settings: it reaches Ledger through the API only.
 */
export function adapterEnvironment(env = process.env) {
  const kept = Object.entries(env).filter(
    ([name]) =>
      /^(?:ADAPTER_|LEDGER_ADAPTER$|LEDGER_API_URL$|LEDGER_API_CREDENTIAL$|LEDGER_CREDENTIAL_LABEL$|LEDGER_SOURCE_ID$)/.test(
        name,
      ) || ['PATH', 'NODE_ENV', 'TZ'].includes(name),
  );
  return { LEDGER_API_URL: 'http://127.0.0.1:4000', ...Object.fromEntries(kept) };
}

/** The processes the supervisor starts, in order, for this environment. */
export function runtimePlan(env = process.env) {
  const mode = simulatorRuntimeMode(env);
  return [
    ...(env.DJI_MQTT_ENABLED === '1' ? ['mqtt'] : []),
    'api',
    ...(emulatorsRequested(env) ? ['emulators'] : []),
    'workers',
    ...(adapterRequested(env) ? ['adapter'] : []),
    ...(mode === 'trickle' ? ['simulator'] : mode === 'world' ? ['world-mqtt', 'world'] : []),
  ];
}

function worldDirectories(env) {
  const directories = ['/data/ledger', '/data/ledger/world'];
  if (env.SIMULATOR_WORLD_STATE === WORLD_STATE_PATH) {
    if (env.SIMULATOR_WORLD_SMS_PREPARATION !== undefined)
      throw new Error('The base world cannot use an SMS preparation');
    return { directories };
  }
  const live = /^\/data\/ledger\/world\/live\/([A-Za-z0-9_-]{1,100})\/world\.json$/.exec(
    env.SIMULATOR_WORLD_STATE ?? '',
  );
  if (live && live[0] === env.SIMULATOR_WORLD_STATE) {
    if (env.SIMULATOR_WORLD_RUN_ID !== live[1] || env.SIMULATOR_WORLD_SMS_PREPARATION !== undefined)
      throw new Error('Hosted ordinary state requires its exact run ID without an SMS preparation');
    return { directories: [...directories, '/data/ledger/world/live', `/data/ledger/world/live/${live[1]}`] };
  }
  const match = /^\/data\/ledger\/world\/sms\/([A-Za-z0-9-]{1,30})\/(incident|followup)\/world\.json$/.exec(
    env.SIMULATOR_WORLD_STATE ?? '',
  );
  if (!match || match[0] !== env.SIMULATOR_WORLD_STATE)
    throw new Error('Hosted world state must use a fixed private volume path');
  const [, rehearsalId, phase] = match;
  const rehearsalDirectory = `/data/ledger/world/sms/${rehearsalId}`;
  const phaseDirectory = `${rehearsalDirectory}/${phase}`;
  if (
    env.SIMULATOR_WORLD_RUN_ID !== `${rehearsalId}-${phase}` ||
    env.SIMULATOR_WORLD_SMS_PREPARATION !== `${phaseDirectory}/preparation.json`
  )
    throw new Error('Hosted SMS state requires its exact phase preparation and run ID');
  return {
    directories: [...directories, '/data/ledger/world/sms', rehearsalDirectory, phaseDirectory],
    phase,
  };
}

export function hostedWorldEnvironment(env = process.env) {
  const { phase } = worldDirectories(env);
  const world = { ...env };
  if (!phase) return world;
  delete world.SIMULATOR_WORLD_MONITORING_TOKEN;
  delete world.SIMULATOR_WORLD_DEPARTURE_TOKEN;
  const monitoring = env.SIMULATOR_WORLD_MONITORING_PLAN !== undefined;
  const departure = env.SIMULATOR_WORLD_DEPARTURE_PLAN !== undefined;
  if (phase !== 'followup' && (monitoring || departure))
    throw new Error('Hosted SMS monitoring and departure require the follow-up phase');
  function credential(name) {
    const value = env[name];
    if (typeof value !== 'string' || !value || value !== value.trim())
      throw new Error(`${name} is required for the hosted SMS phase`);
    return value;
  }
  if (monitoring) world.SIMULATOR_WORLD_MONITORING_TOKEN = credential('ALPHA_SOURCE_TOKEN');
  if (departure) world.SIMULATOR_WORLD_DEPARTURE_TOKEN = credential('ALPHA_ACTOR_TOKEN');
  return world;
}

export function runtimeDirectories(env = process.env) {
  const mode = simulatorRuntimeMode(env);
  const directories = [];
  if (env.DJI_MQTT_ENABLED === '1') {
    if (env.DJI_CHECKPOINT_DIR !== '/data/ledger/dji-checkpoints' || env.DJI_REPORT_DIR !== '/data/ledger/dji-reports')
      throw new Error('Runtime paths must use the fixed private volume directories');
    directories.push('/data/ledger', '/data/ledger/mqtt', env.DJI_CHECKPOINT_DIR, env.DJI_REPORT_DIR);
  }
  if (mode === 'world') {
    directories.push(...worldDirectories(env).directories);
  }
  return [...new Set(directories)];
}
