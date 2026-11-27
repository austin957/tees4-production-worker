import { integer, readJson, requiredText } from './config.js';
import { readMasterInputSkuRows } from './google-sheets.js';
import { previewMockupifySkuReplacement } from './mockupify-sku-replacement.js';
import { WorkerError } from './model.js';
import { parseBindingAssignment, proposeProductBinding, reviewProductBinding } from './product-bindings.js';
import { reportPostHextom } from './shopify-post-hextom.js';
import { shopifyReadConfig, ShopifyReadonlyClient } from './shopify-readonly.js';
import type { Store } from './store.js';

export const bindingCommands = {
  'binding-list': {},
  'binding-inspect': {},
  'shopify-post-hextom': {},
  'mockupify-sku-replacement-preview': { 'header-row': { type: 'string' } },
  'binding-propose': { by: { type: 'string' } },
  'binding-review': {
    by: { type: 'string' }, source: { type: 'string' }, reason: { type: 'string' }, 'header-row': { type: 'string' },
  },
} as const;

function shopifyEvidence() {
  const config = shopifyReadConfig(process.env);
  return { shopId: config.shopId, shopify: new ShopifyReadonlyClient(config) };
}

function masterInputHeaderRow(value: unknown): number {
  const header = value ?? '1';
  return integer(typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : NaN,
    'Master Input header row', 1, Number.MAX_SAFE_INTEGER);
}

export async function runBindingCommand(store: Store, command: string, args: string[], values: Record<string, unknown>) {
  const expectedCount = command === 'binding-list' ? 0 : command === 'binding-review' ? 2 : 1;
  if (args.length !== expectedCount) throw new WorkerError('CLI_USAGE', 'Wrong number of binding arguments. Run worker help for usage.');
  if (command === 'binding-list') return store.listProductBindings();
  if (command === 'binding-inspect') return store.inspectProductBinding(args[0]!);
  if (command === 'mockupify-sku-replacement-preview') {
    const headerRow = masterInputHeaderRow(values['header-row']);
    return previewMockupifySkuReplacement(store, args[0]!, {
      ...shopifyEvidence(), readMasterInput: () => readMasterInputSkuRows(headerRow),
    });
  }
  if (command === 'shopify-post-hextom') {
    const { shopId, shopify } = shopifyEvidence();
    return reportPostHextom(store, shopify, shopId, args[0]!);
  }
  const by = requiredText(values.by, 'Operator supplied with --by');
  if (command === 'binding-propose') {
    const assignment = parseBindingAssignment(readJson(args[0]!, 'binding assignment'));
    return proposeProductBinding(store, assignment, by, shopifyEvidence());
  }

  const [id, action] = args as [string, string];
  if (action === 'reject') {
    if (values.source !== undefined || values['header-row'] !== undefined) {
      throw new WorkerError('CLI_USAGE', 'Use --reason when rejecting a proposed binding.');
    }
    return store.recordProductBindingReview(id, { event: 'rejected', by, at: Date.now(), reason: requiredText(values.reason, 'Rejection reason') });
  }
  if ((action !== 'approve' && action !== 'recheck') || values.reason !== undefined
    || (action === 'recheck' && values.source !== undefined)) {
    throw new WorkerError('CLI_USAGE', 'Use approve with --source, reject with --reason, or recheck.');
  }
  const review = action === 'approve'
    ? { action, by, source: requiredText(values.source, 'Owner confirmation evidence reference') } as const
    : { action, by } as const;
  const headerRow = masterInputHeaderRow(values['header-row']);
  const result = await reviewProductBinding(store, id, review, {
    ...shopifyEvidence(), readMasterInput: async () => ({ kind: 'live', rows: await readMasterInputSkuRows(headerRow) }),
  });
  if (result.event.event === 'stale' || result.event.event === 'verification_failed') process.exitCode = 1;
  return result;
}
