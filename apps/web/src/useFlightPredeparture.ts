import { useEffect, useState } from 'react';
import { ApiError, type LedgerClient } from '@ledger/contracts/client';
import type { FlightPredepartureResponse, MissionReleaseRecord } from '@ledger/contracts';
import { resolveAreaControl, type AreaControl } from './area-controls.js';
import { errorMessage } from './format.js';
import { canonicalDigest } from './safety.js';
import { MissionReadFailure, missionRead, missionReadOutcome, readFailureStep } from './read-failure.js';

export interface PredepartureRead {
  response: FlightPredepartureResponse;
  release: MissionReleaseRecord | null;
  controls: AreaControl[];
}

export function useFlightPredeparture(active: boolean, client: LedgerClient, flightId: string) {
  const [read, setRead] = useState<PredepartureRead | null>(null);
  const [error, setError] = useState<{ flightId: string; text: string } | null>(null);
  useEffect(() => {
    setRead(null);
    setError(null);
  }, [client, flightId]);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controls = new Map<string, AreaControl>();
    const releases = new Map<string, MissionReleaseRecord>();
    async function poll(readAgainIfStale = true): Promise<void> {
      try {
        const response = await missionRead('flight', client.flightPredeparture(flightId));
        const progress = response.progress;
        if (
          response.flightId !== flightId ||
          (progress === null) !== (response.digest === null) ||
          (progress && (progress.flightId !== flightId || (await canonicalDigest(progress)) !== response.digest))
        )
          throw new Error('The departure progress could not be matched to this exact flight.');
        let release: MissionReleaseRecord | null = null;
        let selected: AreaControl[] = [];
        if (progress?.references.release) {
          const reference = progress.references.release;
          release = releases.get(reference.digest) ?? null;
          if (!release) {
            const exact = await missionRead('release', client.missionRelease(flightId, reference.id));
            if (
              exact.release.flightId !== flightId ||
              exact.release.id !== reference.id ||
              exact.digest !== reference.digest ||
              (await canonicalDigest(exact.release)) !== exact.digest ||
              (await canonicalDigest(exact.release.basis.mission)) !==
                exact.release.basis.avoidance.mission.recordDigest
            )
              throw new Error('The source-linked release could not be matched to its retained record.');
            release = exact.release;
            releases.set(reference.digest, release);
          }
          selected = await Promise.all(
            release.basis.avoidance.candidates.map(async (candidate) => {
              let control = controls.get(candidate.controlDigest);
              if (!control) {
                control = await resolveAreaControl(client, candidate).catch((failure: unknown) => {
                  if (failure instanceof ApiError) throw new MissionReadFailure('control', failure);
                  throw new Error('A briefing area could not be matched to the exact released control.');
                });
                controls.set(candidate.controlDigest, control);
              }
              return control;
            }),
          );
        }
        if (!stopped) {
          setRead((previous) =>
            previous?.response.progress &&
            progress &&
            (previous.response.progress.revision > progress.revision ||
              (previous.response.progress.id === progress.id && previous.response.readAt > response.readAt))
              ? previous
              : { response, release, controls: selected },
          );
          setError(null);
        }
      } catch (failed) {
        if (!stopped) {
          // The release or a control changed after the progress listed it: one immediate read again, then polling.
          const step = readFailureStep(missionReadOutcome(failed), readAgainIfStale);
          if (step === 'read_again') return poll(false);
          if (step === 'clear') {
            controls.clear();
            releases.clear();
            setRead(null);
          }
          const failure = failed instanceof MissionReadFailure ? failed.failure : failed;
          setError({ flightId, text: errorMessage(failure) });
        }
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, client, flightId]);
  return {
    read: read?.response.flightId === flightId ? read : null,
    error: error?.flightId === flightId ? error.text : null,
  };
}
