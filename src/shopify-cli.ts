import { integer, object, readJson, requiredText } from './config.js';
import { googleSheets, parseSheetPolicy, previewSheetArtwork, readMasterInputSkuRows } from './google-sheets.js';
import { WorkerError } from './model.js';
import { readProductionArtwork, simulatedSheets } from './sheets.js';
import { verifyHextom } from './shopify-hextom.js';
import { discoverAdjustProducts, summarizeAdjustProduct } from './shopify-adjust.js';
import { compareShopifyProduct, selectShopifyBinding, shopifyAssignment } from './shopify-comparison.js';
import { parseSheetFixture, parseVerifiedSource, reconcileShopifySource } from './shopify-reconciliation.js';
import type { ReconciliationRequest, SheetEvidence } from './shopify-reconciliation.js';
import { identifyShop, shopifyGid, shopifyIdentifyConfig, shopifyReadConfig, ShopifyReadonlyClient } from './shopify-readonly.js';

export const shopifyCommands = {
  'shopify-auth': {},
  'shopify-adjust': {},
  'shopify-hextom-verify': { 'verified-base-sku': { type: 'string' } },
  'shopify-reconcile': {
    'product-sku': { type: 'string' }, 'artwork-sku': { type: 'string' }, 'evidence-ref': { type: 'string' },
    row: { type: 'string' }, 'verified-source': { type: 'string' }, 'sheet-fixture': { type: 'string' },
    'header-row': { type: 'string' },
  },
  'shopify-identify': {},
  'shopify-product': {},
  'shopify-products': {},
  'shopify-provenance': {},
  'shopify-variants': {},
  'shopify-preview': { fixture: { type: 'boolean' } },
  'shopify-compare': { fixture: { type: 'boolean' } },
} as const;

function readRowNumber(input: unknown, label: string): number {
  return integer(typeof input === 'string' && /^\d+$/.test(input) ? Number(input) : NaN, label, 1, Number.MAX_SAFE_INTEGER);
}

async function readSourceSheet(values: Record<string, unknown>): Promise<SheetEvidence> {
  if (values['sheet-fixture'] !== undefined) {
    if (values['header-row'] !== undefined) throw new WorkerError('CLI_USAGE', 'Use --header-row only with the live sheet read.');
    return parseSheetFixture(readJson(requiredText(values['sheet-fixture'], 'Sheet fixture path'), 'sheet fixture'));
  }
  const headerRow = readRowNumber(values['header-row'] ?? '1', 'Master Input header row');
  try {
    return { kind: 'live', rows: await readMasterInputSkuRows(headerRow) };
  } catch (error) {
    if (!(error instanceof WorkerError)) throw error;
    return { kind: 'unavailable', code: error.code, message: error.message };
  }
}

export async function runShopifyCommand(command: string, args: string[], values: Record<string, unknown>) {
  const fixture = values.fixture === true;
  const comparison = command === 'shopify-preview' || command === 'shopify-compare';
  const noArguments = command === 'shopify-auth' || command === 'shopify-identify' || command === 'shopify-products';
  const count = comparison ? fixture ? 3 : 4 : noArguments ? 0 : 1;
  if (command === 'shopify-adjust' ? args.length > 1 : args.length !== count) throw new WorkerError('CLI_USAGE', 'Wrong number of Shopify arguments. Run worker help for usage.');
  if (command === 'shopify-identify') return identifyShop(shopifyIdentifyConfig(process.env));
  const config = shopifyReadConfig(process.env);
  const client = new ShopifyReadonlyClient(config);
  if (command === 'shopify-auth') return client.verifyShop();
  if (command === 'shopify-adjust') {
    return args[0] ? summarizeAdjustProduct(await client.product(args[0])) : discoverAdjustProducts(client);
  }
  if (command === 'shopify-hextom-verify') {
    const base = values['verified-base-sku'];
    return verifyHextom(await client.product(args[0]!), typeof base === 'string' ? base : undefined);
  }
  if (command === 'shopify-reconcile') {
    const request: ReconciliationRequest = {
      productId: shopifyGid(args[0], 'Product'),
      productSku: requiredText(values['product-sku'], 'Source Product SKU'),
      artworkSku: requiredText(values['artwork-sku'], 'Source Artwork SKU'),
      evidenceReference: requiredText(values['evidence-ref'], 'Source evidence reference'),
      ...(values.row === undefined ? {} : { rowNumber: readRowNumber(values.row, 'Master Input row') }),
    };
    const verifiedSource = values['verified-source'] === undefined ? undefined : parseVerifiedSource(
      readJson(requiredText(values['verified-source'], 'Verified source path'), 'verified source record'),
    );
    const [product, sheet] = await Promise.all([client.product(request.productId), readSourceSheet(values)]);
    return reconcileShopifySource(request, config.shopId, product, sheet, verifiedSource);
  }
  if (command === 'shopify-products') return client.recentProducts();
  if (command === 'shopify-provenance') return client.productProvenance(args[0]!);
  if (!comparison) {
    const product = await client.product(args[0]!);
    return command === 'shopify-variants' ? { productId: product.id, variants: product.variants } : product;
  }

  const row = readRowNumber(args[1], 'Master Input row');
  const binding = selectShopifyBinding(readJson(args[0]!, 'Shopify bindings'), config.shopId, row);
  const source = readJson(args[2]!, fixture ? 'sheet fixture' : 'artwork selection');
  let artwork;
  if (fixture) {
    const input = object(source, 'Sheet fixture');
    artwork = await readProductionArtwork(input.artwork, simulatedSheets(input.rows));
  } else {
    const policy = parseSheetPolicy(readJson(args[3]!, 'sheet policy'));
    const selected = await previewSheetArtwork(source, policy, googleSheets(policy));
    // Accept an independently verified target row even when another garment has a review issue.
    if (!selected.artwork || !selected.rows.some(candidate => candidate.rowNumber === row && candidate.status === 'eligible')) {
      throw new WorkerError('SHOPIFY_BINDING_MISMATCH', 'The target is not an eligible, verified Master Input row.');
    }
    artwork = selected.artwork;
  }
  const assignment = shopifyAssignment(artwork, binding);
  const report = compareShopifyProduct(await client.product(binding.id), binding, assignment);
  return command === 'shopify-preview' ? {
    binding: report.binding, status: report.status, expectedProductSku: report.expectedProductSku,
    proposedAssignments: report.proposedAssignments, blankVariantIds: report.blankVariantIds,
  } : report;
}
