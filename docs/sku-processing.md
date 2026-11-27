# Phase 2 SKU processing

The read-only Sheets adapter targets the **Master Input** tab of **Design Input Master** (spreadsheet ID `1UxdIY03ICu5t2G0fEo0nor6-giAEF4xdMuNEvYN_JMM`). The Phase 2 workflow uses local fixtures. Phase 3 adds an authenticated [read-only intake](google-sheets.md) for the same sheet.

| Column | Field |
| --- | --- |
| A | Artwork name |
| B | Product title |
| C | Product description |
| D | Vendor |
| E | Product or garment selection |
| F | Colors |
| G | Tags |
| H | Assigned Product SKU |
| K | Assigned Artwork SKU |

The adapter supplies positional A–K data rows with physical row numbers. It leaves out headers and empty rows. The fixture format requires nonempty strings for A, B, D, E, F, H, and K, with C and G represented as strings that may be empty. Columns I and J are ignored. The parser preserves SKU text byte-for-byte, including leading zeros and case. It rejects repeated row numbers, repeated Product SKUs across the supplied rows, and conflicting artwork names for one Artwork SKU. Colors and tags remain raw text. The artwork reference and designer attribution are supplied separately because they have no mapped columns.

## Product binding and variant updates

An artwork job can contain multiple garment assignments. The simulator imports exported Shopify fixture products with explicit bindings between their Shopify product ID, Artwork SKU, and Product SKU. Each variant has its own Shopify ID and size/color options. The SKU assignment stage requires exactly one binding per assigned Product SKU before beginning writes. Missing, conflicting, or ambiguous bindings stop the job. The stage uses the imported variants and does not infer a size/color matrix from the sheet.

Every blank variant of an unambiguously matched product receives the exact value from column H. A variant that already has that value is considered assigned. Any other nonempty SKU is preserved and flagged for review. The worker does not parse or reverse a Hextom SKU.

The simulator checks the binding and current variant SKU inside a SQLite transaction before updating any blank variant. If a job stops partway through, the next attempt reads current values and continues with blank variants. The fixture importer is idempotent and preserves simulated updates when the original fixture is imported again.

The initial write window is protected daily from **4:20 PM inclusive to 9:10 PM exclusive America/Chicago**, including Central daylight time. A blocked job becomes eligible at 9:10 PM Central without using its retry budget. Run the worker again after the reported retry time. Dry-run reports planned and preserved variants without mutating them.

## Simulate a sheet-backed job

Run from the repository root after `npm ci` and `npm run build`.

```sh
export TEES4_CONFIG=examples/sku-workflow.json
export TEES4_DATABASE=.tees4/phase-2.sqlite
npm run --silent worker -- load-shopify-fixture examples/shopify-products.json
npm run --silent worker -- submit-sheet examples/sheet-input.json
npm run --silent worker -- run
npm run --silent worker -- list
```

Add `--mode simulate` to the submission command to exercise local variant updates. The default is dry-run. The Phase 2 workflow handles initial SKU assignment on already-exported fixture products. The Phase 1 fixture workflow continues to handle its original product draft and approval example.

## Decisions needed before live integration

- Confirm how to locate headers and identify eligible Master Input rows, including whether any mapped fields can be blank. Confirm how the read adapter should retrieve text-formatted SKUs when the displayed value differs from the underlying sheet value.
- Define where the export supplies and persists the authoritative association with Shopify product and variant IDs, and how operators correct missing or ambiguous associations.
- Confirm the relationship between column F and the actual Shopify option names, sizes, and colors.
- Define how operators review preserved nonblank SKUs and reconcile legitimate catalog or sheet edits after a job has been submitted.
- Verify that a future Shopify adapter can prevent a concurrent external change between checking a blank SKU and updating it, including any Shopify or Hextom work that spans the protected boundary.
