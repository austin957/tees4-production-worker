import { integer, readJson, requiredText } from './config.js';
import { readMasterInputSkuRows } from './google-sheets.js';
import { previewMockupifySkuReplacement } from './mockupify-sku-replacement.js';
import { mockupifyReadOnly } from './mockupify-readonly.js';
import { WorkerError } from './model.js';
import { parseBindingAssignment, proposeProductBinding, reviewProductBinding } from './product-bindings.js';
import { reportPostHextom } from './shopify-post-hextom.js';
import { shopifyReadConfig, ShopifyReadonlyClient } from './shopify-readonly.js';
import { approveSkuReplacement, dryRunSkuReplacement, executeSkuReplacement, reconcileSkuReplacement } from './shopify-sku-execution.js';
import type { SkuReplacementPlan } from './shopify-sku-execution.js';
import { hextomPauseReader } from './shopify-sku-hextom.js';
import { shopifySkuWriter } from './shopify-sku-write-adapter.js';
import type { Store } from './store.js';

export const bindingCommands = {
  'binding-list': {},
  'binding-inspect': {},
  'shopify-post-hextom': {},
  'mockupify-sku-replacement-preview': { 'header-row': { type: 'string' } },
  'mockupify-sku-replacement-dry-run': { 'header-row': { type: 'string' } },
  'mockupify-sku-replacement-run': {
    execute: { type: 'boolean' }, 'plan-id': { type: 'string' }, 'approval-sequence': { type: 'string' }, 'header-row': { type: 'string' },
  },
  'mockupify-sku-replacement-approve': { 'for-live': { type: 'boolean' }, by: { type: 'string' }, source: { type: 'string' }, 'header-row': { type: 'string' } },
  'mockupify-sku-replacement-inspect': {},
  'mockupify-sku-replacement-reconcile': {},
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

function assertLiveSkuPilot(store: Store, bindingId: string) {
  if (bindingId !== '3e66387c-df11-4d88-ba05-cd498def29cb') {
    throw new WorkerError('SKU_EXECUTION_PLAN_CHANGED', 'Live SKU execution is restricted to the approved pilot binding.');
  }
  const binding = store.getProductBinding(bindingId);
  if (binding.productId !== 'gid://shopify/Product/10467506880803' || binding.productSku !== '8419620257-S105') {
    throw new WorkerError('SKU_EXECUTION_PLAN_CHANGED', 'The binding does not match the approved pilot product and SKU.');
  }
}

function assertPilotPlan(plan: SkuReplacementPlan, bindingId: string) {
  if (plan.bindingId !== bindingId || plan.provenance.exportId !== 20208 || plan.variants.length !== 14) {
    throw new WorkerError('SKU_EXECUTION_PLAN_CHANGED', 'Live SKU execution requires the verified pilot export and all 14 approved variants.');
  }
}

export async function runBindingCommand(store: Store, command: string, args: string[], values: Record<string, unknown>) {
  const expectedCount = command === 'binding-list' ? 0 : ['binding-review', 'mockupify-sku-replacement-approve'].includes(command) ? 2 : 1;
  if (args.length !== expectedCount) throw new WorkerError('CLI_USAGE', 'Wrong number of binding arguments. Run worker help for usage.');
  if (command === 'binding-list') return store.listProductBindings();
  if (command === 'binding-inspect') return store.inspectProductBinding(args[0]!);
  if (command === 'mockupify-sku-replacement-inspect') return store.shopifySkuJournal.inspect(args[0]!);
  if (command === 'mockupify-sku-replacement-reconcile') {
    return reconcileSkuReplacement(store, args[0]!, shopifyEvidence());
  }
  if (command === 'mockupify-sku-replacement-run') {
    const bindingId = args[0]!;
    const headerRow = masterInputHeaderRow(values['header-row']);
    const readMasterInput = () => readMasterInputSkuRows(headerRow);
    const readExport = (id: number) => mockupifyReadOnly().getExport(id);
    if (values.execute !== true) {
      if (values['plan-id'] !== undefined || values['approval-sequence'] !== undefined) {
        throw new WorkerError('CLI_USAGE', 'Supply --plan-id and --approval-sequence only with --execute.');
      }
      assertLiveSkuPilot(store, bindingId);
      const report = await dryRunSkuReplacement(store, bindingId, { ...shopifyEvidence(), readMasterInput }, Date.now, readExport);
      assertPilotPlan(report.plan, bindingId);
      return report;
    }
    const planId = values['plan-id'];
    const sequence = values['approval-sequence'];
    if (typeof planId !== 'string' || !/^[a-f0-9]{64}$/.test(planId) || typeof sequence !== 'string' || !/^[1-9][0-9]*$/.test(sequence)) {
      throw new WorkerError('CLI_USAGE', 'Live execution requires --execute, --plan-id and --approval-sequence.');
    }
    assertLiveSkuPilot(store, bindingId);
    assertPilotPlan(store.shopifySkuJournal.getPlan(planId), bindingId);
    const result = await executeSkuReplacement(store, { execute: true, bindingId, planId, approvalSequence: Number(sequence) }, {
      ...shopifyEvidence(), readMasterInput, readExport, readPause: hextomPauseReader(process.env),
    }, shopifySkuWriter(process.env));
    if (result.status !== 'VERIFIED_COMPLETE') process.exitCode = 1;
    return result;
  }
  if (command === 'mockupify-sku-replacement-preview' || command === 'mockupify-sku-replacement-dry-run' ||
    command === 'mockupify-sku-replacement-approve') {
    const headerRow = masterInputHeaderRow(values['header-row']);
    const evidence = { ...shopifyEvidence(), readMasterInput: () => readMasterInputSkuRows(headerRow) };
    if (command === 'mockupify-sku-replacement-preview') return previewMockupifySkuReplacement(store, args[0]!, evidence);
    if (command === 'mockupify-sku-replacement-dry-run') return dryRunSkuReplacement(store, args[0]!, evidence);
    if (values['for-live'] === true) assertLiveSkuPilot(store, args[0]!);
    return approveSkuReplacement(store, args[0]!, args[1]!, requiredText(values.by, 'Approver supplied with --by'),
      requiredText(values.source, 'Execution approval evidence supplied with --source'), evidence, Date.now, values['for-live'] === true);
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
