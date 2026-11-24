import type {
  SimulationAvoidanceDemoConfig,
  SimulationAvoidanceDemoCycle,
  SimulationAvoidanceDemoPrepare,
  SimulationAvoidanceDemoProgress,
} from '../../../src/simulation-avoidance-demo.js';
import { missionAvoidanceIntersects } from './mission-avoidance.js';

export const simulationAvoidanceDemoConfig = {
  version: 'simulation.avoidance-demo-config.1',
  tenants: [
    {
      tenantId: 'tenant-alpha',
      source: {
        principalId: 'principal-alpha-source',
        missionSourceId: 'mission-planner',
        commandLinkSourceId: 'command-link',
        monitoringSourceId: 'operation-monitoring',
      },
    },
  ],
} satisfies SimulationAvoidanceDemoConfig;
const { hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance } =
  missionAvoidanceIntersects.candidates[0]!;
export const simulationAvoidanceDemoPrepare = {
  version: 'simulation.avoidance-prepare.1',
  control: { hazardId, controlId, controlVersion, controlEventId, controlDigest, acceptance },
  mode: 'initial',
  expectedPrincipalRevision: 3,
} satisfies SimulationAvoidanceDemoPrepare;
export const simulationAvoidanceDemoCycle = {
  version: 'simulation.avoidance-cycle.1',
  id: 'avoidance-demo:initial',
  control: simulationAvoidanceDemoPrepare.control,
  trigger: 'initial',
  previousCycleId: null,
  requestedAt: '2026-10-18T15:00:00.000Z',
  requestedBy: { id: 'human-operator', principalRevision: 3 },
  source: simulationAvoidanceDemoConfig.tenants[0]!.source,
} satisfies SimulationAvoidanceDemoCycle;
export const simulationAvoidanceDemoProgress = {
  version: 'simulation.avoidance-progress.1',
  expectedRevision: 0,
  phase: 'preparing',
  code: 'resources_pending',
  retryable: true,
  reason: 'Waiting for a free aircraft and flight person.',
  references: {},
} satisfies SimulationAvoidanceDemoProgress;
