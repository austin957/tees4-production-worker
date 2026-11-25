# Mockupify reads and export preparation

The [Phase 20 supervised writer](mockupify-writer.md) implements the requests in simulation and documents recovery and the offline row 36 trace.

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

The client preserves explicit Shopify Product GIDs and represents missing Shopify IDs as null.

## Preview live-catalog mappings

Use `mockupify-plan` with the exact Artwork SKU. The command reads the Master Input tab through read-only Google Application Default Credentials. Column E defaults to the observed `Product` header. Use `--header-row` and `--garment-header` for a verified alternate layout. A synthetic fixture can supply rows when ADC is unavailable, while template and batch checks still use the live Mockupify API.

```sh
npm run --silent worker -- mockupify-plan ARTWORK_SKU examples/mockupify-template-candidates.json
npm run --silent worker -- mockupify-plan 00042 examples/mockupify-template-candidates.json \
  --sheet-fixture examples/mockupify-plan-rows.json
```

Keep explicit mappings in a JSON configuration file. The candidate file pairs exact garment labels with the expected account template ID, title and type. The preview checks all configured candidates against the live catalog and requires owner review of the mapping fingerprint before any future dispatch. A catalog match establishes that the template exists with the configured identity. The owner must confirm that it represents the intended production garment. Keep any additional garment labels as explicit mappings for review.

The preview preserves the physical row, Artwork SKU, Product SKU, original color cell and order of the requested colors. It interprets column F as comma-delimited names with whitespace around separators. Each name must match the catalog exactly within the mapped template. Blanks, unknown names, duplicate requests, ambiguous names and reused color IDs require review. Numeric sheet color codes need an owner-verified interpretation before they can resolve to catalog names. Use exact displayed SKU strings, including leading zeros. A Product SKU repeated elsewhere in the input blocks the row. The command uses the existing local SQLite registry in read-only mode to flag proposed or approved bindings for the same physical row or Product SKU. If the database path is absent, the preview reports the missing registry.

### Batch isolation

The OpenAPI export request accepts one batch ID and one list of color IDs. Mockupify applies the selected templates and colors to every design in the batch. A shared batch can represent an identical template and color selection for every design. It cannot express different selections per design. Combining different per-design lists would export unwanted products or colors.

The preview recommends one future isolated batch per Product SKU, containing exactly one intended design and the row's exact color IDs from one template. Multiple Product SKUs can reference the same artwork and have separate isolated batches. The configured Design Input batch is inspected only. Every current member is treated as outside the proposed export because a preview has no verified design placement. An empty observation does not reserve the batch. Immediately before any separately authorized future dispatch, require verified exclusive control of the isolated batch, recheck that its sole member is the exact expected design, revalidate the source row, approved mapping, catalog selections and registry, and apply the existing 4:20–9:10 PM America/Chicago write restriction and export safety margin.

### Export-to-binding evidence

A resolved preview row contains a binding draft with the Master Input spreadsheet ID, physical row, Product SKU, Artwork SKU, Mockupify template ID and exact color IDs. Mockupify batch, design and export IDs, Shopify shop GID and Shopify Product GID start as null. A future verified record must capture those identifiers from trusted evidence linked to the exact row. Reconcile an export detail by exact design ID, template ID and color IDs, verify the Shopify shop and Product GID independently, and then use the existing production binding review. Historical exports can return `batch: null` even though OpenAPI declares a batch object. Finished historical exports can also have empty product lists. These records cannot establish a binding or current design availability.

## Prepare a supervised export

The [versioned mapping approval](../config/mockupify-approved-v1.json) records the seven exact garment-to-template assignments explicitly approved in the Phase 19 owner-provided instructions on November 25, 2026. The file records that those instructions are the evidence source and that a separate owner authentication did not occur. Its SHA-256 fingerprint covers the sorted, parsed garment, template ID, title and type records. The expected fingerprint for this revision is pinned in the preparer. Supplier colors, artwork, batches, dispatch and Shopify bindings all require their own review. The label `Adult Long Sleeve` belongs to the earlier candidate file. The approved label is `Adult LongSleeve Shirt`.

