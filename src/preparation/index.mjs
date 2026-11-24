// Public API for external callers. Internal modules keep direct imports.
export { getAudioDescriptionStatus } from './audio-descriptions.mjs';
export { analyzeObservationSegment, getObserverStatus } from './observation-manager.mjs';
export { createObservationPrecomputeManifest, markObservationChunkComplete } from './observation-precompute-plan.mjs';
export { runObservationPrecompute } from './observation-precompute-runner.mjs';
export { upgradeViewingPackage, recoverPackageUpgrades } from './package-upgrade.mjs';
