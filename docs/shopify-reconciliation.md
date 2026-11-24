# Phase 9 source SKU reconciliation

`shopify-reconcile` uses the existing read-only Shopify client and reads every variant page for an explicit Product GID. It compares stored SKU strings exactly, with no normalization. It can read Design Input Master's **Master Input** columns H and K through the existing read-only Sheets credentials. Column H is Product SKU and column K is Artwork SKU. The header row defaults to row 1. Use `--header-row` to specify a different known header row.

```sh
npm run --silent worker -- shopify-reconcile gid://shopify/Product/2 \
  --product-sku '000710' --artwork-sku '00042' --evidence-ref 'owner-reviewed-record-reference' \
  --row 2 --verified-source /path/to/verified-source.json
```

`--row` is optional and denotes a physical row. The command searches all data rows even if a row is specified, so a repeated Product SKU still blocks an unambiguous match. It distinguishes a missing Product SKU, conflicting assignments, a mismatch with the requested physical row, and an unavailable live read. An unavailable read does not establish absence. Master Input's H and K cells do not identify a Shopify product GID by themselves.

## Verify source evidence

Use a non-secret `--evidence-ref` to identify the record being reviewed. The worker does not fetch or trust a reference string by itself. Use `--verified-source` only after the owner independently inspects a trusted Mockupify export record or a Master Input record with evidence linking its assignment to the exact Shopify shop and product. The file is the owner's attestation of that review. The worker checks its identifiers and matches its reference and SKU strings. It does not authenticate the document's origin on its own.

```json
{
  "kind": "mockupify_export",
  "reference": "owner-reviewed-record-reference",
  "shopId": "gid://shopify/Shop/1",
  "productId": "gid://shopify/Product/2",
  "productSku": "000710",
  "artworkSku": "00042",
  "masterInput": {
    "spreadsheetId": "1UxdIY03ICu5t2G0fEo0nor6-giAEF4xdMuNEvYN_JMM",
    "tab": "Master Input",
    "rowNumber": 2
  }
}
```

The physical row is required for `master_input` records and optional for `mockupify_export` records. A reviewed Master Input record can supply the row when Sheets access is unavailable. An export record can verify the original SKU but needs a matching live Master Input row for a binding proposal. A conflicting live read blocks a proposal and overrides a contradictory Master Input record. Complete, unique Shopify variant IDs also remain required.

When live Sheets access is unavailable, `--sheet-fixture examples/reconciliation-sheet-fixture.json` uses a sanitized fixture for comparison and skips the live Sheet request. A fixture can surface a candidate row but cannot verify the SKU or authorize a proposal. Keep fixture provenance and independently reviewed source records distinct.

## Interpret results

| Source status | Meaning |
| --- | --- |
| `VERIFIED` | A reviewed source record independently links the shop, product and both source SKUs. The Hextom verifier uses that base SKU. |
| `CANDIDATE` | Shopify has at least one exact observed SKU match, or the sheet data has an exact H and K pair, but the product-to-source link is unverified or conflicting. |
| `MISSING_EVIDENCE` | Neither an exact observed SKU, an exact H and K pair, nor a valid reviewed source record supports the proposed assignment. |

A proposed binding is returned only when the source and physical row are verified and the Shopify variant IDs are complete. Its status is `OWNER_REVIEW_REQUIRED`. The command does not persist a binding, update Master Input, or change Shopify, Mockupify, or Hextom. The 4:20–9:10 PM America/Chicago protections for exports and initial SKU writes are unaffected.
