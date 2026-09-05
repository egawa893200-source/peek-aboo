import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ロジックの単体テストだけを置く。DOM や WebGL が要るものは
    // Playwright（tests/e2e）でブラウザ上で確かめる（CLAUDE.md 参照）
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    reporters: ['default'],
  },
});
