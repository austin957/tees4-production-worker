# Mockupify reads and export preparation

## Integration capabilities

The owner-confirmed Mockupify workflow uploads one design at a time, adds it to a batch, selects product templates and colors, and exports the selected products to Shopify. The design and garment metadata come from **Master Input** in **Design Input Master**. The [existing column map](sku-processing.md) identifies those fields and both assigned SKUs.

## Read the private API

Set `TEES4_MOCKUPIFY_API_KEY` in the worker runtime. Build the worker, then run these commands from the project root.

```sh
npm run build
npm run --silent worker -- mockupify-auth
npm run --silent worker -- mockupify-batches
npm run --silent worker -- mockupify-designs
npm run --silent worker -- mockupify-designs BATCH_ID
npm run --silent worker -- mockupify-products
npm run --silent worker -- mockupify-exports
npm run --silent worker -- mockupify-export EXPORT_ID
```

In environments that route HTTPS through a proxy, set `NODE_USE_ENV_PROXY=1` to use the runtime's proxy settings. The commands send authenticated GET requests to `https://mockupify.io` and return selected metadata as JSON. Export details expose status, template and color IDs where present, and each returned Shopify ID. They omit raw vendor error messages and design file URLs. The export queue uses the simulator.

The [Mockupify API documentation](https://mockupify.io/docs/api/) requires a dashboard session. Request the [OpenAPI schema](https://mockupify.io/api/schema/) with `Accept: application/json` for the machine-readable contract. The list commands follow numbered pages. The live API has returned `http:` pagination links. The client validates the next page and reconstructs the request on the fixed HTTPS origin. HTTP 429 responses use `Retry-After` when available, with bounded retries and waits.

Historical exports can return `batch: null` even though OpenAPI declares a batch object. They can also return a finished status with an empty products list. Treat those details as incomplete provenance. The client preserves explicit Shopify Product GIDs and represents missing Shopify IDs as null. Use the current batch and design lists to establish current availability.

## Plan and simulate an export

The planner uses the existing sheet-backed artwork model. It records the Artwork SKU, artwork name and reference, configured batch ID, and one product assignment per physical sheet row. Each assignment preserves column B through H values relevant to export, including the title, description, vendor, tags, exact assigned Product SKU, garment selection, and selected colors.

Supply exact garment labels, template IDs and color IDs in a mapping file. The [example mapping](../examples/mockupify-mapping.json) covers two fixture garments. Color selections in the fixture are comma-separated labels with optional spacing. Unmapped garments, missing colors, and ambiguous repeated color selections block dispatch and appear in the plan for review. Confirm the actual sheet color encoding and template inventory before live use.

```sh
npm ci
npm run build
export TEES4_DATABASE=.tees4/phase-5.sqlite
npm run --silent worker -- queue-export examples/sheet-input.json examples/mockupify-mapping.json
npm run --silent worker -- inspect-export EXPORT_ID
```

These commands default to a dry-run plan. To exercise the simulator, add `--mode simulate` when queuing, set the existing `TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES` to a positive whole number, and run `npm run --silent worker -- run-export EXPORT_ID` outside the protected window and before the margin cutoff. Successful fixture exports populate the same local Shopify catalog used by the garment completion workflow. Use the same SQLite database and load the matching sheet fixture before running that workflow.

## Dispatch and reconciliation

The export queue is stored in the worker's SQLite database. `run-export` processes a specific export independently of the existing completion queue. Identical submissions reuse their export ID. A simulated export reserves each Product SKU and refuses to dispatch if a Shopify binding already exists. Before dispatch, the adapter must durably claim the export and pass the **4:20 PM inclusive to 9:10 PM exclusive America/Chicago** guard and the configured margin check. The claim is committed before dispatch and the time is checked again before returning permission to start.

An interrupted dispatch stays `dispatching`. Lost responses, invalid acknowledgments, and partial results leave it `uncertain`. Neither state can dispatch again. The worker does not assume an external export can be cancelled. A trusted result can be recorded incrementally using `reconcile-export EXPORT_ID EVIDENCE_JSON`. Evidence has this shape, with an entry for each garment verified so far.

```json
{
  "correlationId": "EXPORT_ID",
  "exportRef": "vendor-export-reference",
  "products": [
    {
      "sourceRow": 2,
      "artworkSku": "00042",
      "productSku": "000710",
      "id": "explicit-shopify-product-id",
      "variants": [
        { "id": "explicit-shopify-variant-id", "size": "M", "color": "White" }
      ]
    }
  ]
}
```

Supply the complete variant set for each verified garment. The worker checks the export correlation and reference, source row, both SKUs, and product and variant IDs before persisting bindings. It does not use titles to match a result. Existing or conflicting bindings cannot be replaced. An export completes when every planned row has verified IDs. When the provider cannot prove an outcome, the export stays held. This phase includes no reset or resend command for an uncertain export.

## Owner inputs before a supervised live test

1. Confirm whether an idempotency key or stable correlation can round-trip through Mockupify's export API.
2. Identify the approved Mockupify workspace, one test batch, and the Shopify test store and its immutable shop identifier. Arrange supervised access through the approved identity flow, with the minimum permissions needed to view the export and Shopify IDs. Keep credentials in the approved secret store.
3. Provide one approved artwork reference, the exact Master Input row numbers and existing Artwork/Product SKUs, and the expected titles, descriptions, vendor and tags for the test products. Confirm column F's color encoding.
4. Provide the actual template IDs for those garments, supported color IDs or exact UI labels, and expected Shopify size/color variants. Confirm how template and batch IDs can be read in the supported interface.
5. Identify the observable evidence linking each exported garment to its Shopify product ID and full variant list, and the operator who will reconcile partial or uncertain results. Confirm what constitutes proof that an export did not happen.
6. Approve the execution time, measured or conservative export safety margin, target shop, and exact side effects for one supervised export. Confirm any Shopify visibility or publication settings before dispatch.
