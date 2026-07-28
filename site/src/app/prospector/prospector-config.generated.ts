/* GENERATED FILE — DO NOT EDIT.
 *
 * Written by site/tools/generate-db-types.mjs from pipeline/config/prospector.json.
 * Regenerate with `npm run codegen --workspace @bomsquad/site`;
 * schema-types.spec.ts fails the suite if this file and its source disagree.
 */

import type { ProspectorConfig } from './ranking';

/*
 * T6.3 owns the ranking; T7.7 reproduces it in the browser. This file is the only
 * route by which a scoring weight reaches site/ — there is no second copy of a
 * number below anywhere in the app, and site/tools/verify-prospector-parity.mjs
 * runs both implementations over the same database to prove it.
 */
export const PROSPECTOR_CONFIG: ProspectorConfig = {
  version: '1.0.0',
  bandWeight: {
    hard: 5,
    medium: 2,
    soft: 1,
  },
  unmappedDeviceWeight: 4,
  routeCredit: {
    equivalent: 0.9,
    provides: 0.5,
  },
  confidenceFactor: {
    high: 1,
    medium: 0.85,
    low: 0.5,
  },
  bonus: {
    systemMateCore: 0.1,
    cpuSoundComplete: 0.15,
  },
  systemMateMinSharedChips: 2,
};