```sh
npm run --silent worker -- mockupify-prepare evidence.json config/mockupify-approved-v1.json review.png
```

Supply a current read-only Master Input snapshot for one physical row. The `source` object contains `row`, `sheetArtworkName`, `title`, `artworkSku`, `productSku`, `garment`, `rawColors`, `completion` (null for a blank cell) and `evidence`. The `supplierColors` array contains one `brand`, `style`, `code`, `name`, `mockupifyColorId` and `evidence` record per source color in the same order. Preserve the exact strings, including leading zeros. The `png` object holds `originalRef`, `originalSha256` and `preparedSha256`. Inspect the original and the lossless copy outside the worker before supplying that evidence. The command checks that the local PNG signature, byte count and digest match the reviewed copy. The report still requires owner review of the PNG, its attribution and the exact colors. Re-read the physical row and check workbook-wide uniqueness of the exact Product SKU before separately authorized execution.

The preparer reads the live catalog and checks all approved IDs, titles, types and availability. It verifies each candidate supplier code against the exact garment style and checks its proposed name and ID against the mapped template. It validates that each selected color ID is unique across the catalog. Existing proposed or approved Shopify bindings for the row or Product SKU block preparation. In the report, `requestPreview` describes the following shapes from the [Mockupify OpenAPI specification](https://mockupify.io/api/schema/).

| Step | Documented request | Identity and evidence |
| --- | --- | --- |
| Create one isolated batch | `POST /api/batches/` with JSON `name` | Use the correlation-derived name and record the returned batch ID. |
| Upload one design | `POST /api/designs/` with multipart `batch`, `title`, `design_id` and `file` | Use the verified new numeric batch ID, the recorded design reference and the reviewed PNG. Confirm designer attribution and final Shopify metadata before the upload. The observed Design Input batch is for reference. |
| Start export | `POST /api/exports/` with JSON `batch` and `colors` | Require a fresh read showing exactly the intended design ID in the isolated batch, exclusive control while the export runs, and the exact ordered reviewed color IDs from one template. Color IDs select the template. |

The generated JSON has `executionAuthorized: false` and leaves the batch and file placeholders unset. The prep command uses the existing GET-only client. The future write flow must recheck the live catalog, selected colors, current source row and registry immediately before dispatch. Apply the 4:20 PM inclusive to 9:10 PM exclusive America/Chicago restriction for exports and initial Shopify SKU writes and the configured export safety margin.

### Correlation and recovery

Add `--save` to persist the strictly local dry-run correlation in `mockupify_export_preparations`. Its unique identity is the Master Input spreadsheet and Product SKU. The saved draft includes the physical row, both SKUs, mapping and plan fingerprints, prepared PNG digest, supplier style and exact code strings, template ID, color IDs, planned batch name and design reference. Batch ID, design ID, export ID, Shopify shop GID and Shopify Product GID start as null. Identical drafts reuse the record. A different plan for a saved Product SKU or an active binding requires reconciliation. This registry is independent of product binding approval.

A future supervised writer needs a durable operation journal before dispatch. Key each operation by correlation ID and operation, and atomically record its claim, exact request digest and expected prior state before sending it. Record request time, outcome, provider IDs and authoritative evidence. Persist an uncertain state after timeout, disconnect, unreadable response or a crash after claim. Treat that state as held. Automatically retry read-only lookups where safe.

- **Batch create** — Look up the exact correlation-derived name and verify a unique ID and intended membership. A name match by itself is insufficient if identity or ownership is ambiguous.
- **Design upload** — Reconcile the exact design reference and numeric batch ID and verify that the single design matches the reviewed artwork. Multiple results or unverified artwork keep the plan held.
- **Export** — Poll the verified export ID when it exists. Otherwise look for authoritative batch, design, template and color evidence before claiming an export result. For a partial result, persist the verified IDs and hold the plan for reconciliation. A second batch-wide export could duplicate a product already created. Historical records with null batches and empty product lists, a missing match in a listing, or a title match cannot justify repeating an uncertain POST. Resume only after trusted evidence establishes the outcome and a separately authorized operator approves the next action.

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
