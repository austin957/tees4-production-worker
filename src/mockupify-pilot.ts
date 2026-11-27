import { isDeepStrictEqual } from 'node:util';
import { integer, object, onlyKeys, requiredText } from './config.js';
import { WorkerError } from './model.js';
import type { MockupifyReview, SupervisedMockupifyPlan } from './mockupify-writer-model.js';
import { masterInput } from './sheets.js';

export const mockupifyPilot = {
  row: 9,
  artworkSku: '8419620257',
  productSku: '8419620257-S105',
  sheetArtworkName: 'SKU TEST',
  title: 'Bold Arrow Emblem',
  vendor: 'test test',
  attribution: 'Tees-4',
  designTags: ['Family', 'Grandpa'],
  templateTags: ['readytobuy', 'adult', 'S105', 'adjust', 'stock'],
  garment: 'Adult Tank Top',
  templateId: 10779,
  colors: [{ name: 'Black', id: 20514 }, { name: 'White', id: 20515 }],
  variantCount: 14,
  catalogPrice: '18.99',
  shopId: 'gid://shopify/Shop/76973965603',
  shopDomain: '64c645.myshopify.com',
  pngSha256: '6bae2628c23f42d960ef36e488bde69f84fe994d68e084218674b465a9354d17',
};

function section(value: unknown, keys: string[], label: string) {
  const record = object(value, label);
  onlyKeys(record, keys, label);
  return record;
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\u0000')) {
    throw new WorkerError('INVALID_INPUT', `${label} requires a string.`);
  }
  return value;
}

export function parseMockupifyReview(value: unknown): MockupifyReview {
  const review = section(value, [
    'artworkRegistryName', 'artworkNameResolution', 'designerAttribution', 'design', 'shop', 'product',
    'exclusiveBatchControlEvidence', 'publicationSafety',
  ], 'Metadata review');
  const design = section(review.design, ['title', 'description', 'extra_title', 'search_tags', 'vendor', 'extra_price'], 'Design review');
  const shop = section(review.shop, ['id', 'domain', 'connectionEvidence'], 'Shop review');
  const product = section(review.product, ['title', 'descriptionHtml', 'vendor', 'tags', 'variants', 'status'], 'Product review');
  const safety = section(review.publicationSafety, ['evidence', 'startsAt', 'endsAt', 'minimumMinutes'], 'Publication safety');
  if (product.status !== 'ACTIVE' || !Array.isArray(product.tags) || !Array.isArray(product.variants)) {
    throw new WorkerError('INVALID_INPUT', 'Supply the expected Active product status, tags and variants.');
  }
  return {
    artworkRegistryName: requiredText(review.artworkRegistryName, 'Artwork registry name'),
    ...(review.artworkNameResolution === undefined ? {} : {
      artworkNameResolution: requiredText(review.artworkNameResolution, 'Artwork name resolution evidence'),
    }),
    designerAttribution: requiredText(review.designerAttribution, 'Designer attribution'),
    design: {
      title: exactText(design.title, 'Design title'),
      description: exactText(design.description, 'Design description'),
      extra_title: exactText(design.extra_title, 'Design extra_title'),
      search_tags: exactText(design.search_tags, 'Design search_tags'),
      vendor: exactText(design.vendor, 'Design vendor'),
      extra_price: exactText(design.extra_price, 'Design extra_price'),
    },
    shop: {
      id: requiredText(shop.id, 'Shop GID'),
      domain: requiredText(shop.domain, 'Shop domain'),
      connectionEvidence: requiredText(shop.connectionEvidence, 'Mockupify shop connection evidence'),
    },
    product: {
      title: exactText(product.title, 'Expected Shopify title'),
      descriptionHtml: exactText(product.descriptionHtml, 'Expected Shopify descriptionHtml'),
      vendor: exactText(product.vendor, 'Expected Shopify vendor'),
      tags: product.tags.map(tag => exactText(tag, 'Expected Shopify tag')),
      variants: product.variants.map(entry => {
        const variant = section(entry, ['options', 'price'], 'Expected Shopify variant');
        const options = object(variant.options, 'Expected Shopify variant options');
        return {
          options: Object.fromEntries(Object.entries(options).map(([name, selection]) =>
            [name, exactText(selection, 'Expected Shopify option value')])),
          price: exactText(variant.price, 'Expected Shopify variant price'),
        };
      }),
      status: product.status,
    },
    exclusiveBatchControlEvidence: requiredText(review.exclusiveBatchControlEvidence, 'Exclusive batch control evidence'),
    publicationSafety: {
      evidence: requiredText(safety.evidence, 'Publication safety evidence'),
      startsAt: integer(safety.startsAt, 'Publication safety startsAt', 1, Number.MAX_SAFE_INTEGER),
      endsAt: integer(safety.endsAt, 'Publication safety endsAt', 1, Number.MAX_SAFE_INTEGER),
      minimumMinutes: integer(safety.minimumMinutes, 'Publication safety minimumMinutes', 1, Number.MAX_SAFE_INTEGER),
    },
  };
}

