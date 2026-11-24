import { integer, object, onlyKeys, requiredText } from './config.js';
import { WorkerError } from './model.js';
import type { Mode, ProductionArtwork } from './model.js';
import { parseShopifyCatalog } from './shopify-skus.js';
import type { ShopifyProduct } from './shopify-skus.js';

interface TemplateMapping {
  templateId: string;
  colors: Record<string, string>;
}

export interface ExportPlan {
  artworkSku: string;
  designTitle: string;
  artworkRef: string;
  batchId: string;
  products: {
    sourceRow: number;
    productSku: string;
    title: string;
    description: string;
    vendor: string;
    tags: string;
    garment: string;
    templateId: string | null;
    colors: { label: string; mockupifyColorId: string | null }[];
  }[];
  issues: { sourceRow: number; code: 'UNMAPPED_TEMPLATE' | 'UNMAPPED_COLOR' | 'AMBIGUOUS_COLORS'; value: string }[];
}

export interface ExportBinding {
  sourceRow: number;
  product: ShopifyProduct;
}

export interface ExportEvidence {
  correlationId: string;
  exportRef: string;
  bindings: ExportBinding[];
}

export interface ExportJob {
  id: string;
  mode: Mode;
  plan: ExportPlan;
  status: 'planned' | 'needs_review' | 'queued' | 'deferred' | 'dispatching' | 'uncertain' | 'completed';
  availableAt: number;
  code?: string;
  evidence?: ExportEvidence;
}

export interface MockupifyExportAdapter {
  // Preparation may read. Invoke begin immediately before the first irreversible export operation.
  export(plan: ExportPlan, correlationId: string, begin: () => boolean): Promise<unknown>;
}

export function planMockupifyExport(artwork: ProductionArtwork, input: unknown): ExportPlan {
  const config = object(input, 'Mockupify mapping');
  onlyKeys(config, ['batchId', 'templates'], 'Mockupify mapping');
  const batchId = requiredText(config.batchId, 'Mockupify batch ID');
  const templates = new Map<string, TemplateMapping>();
  for (const [label, entry] of Object.entries(object(config.templates, 'Mockupify template mappings'))) {
    requiredText(label, 'Garment selection');
    const template = object(entry, 'Mockupify template');
    onlyKeys(template, ['templateId', 'colors'], 'Mockupify template');
    const colors = Object.fromEntries(Object.entries(object(template.colors, 'Mockupify color mappings')).map(([name, id]) => [
      requiredText(name, 'Sheet color label'), requiredText(id, 'Mockupify color ID'),
    ]));
    templates.set(label, { templateId: requiredText(template.templateId, 'Mockupify template ID'), colors });
  }

  const issues: ExportPlan['issues'] = [];
  const products = artwork.garments.map(garment => {
    const { sourceRow, productSku } = garment;
    const template = templates.get(garment.garmentSelection);
    if (!template) issues.push({ sourceRow, code: 'UNMAPPED_TEMPLATE', value: garment.garmentSelection });
    const labels = garment.colors.split(',').map(label => label.trim());
    const colors = labels.map(label => {
      const id = template && Object.hasOwn(template.colors, label) ? template.colors[label]! : null;
      if (!id) issues.push({ sourceRow, code: 'UNMAPPED_COLOR', value: label });
      return { label, mockupifyColorId: id };
    });
    const ids = colors.flatMap(color => color.mockupifyColorId ? [color.mockupifyColorId] : []);
    if (new Set(labels).size !== labels.length || new Set(ids).size !== ids.length) {
      issues.push({ sourceRow, code: 'AMBIGUOUS_COLORS', value: garment.colors });
    }
    return {
      sourceRow, productSku, title: garment.productTitle, description: garment.productDescription, vendor: garment.vendor,
      tags: garment.tags, garment: garment.garmentSelection, templateId: template?.templateId ?? null, colors,
    };
  });
  return { artworkSku: artwork.artworkSku, designTitle: artwork.artworkName, artworkRef: artwork.artworkRef, batchId, products, issues };
}

export function parseExportEvidence(input: unknown, job: ExportJob): ExportEvidence {
  const raw = object(input, 'Mockupify export evidence');
  onlyKeys(raw, ['correlationId', 'exportRef', 'products'], 'Mockupify export evidence');
  const correlationId = requiredText(raw.correlationId, 'Export correlation ID');
  if (correlationId !== job.id) throw new WorkerError('EXPORT_BINDING_CONFLICT', 'The evidence belongs to another export.');
  const exportRef = requiredText(raw.exportRef, 'Mockupify export reference');
  if (!Array.isArray(raw.products) || !raw.products.length) {
    throw new WorkerError('INVALID_EXPORT_EVIDENCE', 'Supply at least one product with verified product and variant IDs.');
  }
  const rows = new Set<number>();
  const products = (raw.products as unknown[]).map(entry => {
    const item = object(entry, 'Exported product');
    onlyKeys(item, ['sourceRow', 'artworkSku', 'productSku', 'id', 'variants'], 'Exported product');
    const sourceRow = integer(item.sourceRow, 'Source row', 1, Number.MAX_SAFE_INTEGER);
    const expected = job.plan.products.find(row => row.sourceRow === sourceRow);
    if (rows.has(sourceRow) || !expected || item.artworkSku !== job.plan.artworkSku || item.productSku !== expected.productSku) {
      throw new WorkerError('EXPORT_BINDING_CONFLICT', 'Export evidence does not uniquely match the planned row and SKUs.');
    }
    rows.add(sourceRow);
    if (!Array.isArray(item.variants)) throw new WorkerError('INVALID_EXPORT_EVIDENCE', 'Supply the authoritative variant IDs.');
    const variants = (item.variants as unknown[]).map(entry => {
      const variant = object(entry, 'Exported variant');
      onlyKeys(variant, ['id', 'size', 'color'], 'Exported variant');
      return { ...variant, sku: null };
    });
    return { sourceRow, product: { ...item, sourceRow, mockupifyExportRef: exportRef, variants } };
  });
  const catalog = parseShopifyCatalog(products.map(row => row.product));
  return {
    correlationId, exportRef,
    bindings: products.map((row, index) => ({ sourceRow: row.sourceRow, product: catalog[index]! })),
  };
}

export function simulatedMockupifyExports(): MockupifyExportAdapter {
  return {
    async export(plan, correlationId, begin) {
      if (!begin()) return undefined;
      return {
        correlationId, exportRef: `fixture-export-${correlationId}`,
        products: plan.products.map(row => ({
          id: `fixture-product-${correlationId}-${row.sourceRow}`,
          sourceRow: row.sourceRow, artworkSku: plan.artworkSku, productSku: row.productSku,
          variants: row.colors.map((color, index) => ({
            id: `fixture-variant-${correlationId}-${row.sourceRow}-${index + 1}`, size: 'Fixture size', color: color.label,
          })),
        })),
      };
    },
  };
}
