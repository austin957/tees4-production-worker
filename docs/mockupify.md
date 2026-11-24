# Phase 5 Mockupify export preparation

## Integration capabilities

The owner-confirmed Mockupify workflow uploads one design at a time, adds it to a batch, selects product templates and colors, and exports the selected products to Shopify. The design and garment metadata come from **Master Input** in **Design Input Master**. The [existing column map](sku-processing.md) identifies those fields and both assigned SKUs.

The public [Mockupify site](https://mockupify.io/) and [Shopify App Store](https://apps.shopify.com/) could not be inspected from this environment because the HTTPS proxy denied both destinations. The repository contains no vendor integration documentation. The availability of a supported API, webhook, export log, or other automation interface is unverified. Browser automation is a fallback if the vendor confirms that no suitable supported interface exists and permits automated UI use. Phase 5 includes a simulated adapter contract. It does not rely on guessed endpoints or private browser requests.

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

1. Provide Mockupify's current API or partner documentation, or vendor confirmation of which automation interfaces are available and whether UI automation is permitted. Include supported authentication, export status lookup, and whether an idempotency key or stable correlation can round-trip.
2. Identify the approved Mockupify workspace, one test batch, and the Shopify test store and its immutable shop identifier. Arrange supervised access through the approved identity flow, with the minimum permissions needed to view the export and Shopify IDs. Keep credentials in the approved secret store.
3. Provide one approved artwork reference, the exact Master Input row numbers and existing Artwork/Product SKUs, and the expected titles, descriptions, vendor and tags for the test products. Confirm column F's color encoding.
4. Provide the actual template IDs for those garments, supported color IDs or exact UI labels, and expected Shopify size/color variants. Confirm how template and batch IDs can be read in the supported interface.
5. Identify the observable evidence linking each exported garment to its Shopify product ID and full variant list, and the operator who will reconcile partial or uncertain results. Confirm what constitutes proof that an export did not happen.
6. Approve the execution time, measured or conservative export safety margin, target shop, and exact side effects for one supervised export. Confirm any Shopify visibility or publication settings before dispatch.