export function assertMockupifyPilotReview(review: MockupifyReview): void {
  const pilot = mockupifyPilot;
  const { design, shop, product } = review;
  const expectedProductTags = [...pilot.designTags, ...pilot.templateTags].sort();
  if (review.artworkRegistryName !== pilot.title || review.designerAttribution !== pilot.attribution ||
    design.title !== pilot.title || design.vendor !== pilot.vendor || product.vendor !== pilot.vendor ||
    design.extra_title !== '' || design.extra_price !== '0.00' || design.search_tags !== pilot.designTags.join(', ') ||
    !isDeepStrictEqual([...product.tags].sort(), expectedProductTags) || product.variants.length !== pilot.variantCount ||
    shop.id !== pilot.shopId || shop.domain !== pilot.shopDomain) {
    throw new WorkerError('MOCKUPIFY_PILOT_REVIEW_MISMATCH', 'The reviewed metadata must match the exact approved Bold Arrow Emblem pilot.');
  }
}

export function assertMockupifyPilotPlan(plan: SupervisedMockupifyPlan): void {
  const pilot = mockupifyPilot;
  const { source, correlation, review, catalogColors } = plan;
  assertMockupifyPilotReview(review);
  if (correlation.spreadsheetId !== masterInput.spreadsheetId || source.sourceRow !== pilot.row ||
    source.artworkSku !== pilot.artworkSku || source.productSku !== pilot.productSku ||
    source.sheetArtworkName !== pilot.sheetArtworkName || source.title !== pilot.title ||
    source.vendor !== pilot.vendor || source.tags !== pilot.designTags.join(', ') || source.garment !== pilot.garment ||
    correlation.mockupifyTemplateId !== pilot.templateId ||
    !isDeepStrictEqual(correlation.mockupifyColorIds, pilot.colors.map(color => color.id)) ||
    !isDeepStrictEqual(catalogColors.map(({ id, name }) => ({ name, id })), pilot.colors) ||
    catalogColors.some(color => color.price !== pilot.catalogPrice)) {
    throw new WorkerError('MOCKUPIFY_PILOT_PLAN_MISMATCH', 'The live source and catalog must match the approved pilot row, template, colors and catalog price.');
  }
  if (correlation.preparedArtworkSha256 !== pilot.pngSha256) {
    throw new WorkerError('MOCKUPIFY_PNG_EVIDENCE_MISMATCH', 'The prepared artwork digest must match the approved pilot PNG.');
  }
  const combinations = new Set(catalogColors.flatMap(color =>
    color.sizes.map(size => JSON.stringify([color.name, size].sort()))));
  const reviewedCombinations = new Set(review.product.variants.map(variant =>
    JSON.stringify(Object.values(variant.options).sort())));
  if (combinations.size !== pilot.variantCount || !isDeepStrictEqual(reviewedCombinations, combinations)) {
    throw new WorkerError('MOCKUPIFY_PILOT_VARIANTS_MISMATCH', 'Review all 14 distinct catalog color and size combinations with their expected Shopify option names and prices.');
  }
}
