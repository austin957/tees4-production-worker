export type Mode = 'dry-run' | 'simulate';

export interface Artwork {
  artworkId: string;
  artworkRef: string;
  designerId: string;
  sku: string;
  productTitle: string;
}

export const readActions = [
  'drive.readArtwork',
  'sheets.readAssignment',
  'teeinblue.readDesign',
  'flashTransfers.readProduct',
  'designEngine.readDesign',
  'affiliatePortal.readSubmission',
] as const;

export const writeActions = ['mockupify.generate', 'shopify.create', 'shopify.publish'] as const;
export type ReadAction = typeof readActions[number];
export type WriteAction = typeof writeActions[number];
export type Action = ReadAction | WriteAction;

export type Stage =
  | { id: string; kind: 'validate' | 'approval' }
  | { id: string; kind: 'action'; action: Action };

export interface Workflow {
  id: string;
  maxAttempts: number;
  retryDelayMs: number;
  leaseMs: number;
  stages: Stage[];
}

export type Status = 'queued' | 'running' | 'awaiting_approval' | 'retry_wait' | 'failed' | 'completed';

export interface Job {
  id: string;
  artwork: Artwork;
  mode: Mode;
  workflow: Workflow;
  status: Status;
  nextStage: number;
  failures: number;
  results: StageResult[];
  history: JobEvent[];
  availableAt: number;
  createdAt: number;
  updatedAt: number;
}

export type Details = Record<string, string>;

export interface StageResult {
  stageId: string;
  outcome: 'validated' | 'approved' | 'read' | 'planned' | 'applied' | 'reused';
  details?: Details;
}

export interface JobEvent {
  at: number;
  event: string;
  stageId?: string;
  code?: string;
  message?: string;
}

export class WorkerError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'WorkerError';
  }
}

export function asWorkerError(error: unknown): WorkerError {
  if (error instanceof WorkerError) return error;
  return new WorkerError('UNEXPECTED_ERROR', 'An unexpected worker error occurred.');
}

export function isWrite(action: Action): action is WriteAction {
  return writeActions.some(candidate => candidate === action);
}
