# Supervised Mockupify writer

See the [Phase 21 row 9 approval record and preflight](mockupify-pilot-row-9.md) for current pilot evidence.

The existing export queue uses its simulator. The supervised CLI uses the same writer and SQLite journal for the Bold Arrow Emblem pilot. Registration reads the providers and records the plan locally. The pending registration path records the evidence already available and reports what is missing. A dispatch invocation needs an explicit `--execute` flag and the owner approval for one operation.

## Windows PowerShell

Run from the repository root with Node.js 24. Use owner-controlled storage for the existing worker database and its verification backups. Use the same `TEES4_DATABASE` for every step. Set up Google Application Default Credentials for read-only access to Master Input, `TEES4_MOCKUPIFY_API_KEY`, and the dedicated Shopify credentials scoped to `read_products` and `read_publications`.

```powershell
npm.cmd ci
npm.cmd run build
$env:TEES4_DATABASE = 'C:\Tees4\worker.sqlite'
$backupDirectory = 'D:\Tees4 Backups'
$correlationId = '6b7ffdea53cc1985343b375aabac5d5c421911de79c06f45c7159868ed643eea'
npm.cmd run --silent worker -- mockupify-writer-dry-run
npm.cmd run --silent worker -- mockupify-writer-register-pending '.\preparation.json' '.\review.png' '.\pending-review.json'
npm.cmd run --silent worker -- mockupify-writer-inspect $correlationId
npm.cmd run --silent worker -- mockupify-writer-readiness $correlationId
```

