import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Everything under test here is DOM-free by design: topology, analytics,
    // layout maths and encodings. The WebGL layers are covered by the headless
    // render smoke test in CI instead, where a real GL context exists.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/graph/**', 'src/layout/**', 'src/state/**', 'src/util/**', 'src/theme/**'],
      reporter: ['text-summary'],
    },
  },
});
