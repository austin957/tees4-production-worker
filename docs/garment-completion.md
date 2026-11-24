# Phase 4 garment completion

Mockupify creates the Shopify product and its variants. The completion workflow starts with the exported Shopify IDs in the existing product bindings. Its only Shopify modification is assigning the exact Product SKU from Master Input column H to blank variants. Hextom later transforms variant SKUs independently.

In production, operators mark column I, **Tees-4 Completed**, as `Yes` after a garment is ready for Hextom. This phase simulates that action in the local SQLite fixture. The live Google Sheets adapter remains read-only.

## Per-garment verification

1. Read the physical Master Input row recorded by the queued assignment. Verify column H and column K against the queued Product SKU and Artwork SKU, and check for ambiguous row matches.
2. Preserve an existing `Yes` as `already_completed`. Preserve any other nonblank column I value and report it for review.
3. Resolve the existing Shopify binding and inspect variants by its authoritative product ID. Preserve an unexpected nonblank SKU and flag the affected variants for review. A garment with an unexpected SKU is left untouched for review.
4. Assign the exact column H value to blank variants in simulate mode. Recheck the physical row, Shopify product ID, and every variant in the transaction that sets the blank column I cell to `Yes`. Other columns, including TeeInBlue and Flash Transfers statuses, are independent.
5. Keep a checkpoint for each garment. If an interruption occurs after a Shopify write, the retry skips SKUs already set. If it occurs after a Sheets write, the retry recognizes the stored `Yes`. One garment's review, retry, or deferral leaves the others eligible to proceed.

The existing **4:20 PM inclusive to 9:10 PM exclusive America/Chicago** window protects Mockupify exports and initial variant SKU writes. Protected SKU work is deferred to 9:10 PM without spending a retry. An already verified garment can still complete its simulated column I update during that window.

## Run the simulator

Run from the repository root after `npm ci` and `npm run build`.

```sh
export TEES4_CONFIG=examples/completion-workflow.json
export TEES4_DATABASE=.tees4/completion.sqlite
npm run --silent worker -- load-sheet-fixture examples/sheet-input.json
npm run --silent worker -- load-shopify-fixture examples/shopify-products.json
npm run --silent worker -- submit-sheet examples/sheet-input.json
npm run --silent worker -- run
npm run --silent worker -- list
```

Dry-run is the default. It reports `ready` if an unmarked row already has all its expected SKUs, `pending_skus` if variants still need assignment, or `needs_review` with a reason when a check fails. Run the submission with `--mode simulate` to apply only local fixture changes. The sample includes one unexpected SKU to exercise review and another garment that can complete independently. Identical fixture imports preserve local changes. Identical job submissions reuse their job in the same mode.
