import { createContext } from 'react';
import type { FirstDayStep } from './first-steps.js';

/** The first-day list as last read, for the setup screen and the bar's "Setup" entry. */
export interface FirstDayShown {
  /** Null until every read has settled once. */
  steps: FirstDayStep[] | null;
  offersSetup: boolean;
}

export const FirstDayContext = createContext<FirstDayShown>({ steps: null, offersSetup: false });
