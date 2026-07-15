/**
 * Discovers every scenario in test/scenarios/*.json and runs each one
 * through the real runner CLI, diffing normalized results against
 * test/golden/<name>.json. Set UPDATE_GOLDENS=1 to (re)write goldens
 * instead of comparing against them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverScenarioFiles, runScenarioAndCompare, type Scenario } from './lib/scenario-harness';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(TEST_DIR, 'scenarios');
const GOLDEN_DIR = path.join(TEST_DIR, 'golden');
const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === '1';

for (const file of discoverScenarioFiles(SCENARIOS_DIR)) {
  const scenarioName = file.replace(/\.json$/, '');

  test(`scenario: ${scenarioName}`, () => {
    const scenario: Scenario = JSON.parse(fs.readFileSync(path.join(SCENARIOS_DIR, file), 'utf8'));
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `scenario-${scenarioName}-`));
    try {
      const goldenPath = path.join(GOLDEN_DIR, `${scenarioName}.json`);
      const outcome = runScenarioAndCompare(scenario, workspaceDir, goldenPath, UPDATE_GOLDENS);
      if (outcome.status === 'updated') {
        console.log(`[scenario: ${scenarioName}] ${outcome.message}`);
        return;
      }
      assert.equal(outcome.status, 'passed', `Scenario "${scenarioName}" regressed:\n${outcome.message}`);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
}
