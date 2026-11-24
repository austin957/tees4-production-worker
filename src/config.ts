import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { completionAction, readActions, skuAction, WorkerError, writeActions } from './model.js';
import type { Action, ArtworkIdentity, LegacyArtwork, Mode, Stage, Workflow } from './model.js';

export function readJson(path: string, purpose: string): unknown {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    throw new WorkerError('FILE_READ', `Could not read the ${purpose} file at ${path}.`);
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new WorkerError('INVALID_JSON', `The ${purpose} file must contain valid JSON.`);
  }
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkerError('INVALID_INPUT', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function onlyKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) {
    throw new WorkerError('INVALID_INPUT', `${label} contains an unsupported field.`);
  }
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || !value.isWellFormed() || /\p{Cc}/u.test(value)) {
    throw new WorkerError('INVALID_INPUT', `${label} requires a nonempty string without surrounding whitespace or control characters.`);
  }
  return value;
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new WorkerError('INVALID_INPUT', `${label} must be an integer from ${min} through ${max}.`);
  }
  return value;
}

export function parseArtworkIdentity(value: Record<string, unknown>): ArtworkIdentity {
  return {
    artworkId: requiredText(value.artworkId, 'artworkId'),
    artworkRef: requiredText(value.artworkRef, 'artworkRef'),
    designerId: requiredText(value.designerId, 'designerId'),
  };
}

export function parseArtwork(input: unknown): LegacyArtwork {
  const value = object(input, 'Artwork');
  onlyKeys(value, ['artworkId', 'artworkRef', 'designerId', 'sku', 'productTitle'], 'Artwork');
  return {
    ...parseArtworkIdentity(value),
    sku: requiredText(value.sku, 'sku'),
    productTitle: requiredText(value.productTitle, 'productTitle'),
  };
}

export function parseMode(value: unknown): Mode {
  if (value === 'dry-run' || value === 'simulate') return value;
  throw new WorkerError('INVALID_MODE', 'Mode must be dry-run or simulate.');
}

function parseStage(input: unknown): Stage {
  const value = object(input, 'Stage');
  const id = requiredText(value.id, 'Stage ID');
  if (value.kind === 'validate' || value.kind === 'approval') {
    onlyKeys(value, ['id', 'kind'], 'Stage');
    return { id, kind: value.kind };
  }
  const actions: readonly unknown[] = [...readActions, ...writeActions, skuAction, completionAction];
  if (value.kind === 'action' && actions.includes(value.action)) {
    onlyKeys(value, ['id', 'kind', 'action'], 'Stage');
    return { id, kind: 'action', action: value.action as Action };
  }
  throw new WorkerError('INVALID_WORKFLOW', 'Each stage requires a supported kind and action.');
}

export function parseWorkflow(input: unknown): Workflow {
  const value = object(input, 'Workflow');
  onlyKeys(value, ['id', 'maxAttempts', 'retryDelayMs', 'leaseMs', 'stages'], 'Workflow');
  if (!Array.isArray(value.stages)) {
    throw new WorkerError('INVALID_WORKFLOW', 'Workflow stages must be an array.');
  }
  const stages = value.stages.map(parseStage);
  if (stages[0]?.kind !== 'validate' || stages.slice(1).some(stage => stage.kind === 'validate')) {
    throw new WorkerError('INVALID_WORKFLOW', 'A workflow must have one validation stage at the beginning.');
  }
  if (new Set(stages.map(stage => stage.id)).size !== stages.length) {
    throw new WorkerError('INVALID_WORKFLOW', 'Stage IDs must be unique.');
  }
  const create = stages.findIndex(stage => stage.kind === 'action' && stage.action === 'shopify.create');
  const gate = stages.findIndex((stage, index) => index > create && stage.kind === 'approval');
  if (stages.some((stage, index) => stage.kind === 'action' && stage.action === 'shopify.publish'
      && (create < 0 || gate < 0 || gate >= index))) {
    throw new WorkerError('INVALID_WORKFLOW', 'Publishing requires product creation followed by an explicit approval stage.');
  }
  return {
    id: requiredText(value.id, 'Workflow ID'),
    maxAttempts: integer(value.maxAttempts, 'maxAttempts', 1, 20),
    retryDelayMs: integer(value.retryDelayMs, 'retryDelayMs', 0, 60_000),
    leaseMs: integer(value.leaseMs, 'leaseMs', 10, 600_000),
    stages,
  };
}

export function settings(env: NodeJS.ProcessEnv) {
  const margin = env.TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES;
  const exportMarginMinutes = margin === undefined ? undefined : integer(
    /^\d+$/.test(margin) ? Number(margin) : NaN,
    'TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES', 1, Number.MAX_SAFE_INTEGER,
  );
  return {
    exportMarginMinutes,
    workflowPath: resolve(requiredText(env.TEES4_CONFIG ?? 'examples/workflow.json', 'TEES4_CONFIG')),
    databasePath: resolve(requiredText(env.TEES4_DATABASE ?? '.tees4/worker.sqlite', 'TEES4_DATABASE')),
  };
}