Use the input JSON already accepted by [`mockupify-prepare`](mockupify.md#prepare-a-supervised-export). Supply the reviewed PNG whose SHA-256 is `6bae2628c23f42d960ef36e488bde69f84fe994d68e084218674b465a9354d17`. Registration reads the exact physical row and checks the approved non-library template, its Black and White selections at the catalog price of `18.99`, and the 14 reviewed color and size combinations. It preserves the live `SKU TEST` artwork name and requires `Bold Arrow Emblem` as the Mockupify design title. The expected Shopify title is supplied in the review after checking template title composition.

Supply these fields in the separate metadata-review JSON. For pending registration, use JSON `null` for any unresolved `product.title`, `product.descriptionHtml`, `product.variants`, `exclusiveBatchControlEvidence`, or `publicationSafety`. Omit `initialDescriptionEvidence` until its reference is available. If exact initial HTML is already available, include its evidence reference. The remaining fields are required. Recorded catalog prices and sizes remain separate from reviewed Shopify variant prices and options. Use UTF-8 JSON and store the files in access-controlled local storage. UTF-8 with a byte-order mark is accepted.

| Field | Required value |
| --- | --- |
| `artworkRegistryName`, `artworkNameResolution`, `designerAttribution` | `Bold Arrow Emblem`, the evidence for keeping `SKU TEST` in the source cell, and `Tees-4` |
| `design` | Exact strings for `title`, `description`, `extra_title`, `search_tags`, `vendor`, and `extra_price`. The pilot uses an empty `extra_title`, `Family, Grandpa`, `test test` and `0.00`. Use the reviewed artwork copy and include the designer attribution in the description. |
| `shop` | `id` and `domain` for the approved shop, with independent `connectionEvidence` linking the Mockupify account to it |
| `product` | Exact expected Shopify `title`, initial `descriptionHtml` including attribution, `vendor`, and `status` of `ACTIVE`. See the [pilot description evidence](mockupify-pilot-row-9.md#initial-and-hextom-enhanced-descriptions). Set the `tags` array to exactly `readytobuy`, `adult`, `S105`, `adjust`, `stock`, `Family`, and `Grandpa` in any order, with each tag listed once. Provide `variants` as all 14 reviewed entries, each with an `options` object mapping exact option names to strings and a `price` string. Catalog color prices alone cannot establish final Shopify variant prices. |
| `initialDescriptionEvidence` | Reference to the trusted record supporting the exact initial Shopify HTML. Required when finalizing a pending plan. |
| `exclusiveBatchControlEvidence` | Evidence that this pilot has exclusive control of its isolated batch through export completion |
| `publicationSafety` | Verified Hextom rule and safety `evidence`, interval `startsAt` and `endsAt` as Unix epoch milliseconds, and the required `minimumMinutes` for completing the export and observations |

Template 10779 contributes `adjust` to the expected Shopify tags. The design upload uses `Family, Grandpa`. The template tag makes the Active product potentially eligible for Hextom publication, and the pilot still needs a verified safe interval. The complete plan, including its publication-safety interval, is bound into each operation's digest. Inspect it and review the exact preview before requesting approval. If the plan conflicts with an existing registration, stop and inspect the journal. The CLI has no plan replacement or claim reset command.

### Finalize the pending plan

A pending plan reserves the pilot correlation in the same SQLite journal. It produces no operation approval digest and cannot claim or dispatch any POST. Readiness uses the local journal, clock, configured export margin, and SQLite durability evidence. It lists live requirements separately because a local report cannot confirm remote batch or publication state or authenticate an owner approval.

Once the missing evidence is available, copy the pending review to `metadata-review.json` and fill the unresolved values. Use the same preparation JSON and PNG. Finalization rechecks the source, artwork digest, catalog, collisions, and Shopify shop through the existing read paths. It validates the supplied metadata and verifies that the recorded publication interval has enough time left. The exact HTML and Hextom evidence still rely on the operator’s trusted records. Finalization commits a one-way state transition in SQLite, preserving the original recorded values, history and correlation. Existing claims and registered full plans cannot be replaced. Already complete evidence can still be registered directly using the original `mockupify-writer-register` command.

```powershell
npm.cmd run --silent worker -- mockupify-writer-finalize '.\preparation.json' '.\review.png' '.\metadata-review.json'
npm.cmd run --silent worker -- mockupify-writer-readiness $correlationId
npm.cmd run --silent worker -- mockupify-durability-status
npm.cmd run --silent worker -- mockupify-writer-preview $correlationId create_batch
```

Use `npm.cmd run --silent worker -- mockupify-durability-verify $backupDirectory` if the durability evidence for that database is missing or expired. The finalized plan carries no owner authorizations.

### Dispatch one operation

The next pilot operation is `create_batch`. The local command `mockupify-writer-dispatch $correlationId create_batch` is equivalent to a preview. Once the owner has explicitly authorized the exact batch request, put that operation's approval in its own JSON file with `operation`, `digest` (the preview's `approvalDigest`), `by`, `evidence` and `expiresAt` (Unix epoch milliseconds). The existing owner attestation model trusts the operator to supply the owner's actual evidence.

```powershell
npm.cmd run --silent worker -- mockupify-writer-dispatch $correlationId create_batch --execute '.\batch-approval.json'
npm.cmd run --silent worker -- mockupify-writer-reconcile $correlationId
```

When separately authorized, use the following operation-specific commands. Preview upload after the journal has a verified batch ID. Preview export after it also has a verified design ID. Set `TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES` to the approved positive integer margin before export.

```powershell
npm.cmd run --silent worker -- mockupify-writer-preview $correlationId upload_design
npm.cmd run --silent worker -- mockupify-writer-dispatch $correlationId upload_design --execute '.\upload-approval.json' '.\review.png'
npm.cmd run --silent worker -- mockupify-writer-preview $correlationId start_export
npm.cmd run --silent worker -- mockupify-writer-dispatch $correlationId start_export --execute '.\export-approval.json'
npm.cmd run --silent worker -- mockupify-writer-reconcile $correlationId
```

If dispatch reports `reconciliationRequired: true`, or exits after a claim without a usable acknowledgment, inspect and reconcile the journal. Reconciliation uses provider reads and updates the local journal. For an ambiguous batch or design acknowledgment, pass the separately reviewed recovery attestation as the second positional argument to `mockupify-writer-reconcile`.

## Row 9 dry run

Run from the repository root after building.

```sh
npm run --silent worker -- mockupify-writer-dry-run
```

The offline command uses an owner-supplied fixture and reports zero HTTP requests and zero claims. It records Master Input row 9, Artwork SKU `8419620257`, Product SKU `8419620257-S105`, and the approved Adult Tank Top mapping to template `10779`. Black `20514` and White `20515` are owner-approved. The trace preserves **SKU TEST** as the source artwork name and **Bold Arrow Emblem** as the proposed display title. It shows the expected Active status with zero channel publications and keeps the reviewed compressed PNG and exact upload metadata pending. Batch, design, export and Shopify Product GID are unset.

## Claims and preflight

A supervised plan uses `config/mockupify-approved-v1.json` and the existing preparation checks. It records the physical source row and exact values, the Sheet and registry artwork names and a resolution record when those names differ, the reviewed PNG hashes, designer attribution, multipart design fields, selected catalog colors and expected Shopify metadata, prices and variants. The product title is independent of the artwork names. The operator supplies independently validated evidence that the Mockupify account is connected to the exact Shopify shop, exports yield Active products with the expected tags and zero sales-channel publications, and the isolated batch is under exclusive control through export completion. Mockupify's export request has only `batch` and `colors` fields. Before export, the worker verifies Shopify publication read access and requires a time-bounded, owner-reviewed Hextom safety record in `publicationSafety`. The record contains an `evidence` reference, `startsAt` and `endsAt` in epoch milliseconds, and the `minimumMinutes` needed for export and observation. The export must leave more than that minimum before the safe interval ends. Verify the actual Hextom channel-assignment rule and its earliest eligible run as described in the [row 9 preflight](mockupify-pilot-row-9.md).

Each POST needs a separate, unexpired owner attestation with operator identity and a reference to their review. The approval digest binds the plan and its expected side effects to the exact request and current batch/design IDs. The request digest covers the method, endpoint and JSON or multipart fields, including the upload file SHA-256. The trust boundary is the authorized operator supplying the attestation, as with existing binding approval. An operation preview supplies a digest for review.

```sh
npm run --silent worker -- mockupify-writer-preview CORRELATION_ID create_batch
npm run --silent worker -- mockupify-writer-inspect CORRELATION_ID
```

For each operation, the writer resolves the unique Product SKU from a live read of Master Input and checks its physical row number, Artwork SKU, garment and approved source data. It repeats the Sheet check before the final batch membership check and operation claim. Missing, ambiguous, changed or unreadable data blocks dispatch. The writer also checks the selected template and colors, current Shopify shop, and conflicts in the binding registry. It checks that a batch is empty before upload, and immediately before export verifies that exactly the approved design is present by batch ID, design ID, reference and metadata. An existing export for the batch blocks dispatch. SQLite claims reserve each Product SKU and remote batch, design and export IDs. Claims persist before POST. Export dispatch checks the daily 4:20 PM inclusive to 9:10 PM exclusive America/Chicago protected window and the explicitly configured safety margin. The journal meters supervised requests at 1,200 per hour and 60 export starts per hour, checks for at most two concurrent exports across local claims and visible vendor jobs, and observes vendor rate-limit responses. Other tools or dashboard activity can consume account capacity. Mockupify remains the authority for account quotas. Allow a few seconds between export status reads.

## Recovery and binding review

```sh
npm run --silent worker -- mockupify-writer-reconcile CORRELATION_ID
npm run --silent worker -- mockupify-writer-reconcile CORRELATION_ID recovery-attestation.json
```

The CLI reconciliation uses live GETs for a production journal and Shopify's fixed read queries when product IDs are present. For reconciliation, supply dedicated Shopify credentials restricted to `read_products` and `read_publications` through the existing Shopify environment variables. Keep the product-only credentials for the other Shopify commands. Reconciliation updates the local journal. Simulation evidence uses the injected fake client. A timeout, failed response, crash after claim, or ambiguous acknowledgment leaves the operation held. Missing evidence leaves the claim in place. There is no reset or resend workflow.

A lost batch or upload acknowledgment requires a unique read-only match and independent recovery evidence. The optional JSON attestation carries `operation`, `remoteId`, `requestDigest`, `by`, `evidence`, and `dispatcherStoppedEvidence`. For a design upload, supply `artworkSha256` from independent verification of the remote artwork. An export acknowledgment supplies an export ID to poll. If the acknowledgment was lost, a unique export found for the batch must also provide explicit design, template and color evidence before the journal adopts the ID. The journal retains returned numeric IDs, GIDs, status, and vendor error references and timestamps. For partial results it records the evidence and keeps the export held.

For full export validation, the writer requires a finished status, exact batch/design/template/color relationships, one created product with an explicit Product GID, and a stable Shopify read of that GID in the approved shop showing Active status, the exact initial metadata and variants, and zero current or staged sales-channel publications. Publication is checked separately through the Shopify APP publication connection. The worker holds if a publication is observed, evidence is incomplete, or the verified test interval has ended. A returned numeric ID can be used for a read-only lookup. Validated evidence can support the existing [product binding review](product-bindings.md), which still requires the owner's separate approval and live checks.

## Backup and restoration

Keep the operation journal and binding registry together under the same `TEES4_DATABASE` path. The CLI uses SQLite's online backup API to snapshot the whole database, including committed WAL contents. Supply a new path on access-controlled storage. This uses no additional service.

```sh
npm run --silent worker -- mockupify-writer-backup /path/to/new-backup.sqlite
TEES4_DATABASE=/path/to/restored.sqlite npm run --silent worker -- mockupify-writer-inspect CORRELATION_ID
TEES4_DATABASE=/path/to/restored.sqlite npm run --silent worker -- binding-inspect BINDING_ID
```

For a cutover, stop all dispatchers, back up the database while they are stopped, preserve the latest database and any WAL files, copy the backup to a fresh path, and verify journal claims, identifier relationships, and binding histories before considering that store for use. Resolve any outstanding claims against fresh read-only evidence. A snapshot older than any possible POST cannot establish that an operation was never sent. If the latest journal is lost, stop dispatch and reconcile with the providers and owner records before creating any new authorization.

Tests cover a local process exit after a simulated vendor write, reopening SQLite, backup and restoration of both the claim and binding history, and duplicate prevention after restore. Durability verification exercises the actual database and backup directory and expires after 24 hours. It cannot establish storage persistence across a Codex environment replacement. Before the pilot, confirm owner-controlled storage and check that the exact configured database is admitted.
