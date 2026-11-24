import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseArtwork, parseMode, parseWorkflow, settings } from '../src/config.js';

const artwork = JSON.parse(readFileSync('examples/artwork.json', 'utf8'));
const workflow = parseWorkflow(JSON.parse(readFileSync('examples/workflow.json', 'utf8')));

test('artwork requires the supplied original reference, designer attribution and SKU', () => {
  assert.deepEqual(parseArtwork(artwork), artwork);
  for (const field of Object.keys(artwork)) {
    assert.throws(() => parseArtwork({ ...artwork, [field]: '' }), { code: 'INVALID_INPUT' });
    assert.throws(() => parseArtwork({ ...artwork, [field]: undefined }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => parseArtwork({ ...artwork, unexpected: true }), { code: 'INVALID_INPUT' });
});

test('workflow rejects unknown actions, duplicate stage IDs and misplaced validation', () => {
  const [validation] = workflow.stages;
  assert.throws(() => parseWorkflow({ ...workflow, stages: [validation, validation] }), { code: 'INVALID_WORKFLOW' });
  assert.throws(() => parseWorkflow({ ...workflow, stages: workflow.stages.slice(1) }), { code: 'INVALID_WORKFLOW' });
  assert.throws(() => parseWorkflow({
    ...workflow, stages: [...workflow.stages, { id: 'overwrite', kind: 'action', action: 'drive.overwrite' }],
  }), { code: 'INVALID_WORKFLOW' });
});

test('publication requires creation and a subsequent approval before it', () => {
  const stages = workflow.stages;
  const [gate] = stages.filter(stage => stage.kind === 'approval');
  const withoutGate = stages.filter(stage => stage !== gate);
  assert.throws(() => parseWorkflow({ ...workflow, stages: withoutGate }), { code: 'INVALID_WORKFLOW' });
  assert.throws(() => parseWorkflow({ ...workflow, stages: [withoutGate[0], gate, ...withoutGate.slice(1)] }), {
    code: 'INVALID_WORKFLOW',
  });
  assert.throws(() => parseWorkflow({
    ...workflow,
    stages: stages.filter(stage => !(stage.kind === 'action' && stage.action === 'shopify.create')),
  }), { code: 'INVALID_WORKFLOW' });
});

test('local paths, retries and modes are validated', () => {
  assert.equal(parseMode('dry-run'), 'dry-run');
  assert.throws(() => parseMode('live'), { code: 'INVALID_MODE' });
  assert.throws(() => settings({ TEES4_DATABASE: ' ' }), { code: 'INVALID_INPUT' });
  assert.throws(() => settings({ TEES4_CONFIG: '' }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseWorkflow({ ...workflow, maxAttempts: 0 }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseWorkflow({ ...workflow, retryDelayMs: -1 }), { code: 'INVALID_INPUT' });
  assert.throws(() => parseWorkflow({ ...workflow, leaseMs: 0 }), { code: 'INVALID_INPUT' });
});
