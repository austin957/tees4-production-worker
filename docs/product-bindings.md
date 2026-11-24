# Product binding registry

The worker keeps product bindings and their append-only review history in its SQLite database. Use the same `TEES4_DATABASE` path across invocations. The default is `.tees4/worker.sqlite`.

## Propose and inspect a binding

Prepare an assignment JSON file with the exact source identity. This example uses synthetic SKUs and Shopify IDs.

```json
{
  "spreadsheetId": "1UxdIY03ICu5t2G0fEo0nor6-giAEF4xdMuNEvYN_JMM",
  "rowNumber": 4,
  "productSku": "001-202",
  "artworkSku": "001",
  "shopId": "gid://shopify/Shop/1",
  "productId": "gid://shopify/Product/2"
}
```

```sh
npm run --silent worker -- binding-propose /path/to/assignment.json --by "Operator name"
npm run --silent worker -- binding-list
npm run --silent worker -- binding-inspect <binding-id>
```

The proposal reserves the physical row, Shopify product within its shop, and Product SKU on the spreadsheet. It saves a snapshot after two matching read-only Shopify reads with all variant GIDs, selected options, and exact current SKU strings. A proposal can be stored while Sheets access is unavailable. The audit history records who proposed it and when.

## Approve, reject, or recheck

The owner independently checks the row-to-product linkage using trusted operational evidence. The evidence can be an owner-reviewed assignment record and does not depend on retaining the original Mockupify export. The owner reviews the exact assignment and saved Shopify snapshot with `binding-inspect`, then supplies their name and a non-secret evidence reference. The `approve` invocation is the owner's attestation. Restrict worker and database access to authorized operators so the recorded name can be trusted.

```sh
npm run --silent worker -- binding-review <binding-id> approve --by "Owner name" --source "reviewed-record-reference"
npm run --silent worker -- binding-review <binding-id> reject --by "Owner name" --reason "Wrong garment"
npm run --silent worker -- binding-review <binding-id> recheck --by "Operator name"
```

Approval and recheck use the read-only connections. The worker checks the physical Master Input row and exact H/K values before and after two complete Shopify reads. It requires a unique Product SKU assignment in the sheet and verifies the Shopify shop, product, and variant snapshot. Supply `--header-row` if the header is below row 1. Approval records the owner, confirmation source, and UTC epoch-millisecond timestamp.

| Status | Meaning |
| --- | --- |
| `proposed` | The snapshot is saved and the assignment awaits owner approval and live verification. |
| `approved` | The owner attested to the linkage and the live identifiers and snapshot matched. |
| `rejected` | An operator rejected the proposal and recorded a reason. |
| `stale` | The live row, Shopify product, or variant snapshot changed. A new proposal and approval are required. |

An unavailable live read, including Google authentication failure, records a failed verification and leaves the current status intact. Fixtures and candidate matches cannot authorize approval. Rejected and stale entries retain their history and release their reservations. Binding changes and their audit entries commit together. The registry does not update Shopify, Google Sheets, or column I.

For any future write, require explicit write approval and run equivalent live checks immediately before writing. Confirm the approved shop/product GIDs, exact row and H/K values, targeted variant GIDs and options, and exact expected current and intended SKU strings. Preserve nonblank SKUs unless the exact overwrite is separately authorized, recheck Hextom state, and enforce the daily **4:20 PM inclusive to 9:10 PM exclusive America/Chicago** protected window. A registry approval or successful recheck supplies binding evidence only.
