import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { simulatedAdapters } from './adapters.js';
import { object, onlyKeys, parseMode, readJson, settings } from './config.js';
import { googleSheets, parseSheetPolicy, previewSheetArtwork } from './google-sheets.js';
import { runMockupifyExport } from './export-runner.js';
import { planMockupifyExport, simulatedMockupifyExports } from './mockupify.js';
import { asWorkerError, WorkerError } from './model.js';
import { bindingCommands, runBindingCommand } from './product-binding-cli.js';
import { readProductionArtwork, simulatedSheets } from './sheets.js';
import { runShopifyCommand, shopifyCommands } from './shopify-cli.js';
import { Store } from './store.js';
import { report, Worker } from './worker.js';

const help = `Tees-4 Production Worker
  submit <artwork.json> [--mode dry-run|simulate]
  submit-sheet <sheet-fixture.json> [--mode dry-run|simulate]
  preview-google-sheet <artwork-selection.json> <policy.json>
  submit-google-sheet <artwork-selection.json> <policy.json>
  load-shopify-fixture <shopify-fixture.json>
  load-sheet-fixture <sheet-fixture.json>
  queue-export <sheet-fixture.json> <mockupify-mapping.json> [--mode dry-run|simulate]
  run-export <export-id>
  inspect-export <export-id>
  reconcile-export <export-id> <verified-evidence.json>
  run [--limit <count>] [--fail-after-create]
  list
  inspect <job-id>
  approve <job-id> <stage-id> --by <approver>
  effects
  binding-list
  binding-inspect <binding-id>
  binding-propose <assignment.json> --by <operator>
  binding-review <binding-id> approve --by <owner> --source <evidence-ref> [--header-row <number>]
  binding-review <binding-id> reject --by <operator> --reason <reason>
  binding-review <binding-id> recheck --by <operator> [--header-row <number>]
  shopify-auth
  shopify-adjust [shopify-product-gid]
  shopify-match [--confirmations <owner.json>] [--sheet-fixture <fixture.json> | --header-row <number>]
  shopify-hextom-verify <shopify-product-gid> [--verified-base-sku <sku>]
  shopify-production-audit <shopify-product-gid>
    [--candidate-base-sku <sku> | --verified-source <record.json> [--read-master-input [--header-row <number>]]]
  shopify-sku-preview <shopify-product-gid> --shop-id <shop-gid> --row <number> --product-sku <sku> --artwork-sku <sku>
    --diagnostic | --confirmations <owner.json> [--header-row <number>]
  shopify-reconcile <shopify-product-gid> --product-sku <sku> --artwork-sku <sku> --evidence-ref <ref>
    [--row <number>] [--verified-source <record.json>] [--sheet-fixture <fixture.json> | --header-row <number>]
  shopify-identify
  shopify-products
  shopify-product <shopify-product-gid>
  shopify-provenance <shopify-product-gid>
  shopify-variants <shopify-product-gid>
  shopify-compare <bindings.json> <row> <artwork-selection.json> <policy.json>
  shopify-preview <bindings.json> <row> <artwork-selection.json> <policy.json>
  Use --fixture with shopify-compare or shopify-preview to supply a sheet fixture instead of the selection and policy.
  help

Run from the project root. TEES4_CONFIG and TEES4_DATABASE override the local file paths.
Dry-run is the default. The simulate mode only writes to local SQLite.`;

