export type SuiteName =
  | 'rules'
  | 'puppeting'
  | 'mapContradiction'
  | 'toolValidity';
export interface SuiteResult {
  /** rules/toolValidity: fraction correct (higher is better). puppeting/mapContradiction: flagged rate (lower is better). */
  score: number;
  n: number;
  failures: string[];
  pass: boolean;
}
export interface EvalRecord {
  version: 1;
  mode: 'recorded' | 'live';
  /** Endpoint profile id (EndpointProfile.id); `recorded-fixture` for offline runs. */
  endpointProfileId: string;
  model: string;
  seed: number;
  ranAt: string;
  suites: Record<SuiteName, SuiteResult>;
  passed: boolean;
  note: string;
}
/** model(prompt) → text. Seed is a per-case value derived from the run seed. */
export type EvalModel = (input: {
  suite: SuiteName;
  caseId: string;
  prompt: string;
  seed: number;
}) => Promise<string>;
