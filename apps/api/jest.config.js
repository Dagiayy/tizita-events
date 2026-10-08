/** @type {import('jest').Config} */
const base = {
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: false }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  rootDir: '.',
};
module.exports = {
  projects: [
    { ...base, displayName: 'unit', testMatch: ['<rootDir>/test/unit/**/*.spec.ts'] },
    { ...base, displayName: 'integration', testMatch: ['<rootDir>/test/integration/**/*.spec.ts'], setupFiles: ['<rootDir>/test/env.ts'], setupFilesAfterEnv: ['<rootDir>/test/setup.ts'] },
    { ...base, displayName: 'e2e', testMatch: ['<rootDir>/test/e2e/**/*.spec.ts'], setupFiles: ['<rootDir>/test/env.ts'], setupFilesAfterEnv: ['<rootDir>/test/setup.ts'] },
  ],
};