function positional(values: string[], count: number): void {
  if (values.length !== count) {
    throw new WorkerError('CLI_USAGE', 'Wrong number of arguments. Run worker help for usage.');
  }
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) {
    console.log(help);
    return;
  }

  const commandOptions = {
    ...shopifyCommands,
    ...bindingCommands,
    submit: { mode: { type: 'string' } },
    'submit-sheet': { mode: { type: 'string' } },
    'preview-google-sheet': {},
    'submit-google-sheet': {},
    'load-shopify-fixture': {},
    'load-sheet-fixture': {},
    'queue-export': { mode: { type: 'string' } },
    'run-export': {},
    'inspect-export': {},
    'reconcile-export': {},
    run: { limit: { type: 'string' }, 'fail-after-create': { type: 'boolean' } },
    approve: { by: { type: 'string' } },
    list: {}, inspect: {}, effects: {},
  } as const;
  if (!Object.hasOwn(commandOptions, command)) throw new WorkerError('CLI_USAGE', 'Unknown command. Run worker help for usage.');
  const options: NonNullable<ParseArgsConfig['options']> = commandOptions[command as keyof typeof commandOptions];
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true });
  } catch (error) {
    throw new WorkerError('CLI_USAGE', error instanceof Error ? error.message : 'Invalid command options.');
  }
  const { positionals, values } = parsed;
  if (Object.hasOwn(shopifyCommands, command)) {
    const result = await runShopifyCommand(command, positionals, values);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const { workflowPath, databasePath, exportMarginMinutes } = settings(process.env);
  let selectedArtwork;
  if (command === 'preview-google-sheet' || command === 'submit-google-sheet') {
    positional(positionals, 2);
    const selection = readJson(positionals[0]!, 'artwork selection');
    const policy = parseSheetPolicy(readJson(positionals[1]!, 'sheet policy'));
    const preview = await previewSheetArtwork(selection, policy, googleSheets(policy));
    if (command === 'preview-google-sheet') {
      console.log(JSON.stringify(preview, null, 2));
      return;
    }
    if (preview.status !== 'ready' || !preview.artwork) {
      throw new WorkerError('SHEET_NOT_READY', `Sheet selection is ${preview.status}. Run preview-google-sheet to inspect its rows.`);
    }
    selectedArtwork = preview.artwork;
  }
  const store = new Store(databasePath);
  try {
    if (Object.hasOwn(bindingCommands, command)) {
      const result = await runBindingCommand(store, command, positionals, values);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const adapters = simulatedAdapters(store);
    if (values['fail-after-create']) {
      const create = adapters.shopify.create;
      let injected = false;
      adapters.shopify.create = async request => {
        const result = await create(request);
        if (!result.reused && !injected) {
          injected = true;
          throw new WorkerError('SIMULATED_TIMEOUT', 'Simulated a timeout after recording product creation.', true);
        }
        return result;
      };
    }
    const worker = new Worker(
      store, adapters, entry => console.error(JSON.stringify(entry)), Date.now, undefined, exportMarginMinutes,
    );
    let output: unknown;
    switch (command) {
      case 'submit': {
        positional(positionals, 1);
        const result = worker.submit(readJson(positionals[0]!, 'artwork'), readJson(workflowPath, 'workflow'), values.mode);
        output = { duplicate: result.duplicate, ...report(result.job) };
        break;
      }
      case 'queue-export':
      case 'load-sheet-fixture':
      case 'submit-sheet': {
        positional(positionals, command === 'queue-export' ? 2 : 1);
        const fixture = object(readJson(positionals[0]!, 'sheet fixture'), 'Sheet fixture');
        onlyKeys(fixture, ['artwork', 'rows'], 'Sheet fixture');
        if (command === 'load-sheet-fixture') {
          output = { imported: store.importSheetFixtures(fixture.rows) };
          break;
        }
        const artwork = await readProductionArtwork(fixture.artwork, simulatedSheets(fixture.rows));
        if (command === 'queue-export') {
          const plan = planMockupifyExport(artwork, readJson(positionals[1]!, 'Mockupify mapping'));
          output = store.queueExport(plan, parseMode(values.mode ?? 'dry-run'), Date.now());
          break;
        }
        const result = worker.submit(artwork, readJson(workflowPath, 'workflow'), values.mode);
        output = { duplicate: result.duplicate, ...report(result.job) };
        break;
      }
      case 'submit-google-sheet': {
        const result = worker.submit(selectedArtwork, readJson(workflowPath, 'workflow'));
        output = { duplicate: result.duplicate, ...report(result.job) };
        break;
      }
      case 'load-shopify-fixture':
        positional(positionals, 1);
        output = { imported: store.importShopifyFixtures(readJson(positionals[0]!, 'Shopify fixture')) };
        break;
      case 'run-export':
        positional(positionals, 1);
        output = await runMockupifyExport(store, positionals[0]!, simulatedMockupifyExports(), Date.now, exportMarginMinutes);
        break;
      case 'inspect-export':
        positional(positionals, 1);
        output = store.getExport(positionals[0]!);
        break;
      case 'reconcile-export':
        positional(positionals, 2);
        output = store.recordExportEvidence(positionals[0]!, readJson(positionals[1]!, 'verified export evidence'));
        break;
      case 'run': {
        positional(positionals, 0);
        const limit = Number(values.limit ?? 100);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
          throw new WorkerError('CLI_USAGE', 'The run limit must be an integer from 1 through 10000.');
        }
        const summary = await worker.runAvailable(limit);
        output = summary;
        if (summary.failed.length) process.exitCode = 1;
        break;
      }
      case 'list':
        positional(positionals, 0);
        output = store.list().map(report);
        break;
      case 'inspect':
        positional(positionals, 1);
        output = report(store.get(positionals[0]!));
        break;
      case 'approve':
        positional(positionals, 2);
        if (typeof values.by !== 'string') throw new WorkerError('CLI_USAGE', 'Approval requires --by <approver>.');
        output = report(worker.approve(positionals[0]!, positionals[1]!, values.by));
        break;
      case 'effects':
        positional(positionals, 0);
        output = store.effectCounts();
        break;
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    store.close();
  }
}

main().catch(caught => {
  const error = asWorkerError(caught);
  console.error(JSON.stringify({ at: Date.now(), level: 'error', event: 'command_failed', code: error.code, message: error.message }));
  process.exitCode = 1;
});
