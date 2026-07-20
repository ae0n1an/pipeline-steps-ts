/**
 * Step: consolidate-run-results (TypeScript)
 *
 * Folds a named list of prior steps' outputs from the current run into
 * one structured JSON artifact, designed for trending over time and as
 * the input for a later Confluence-publishing step. No file I/O or
 * network calls beyond the final write — StepContext.steps already has
 * everything needed, read from step-output dirs (populated by runner).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult, type StepOutputFile } from '../runner/types';

export interface ConsolidateRunResultsConfig {
  stepNames: string[];
  /** Arbitrary key-value metadata, interpolated via {{env.VAR}} like any other config field. */
  runMetadata?: Record<string, string>;
  /** Output artifact filename; defaults to "run-results.json". */
  fileName?: string;
}

export interface ConsolidatedStepEntry {
  stepName: string;
  ok: boolean;
  outputs: Record<string, string | number | boolean>;
  error?: string;
}

export interface ConsolidatedResult {
  runMetadata: Record<string, string>;
  generatedAt: string;
  steps: ConsolidatedStepEntry[];
  summary: {
    totalSteps: number;
    succeededCount: number;
    failedCount: number;
  };
}

export function buildConsolidatedResult(
  config: ConsolidateRunResultsConfig,
  steps: Record<string, StepOutputFile>,
  now: () => string = () => new Date().toISOString(),
): ConsolidatedResult {
  if (!config.stepNames || config.stepNames.length === 0) {
    throw new Error('config.stepNames must contain at least one step name');
  }

  const missing = config.stepNames.filter(name => !(name in steps));
  if (missing.length > 0) {
    throw new Error(`Step(s) not found in this run's step outputs: ${missing.join(', ')}`);
  }

  const entries: ConsolidatedStepEntry[] = config.stepNames.map(stepName => {
    const stepOutput = steps[stepName];
    const entry: ConsolidatedStepEntry = {
      stepName,
      ok: stepOutput.ok,
      outputs: stepOutput.outputs ?? {},
    };
    if (stepOutput.error) entry.error = stepOutput.error.message;
    return entry;
  });

  const succeededCount = entries.filter(e => e.ok).length;

  return {
    runMetadata: config.runMetadata ?? {},
    generatedAt: now(),
    steps: entries,
    summary: {
      totalSteps: entries.length,
      succeededCount,
      failedCount: entries.length - succeededCount,
    },
  };
}
