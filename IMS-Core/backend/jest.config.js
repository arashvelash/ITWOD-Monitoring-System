/**
 * Jest configuration for the IMS-Core backend.
 * Unit tests live in the repository-level `tests/backend` directory.
 *
 * Run a subset: npx jest --config jest.config.js tests/backend/auth
 */
const path = require('node:path');

/** @type {import('jest').Config} */
module.exports = {
  rootDir: path.resolve(__dirname, '..'),
  roots: ['<rootDir>/tests/backend'],
  testEnvironment: 'node',
  testMatch: ['**/*.spec.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: path.resolve(__dirname, 'tsconfig.json') }],
  },
  setupFiles: ['<rootDir>/tests/backend/setup.ts'],
  clearMocks: true,
  restoreMocks: true,
};
