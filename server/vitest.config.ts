import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // One worker, one file at a time: all tests share one scratch database
    // and one server, so parallel files could see each other's rows. The
    // suite is small and local; sequential keeps every assertion
    // deterministic. (Concurrency that matters — the race test — is
    // HTTP-level, inside one test, and unaffected by this.)
    // singleFork is the Vitest 2 way to serialise files.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    globalSetup: './src/__tests__/globalSetup.ts',
    // The race test registers 50 users then fires 50 concurrent joins;
    // 60s leaves ample headroom on a cold machine.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
})
