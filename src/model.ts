export type Mode = 'dry-run' | 'simulate';

export interface ArtworkIdentity {
  artworkId: string;
  artworkRef: string;
  designerId: string;
}

export interface LegacyArtwork extends ArtworkIdentity {
  sku: string;
  productTitle: string;
}

export interface GarmentAssignment {
  sourceRow: number;
  productSku: string;
  productTitle: string;
  productDescription: string;
  vendor: string;
  garmentSelection: string;
  colors: string;
  tags: string;
}

export interface ProductionArtwork extends ArtworkIdentity {
  kind: 'production';
  artworkSku: string;
  artworkName: string;
  garments: GarmentAssignment[];
}

export type Artwork = LegacyArtwork | ProductionArtwork;

export function isProduction(artwork: Artwork): artwork is ProductionArtwork {
  return 'kind' in artwork && artwork.kind === 'production';
}

export const skuAction = 'shopify.assignSkus';

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
export type Action = ReadAction | WriteAction | typeof skuAction;

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

export type Status = 'queued' | 'running' | 'awaiting_approval' | 'retry_wait' | 'failed' | 'needs_review' | 'completed';

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
  skuAssignments?: {
    productId: string;
    productSku: string;
    variantId: string;
    size: string;
    color: string;
    outcome: 'planned' | 'assigned' | 'already_assigned' | 'preserved';
    review?: { code: 'UNEXPECTED_VARIANT_SKU'; observedSku: string };
  }[];
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
