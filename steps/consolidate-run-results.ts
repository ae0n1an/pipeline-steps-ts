/**
 * Step: consolidate-run-results (TypeScript)
 *
 * Folds a named list of prior steps' outputs from the current run into
 * one structured JSON artifact, designed for trending over time and as
 * the input for a later Confluence-publishing step. No file I/O or
 * network calls beyond the final write and any embedArtifacts reads —
 * StepContext.steps already has everything needed, read from step-output
 * dirs (populated by runner).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineStep, type StepContext, type StepResult, type StepOutputFile } from '../runner/types';

export interface ConsolidateRunResultsConfig {
  stepNames: string[];
  /**
   * Step name -> artifact filename to also embed as parsed JSON under
   * that step's `data` field, alongside its existing flat `outputs`.
   * The filename is matched by basename against that step's own
   * StepOutputFile.artifacts list.
   */
  embedArtifacts?: Record<string, string>;
  /** Arbitrary key-value metadata, interpolated via {{env.VAR}} like any other config field. */
  runMetadata?: Record<string, string>;
  /** Output artifact filename; defaults to "run-results.json". */
  fileName?: string;
}

export interface ConsolidatedStepEntry {
  stepName: string;
  ok: boolean;
  outputs: Record<string, string | number | boolean>;
  /** Parsed content of the embedded artifact, when embedArtifacts names this step. */
  data?: unknown;
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

function loadEmbeddedArtifact(stepName: string, fileName: string, stepOutput: StepOutputFile): unknown {
  const matchPath = stepOutput.artifacts.find(p => path.basename(p) === fileName);
  if (!matchPath) {
    const basenames = stepOutput.artifacts.map(p => path.basename(p)).join(', ') || '(none)';
    throw new Error(`Step "${stepName}": no artifact named "${fileName}" found (has: ${basenames})`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(matchPath, 'utf8');
  } catch (err) {
    throw new Error(`Step "${stepName}": failed to read embedded artifact "${matchPath}": ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Step "${stepName}": embedded artifact "${matchPath}" is not valid JSON: ${(err as Error).message}`);
  }
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

  const embedArtifacts = config.embedArtifacts ?? {};
  const unknownEmbeds = Object.keys(embedArtifacts).filter(name => !config.stepNames.includes(name));
  if (unknownEmbeds.length > 0) {
    throw new Error(`embedArtifacts references step(s) not in stepNames: ${unknownEmbeds.join(', ')}`);
  }

  const entries: ConsolidatedStepEntry[] = config.stepNames.map(stepName => {
    const stepOutput = steps[stepName];
    const entry: ConsolidatedStepEntry = {
      stepName,
      ok: stepOutput.ok,
      outputs: stepOutput.outputs ?? {},
    };
    if (stepOutput.error) entry.error = stepOutput.error.message;
    const embedFileName = embedArtifacts[stepName];
    if (embedFileName) {
      entry.data = loadEmbeddedArtifact(stepName, embedFileName, stepOutput);
    }
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

export function runAll(config: ConsolidateRunResultsConfig, ctx: StepContext): StepResult {
  const result = buildConsolidatedResult(config, ctx.steps);

  const fileName = config.fileName ?? 'run-results.json';
  const filePath = path.join(ctx.outDir, fileName);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2));

  ctx.log(
    `Consolidated ${result.summary.totalSteps} step(s): ${result.summary.succeededCount} succeeded, ${result.summary.failedCount} failed -> ${fileName}`,
  );

  return {
    outputs: {
      consolidatedPath: filePath,
      totalSteps: result.summary.totalSteps,
      succeededCount: result.summary.succeededCount,
      failedCount: result.summary.failedCount,
    },
    artifacts: [filePath],
  };
}

export default defineStep<ConsolidateRunResultsConfig>({
  run: (config, ctx) => runAll(config, ctx),
});
