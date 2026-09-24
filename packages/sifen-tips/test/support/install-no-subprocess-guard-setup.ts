import { installNoSubprocessGuard } from './no-subprocess-guard.ts';

/**
 * Vitest `setupFiles` entry for the e2e project only (see vitest.config.ts).
 * Runs at import time, before the project's test files — and anything they
 * statically import — get a chance to load, so a library that captures
 * `child_process` methods at require time (facturacionelectronicapy-xmlsign
 * may) captures the guarded versions, not the originals.
 */
installNoSubprocessGuard();
