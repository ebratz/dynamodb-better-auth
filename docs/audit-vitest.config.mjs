import { defineConfig } from 'vitest/config';

// Run the original audit reproductions alone. The normal unit suite also
// imports them through test/audit-regressions.test.mjs.
export default defineConfig({
  test: { include: ['docs/audit-reproductions.mjs'], clearMocks: true },
});
