/**
 * setup.ts - Vitest setup file. Currently used to ensure JSDOM globals
 * are available on `globalThis` for tests that don't explicitly import
 * them.
 */

import '@testing-library/jest-dom/vitest';
