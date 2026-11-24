export type LocalBrokerTenant = 'alpha' | 'beta';

/**
 * The development broker's listener for each seeded organization, as `pnpm broker:files:dev` writes them from the
 * seeded sources. A listener keeps its organization's topics apart, so each organization has its own port.
 */
export const LOCAL_BROKER_PORTS: Record<LocalBrokerTenant, number> = { alpha: 1883, beta: 1884 };

/** The seeded source's broker account, with the development password the same command gives it. */
export function localBrokerAccount(tenant: LocalBrokerTenant) {
  const username = `principal-${tenant}-source`;
  return { mqttUrl: `mqtt://127.0.0.1:${LOCAL_BROKER_PORTS[tenant]}`, username, password: `${username}-password` };
}
