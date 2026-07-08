/**
 * The step contract. Every step module default-exports a StepModule.
 * The generics let each step declare its own config shape while the
 * runner stays fully generic.
 */

export interface StepResult {
  /** Small JSON-serializable values, exposed as pipeline variables. */
  outputs?: Record<string, string | number | boolean>;
  /** Absolute paths to files the step produced. */
  artifacts?: string[];
}

export interface StepOutputFile extends StepResult {
  step: string;
  ok: boolean;
  startedAt?: string;
  durationMs: number;
  config?: unknown;
  error?: { message: string; stack?: string };
  outputs: Record<string, string | number | boolean>;
  artifacts: string[];
}

export interface StepContext {
  stepName: string;
  /** Directory the step should write its files into. */
  outDir: string;
  workspace: string;
  /** Outputs of previously run steps, keyed by step name. */
  steps: Record<string, StepOutputFile>;
  log: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
}

export interface StepModule<TConfig = unknown> {
  run(config: TConfig, ctx: StepContext): Promise<StepResult> | StepResult;
}

/** Helper for defining a step with an inferred config type. */
export function defineStep<TConfig>(step: StepModule<TConfig>): StepModule<TConfig> {
  return step;
}
