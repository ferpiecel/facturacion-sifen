/**
 * The Argon2id cost parameters this project pins explicitly, rather than
 * relying on `@node-rs/argon2`'s own defaults (which could change across
 * versions). Used by the infrastructure Argon2 adapter to hash/verify, and
 * by the application use case's `DUMMY_HASH` (a spec asserts that
 * equality), so a lookup miss and a lookup hit always cost the same
 * amount of work.
 */
export const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
