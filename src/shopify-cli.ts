import { integer, object, readJson } from './config.js';
import { googleSheets, parseSheetPolicy, previewSheetArtwork } from './google-sheets.js';
import { WorkerError } from './model.js';
import { readProductionArtwork, simulatedSheets } from './sheets.js';
import { compareShopifyProduct, selectShopifyBinding, shopifyAssignment } from './shopify-comparison.js';
import { shopifyReadConfig, ShopifyReadonlyClient } from './shopify-readonly.js';

export const shopifyCommands = {
  'shopify-auth': {},
  'shopify-product': {},
  'shopify-variants': {},
  'shopify-preview': { fixture: { type: 'boolean' } },
  'shopify-compare': { fixture: { type: 'boolean' } },
} as const;

export async function runShopifyCommand(command: string, args: string[], fixture: boolean) {
  const comparison = command === 'shopify-preview' || command === 'shopify-compare';
  const count = comparison ? fixture ? 3 : 4 : command === 'shopify-auth' ? 0 : 1;
  if (args.length !== count) throw new WorkerError('CLI_USAGE', 'Wrong number of Shopify arguments. Run worker help for usage.');
  const config = shopifyReadConfig(process.env);
  const client = new ShopifyReadonlyClient(config);
  if (command === 'shopify-auth') return client.verifyShop();
  if (!comparison) {
    const product = await client.product(args[0]!);
    return command === 'shopify-variants' ? { productId: product.id, variants: product.variants } : product;
  }

  const row = integer(/^\d+$/.test(args[1]!) ? Number(args[1]) : NaN, 'Master Input row', 1, Number.MAX_SAFE_INTEGER);
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
