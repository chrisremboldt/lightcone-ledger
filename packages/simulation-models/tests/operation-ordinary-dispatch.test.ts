import { describe, expect, it } from 'vitest';
import {
  activateOperationOrdinaryDispatch,
  advanceOperation,
  createOperation,
  enableOperationOrdinaryWork,
  operationDepartureResources,
  retireOperationOrdinaryFlight,
  claimOperationDemoResources,
  clearOperationDemoResources,
} from '../src/operation.js';

const start = Date.parse('2026-10-18T23:00:00.000Z');
const iso = (at: number) => new Date(at).toISOString();
function fresh(runId: string) {
  return createOperation({
    runId,
    start: iso(start),
    fleet: { alpha: 3, beta: 2 },
    demandIntervalMs: 150_000,
  });
}

describe('ordinary control-aware planning', () => {
  it('keeps demo resource priority tenant-local and resumes ordinary work after release or coordinator expiry', () => {
    const world = fresh('ordinary-demo-priority');
    enableOperationOrdinaryWork(world);
    activateOperationOrdinaryDispatch(world);
    for (let elapsed = 0; elapsed < 1_200_000; elapsed += 20_000) {
      claimOperationDemoResources(world, 'demo-cycle-alpha', 'alpha');
      advanceOperation(world, start + elapsed + 20_000);
    }
    expect(world.ordinaryDispatch!.flights.some((row) => row.tenant === 'alpha')).toBe(false);
    expect(world.ordinaryDispatch!.flights.some((row) => row.tenant === 'beta')).toBe(true);
    clearOperationDemoResources(world, 'another-cycle');
    expect(world.demoResourcePriority?.cycleId).toBe('demo-cycle-alpha');
    const expired = structuredClone(world);
    advanceOperation(expired, Date.parse(expired.demoResourcePriority!.expiresAt));
    expect(expired.demoResourcePriority).toBeUndefined();
    expect(expired.ordinaryDispatch!.flights.some((row) => row.tenant === 'alpha')).toBe(true);
    clearOperationDemoResources(world, 'demo-cycle-alpha');
    advanceOperation(world, world.now);
    expect(world.demoResourcePriority).toBeUndefined();
    expect(world.ordinaryDispatch!.flights.some((row) => row.tenant === 'alpha')).toBe(true);
  });

  it('activates on the retained ordinary world without changing airborne work or legacy capacity', () => {
    const world = fresh('ordinary-activation');
    advanceOperation(world, start);
    const config = structuredClone(world.config);
    const airborne = structuredClone(world.attempts);
    const existingEvents = structuredClone(world.events);
    expect(airborne.length).toBeGreaterThan(0);
    activateOperationOrdinaryDispatch(world);
    expect(world.config).toEqual(config);
    expect(world.resources).toBeUndefined();
    expect(world.attempts).toEqual(airborne);
    for (const event of existingEvents) expect(world.events).toContainEqual(event);
    const activation = structuredClone(world.ordinaryDispatch);
    activateOperationOrdinaryDispatch(world);
    expect(world.ordinaryDispatch).toEqual(activation);
    expect(world.ordinaryDispatch!.flights).toEqual([]);
  });

  it('publishes held missions five minutes early using real idle resources and the original promise', () => {
    const world = fresh('ordinary-planning');
    enableOperationOrdinaryWork(world);
    activateOperationOrdinaryDispatch(world);
    advanceOperation(world, start + 599_999);
    expect(world.reservations ?? []).toEqual([]);
    const request = structuredClone(world.demand.find((row) => row.tenant === 'alpha')!);
    advanceOperation(world, start + 600_000);
    const reservation = world.reservations!.find((row) => row.tenant === 'alpha')!;
    expect(reservation).toBeDefined();
    expect(reservation.plan.operatingInterval).toEqual(request.window);
    expect(reservation.plan.routePlanning!.customerInterval).toEqual(request.window);
    expect(reservation.plan.routePlanning!.resourceInterval).toEqual(request.window);
    expect(world.attempts).toEqual([]);
    expect(world.resources).toBeUndefined();
    expect(world.aircraft.find((row) => row.id === reservation.aircraftId)).toMatchObject({
      phase: 'reserved',
      attemptId: reservation.id,
      personId: reservation.personId,
    });
    expect(operationDepartureResources(world, reservation.id)!.flightPeople).toContainEqual({
      id: reservation.personId,
      tenant: reservation.tenant,
      availableAt: world.now,
      aircraftId: reservation.aircraftId,
    });
    expect(world.facts.filter((fact) => fact.attemptId === reservation.id && fact.kind === 'mission')).toHaveLength(1);
    expect(world.ordinaryDispatch!.flights).toContainEqual({
      version: 'operation.ordinary-flight.1',
      attemptId: reservation.id,
      tenant: reservation.tenant,
      aircraftId: reservation.aircraftId,
      registeredAt: iso(world.now),
      customerInterval: request.window,
    });
    advanceOperation(world, world.now);
    expect(world.reservations!.filter((row) => row.id === reservation.id)).toHaveLength(1);
  });

  it('cancels expired held work with actual source facts and retains its registration until archival', () => {
    const world = fresh('ordinary-expiry');
    enableOperationOrdinaryWork(world);
    activateOperationOrdinaryDispatch(world);
    advanceOperation(world, start + 600_000);
    const reservation = world.reservations!.find((row) => row.tenant === 'alpha')!;
    const original = structuredClone(reservation);
    expect(() => retireOperationOrdinaryFlight(world, reservation.id)).toThrow('active ordinary');
    advanceOperation(world, Date.parse(reservation.order.schedule.end) + 1);
    expect(reservation.phase).toBe('cancelled');
    expect(reservation.plan).toEqual(original.plan);
    expect(reservation.order).toEqual(original.order);
    expect(world.facts).toContainEqual(
      expect.objectContaining({
        kind: 'cancellation',
        attemptId: reservation.id,
        reason: 'requested_window_unreachable',
      }),
    );
    expect(world.attempts.some((row) => row.id === reservation.id)).toBe(false);
    expect(world.ordinaryDispatch!.flights.some((row) => row.attemptId === reservation.id)).toBe(true);
    const person = operationDepartureResources(world, reservation.id)!.flightPeople.find(
      (row) => row.id === reservation.personId,
    )!;
    expect(person.aircraftId).toBeUndefined();
    retireOperationOrdinaryFlight(world, reservation.id);
    expect(world.ordinaryDispatch!.flights.some((row) => row.attemptId === reservation.id)).toBe(false);
    expect(world.resources).toBeUndefined();
  });
});
