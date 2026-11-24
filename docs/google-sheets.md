# Phase 3 Google Sheets intake

The worker reads **Master Input** in **Design Input Master** through the Sheets v4 values API using Google Application Default Credentials (ADC). It requests the `spreadsheets.readonly` scope and makes a GET request for formatted values. Keep the displayed SKUs in columns H and K authoritative and verify their formatting with the workbook owner. The worker preserves the exact returned strings and does not pad, trim, generate, or write a SKU to Sheets.

## Authorize access

1. Enable the Google Sheets API in the Google Cloud project used for authorization.
2. Configure ADC with an approved Google principal that can view the spreadsheet. For a service account or impersonated identity, share the spreadsheet with that principal as a Viewer. For user ADC, use an approved OAuth client and grant the Sheets read-only scope. Keep credential files outside the checkout and provide their path through `GOOGLE_APPLICATION_CREDENTIALS` only when needed by the chosen ADC setup.
3. Allow HTTPS to `sheets.googleapis.com` and the token endpoints required by the approved authentication method, such as `oauth2.googleapis.com` for OAuth token exchange. Keep these settings in the environment and credentials out of fixture files and command output.

## Preview and queue a selection

Copy the [policy example](../examples/google-sheet-policy.json) and [selection example](../examples/artwork-selection.json) into local files outside the repository. The example approval column and value are placeholders. Confirm the physical header row, the approval column, its exact header label, and the accepted values with the workbook owner. Values compare exactly by text or checkbox boolean. A blank or unrecognized status is ineligible.

Default mapped headers follow the [existing column map](sku-processing.md). If an actual label differs, use the policy's optional `columnHeaders` map such as `{"E":"Garment"}` after verifying the workbook. Every expected label must appear once in the requested range and at its configured column. A header mismatch stops intake before any rows can be queued.

```sh
npm ci
npm run build
npm run --silent worker -- preview-google-sheet /path/to/artwork-selection.json /path/to/sheet-policy.json
TEES4_CONFIG=examples/sku-workflow.json npm run --silent worker -- submit-google-sheet /path/to/artwork-selection.json /path/to/sheet-policy.json
```

The selection supplies an Artwork SKU plus the existing artwork ID, original reference, and designer ID. The preview shows the artwork, garment and color selections, exact Product SKUs, and physical spreadsheet row numbers. It reports missing artwork, ineligible rows, and selected rows needing review. Sparse rows unrelated to the selected Artwork SKU are ignored except that a duplicate of a selected Product SKU anywhere in the read range blocks that SKU, regardless of eligibility. An explicitly eligible but incomplete or conflicting row blocks submission for that selection. The normal Phase 2 required fields still apply. Description and tags may be blank.

Preview makes no queue changes. Submission re-reads the sheet and queues only a ready selection, in dry-run mode. The queued job stores its verified selection as a snapshot. The queue database and any captured preview output may contain spreadsheet data. Keep both in approved local storage.

## Product and variant bindings

The existing local catalog stores one binding from the assigned Artwork SKU and Product SKU to an explicit Shopify product ID, plus the individual Shopify variant IDs and size/color pairs. A binding can carry the opaque `mockupifyExportRef` supplied after a future export. The simulator can already persist this field on fixture import. It rejects a changed fixture for an existing ID, preserves simulated SKU updates on re-import, and stops if a SKU resolves to multiple products. There is no automated export or discovery of product IDs in this phase.

Unexpected nonblank variant SKUs are preserved and flagged as `UNEXPECTED_VARIANT_SKU`, with the product ID, variant ID, and observed value. Jobs with a flagged variant finish as `needs_review`. Existing Hextom values are not interpreted. The daily 5–9 PM America/Chicago protection and blank-only simulated writes continue to apply.

## Open integration decisions

- Confirm actual header labels, the approval rule, the SKU display formats, and how artwork references and designer IDs will be supplied.
- Define how Mockupify export results will identify the source garment and Shopify shop and return authoritative product and variant IDs. Confirm the export reference's scope and how corrected bindings are approved.
- Define the mapping from garment and color text to Shopify options and size/color variants.
- Define who reviews unexpected SKUs and how a future live adapter will prevent concurrent Shopify or Hextom updates from being overwritten.
