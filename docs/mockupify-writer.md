# Supervised Mockupify writer

See the [Phase 21 row 9 approval record and preflight](mockupify-pilot-row-9.md) for current pilot evidence.

The existing export queue uses its simulator. The supervised CLI uses the same writer and SQLite journal for the Bold Arrow Emblem pilot. Registration reads the providers and records the plan locally. The pending registration path records the evidence already available and reports what is missing. A dispatch invocation needs an explicit `--execute` flag and the owner approval for one operation.

## Windows PowerShell

Run from the repository root with Node.js 24. Use owner-controlled storage for the existing worker database and its verification backups. Use the same `TEES4_DATABASE` for every step. Set up Google Application Default Credentials for read-only access to Master Input, `TEES4_MOCKUPIFY_API_KEY`, and the dedicated Shopify credentials with the supported [publication read scope sets](shopify-readonly.md#authorize-the-first-supervised-connection).

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
| `initialDescriptionEvidence` | Reference to the trusted record supporting the exact initial Shopify HTML when using the exact-HTML review path. |
| `exclusiveBatchControlEvidence` | Evidence that this pilot has exclusive control of its isolated batch through export completion |
| `publicationSafety` | Verified Hextom rule and safety `evidence`, interval `startsAt` and `endsAt` as Unix epoch milliseconds, and the required `minimumMinutes` for completing the export and observations |

Template 10779 contributes `adjust` to the expected Shopify tags. The design upload uses `Family, Grandpa`. The template tag makes the Active product potentially eligible for Hextom publication, so export needs a verified safe interval. Each approval digest binds the plan as it exists at preview time. If the plan gains evidence before a POST is claimed, obtain approval against a fresh preview. The CLI preserves recorded evidence and operation claims.

### Record batch control for the pending pilot

Use the existing database and correlation ID. Create a UTF-8 `batch-review.json` with one property, `exclusiveBatchControlEvidence`. Its value is the reference to the verified record establishing exclusive control of the isolated batch through export completion. The command rechecks the recorded source, catalog and Shopify shop, checks for a batch or design collision and an active binding, and adds the evidence to the existing journal. The registration stays `pending_review` while export review is outstanding.

An empty batch can now be previewed for separate owner approval. After the batch is confirmed, upload requires the exact recorded design review and PNG bytes plus its own owner approval. Readiness reports the evidence and timing still needed for each operation. It does not perform provider reads or grant approval.

```powershell
npm.cmd run --silent worker -- mockupify-writer-review-batch $correlationId '.\batch-review.json'
npm.cmd run --silent worker -- mockupify-writer-readiness $correlationId
npm.cmd run --silent worker -- mockupify-writer-preview $correlationId create_batch
```

Use `npm.cmd run --silent worker -- mockupify-durability-verify $backupDirectory` if the durability evidence for that database is missing or expired.

### Dispatch one operation

For a pilot awaiting its first batch, the local command `mockupify-writer-dispatch $correlationId create_batch` is equivalent to a preview. Once the owner has explicitly authorized the exact batch request, put that operation's approval in its own JSON file with `operation`, `digest` (the preview's `approvalDigest`), `by`, `evidence` and `expiresAt` (Unix epoch milliseconds). For an existing claimed operation, use journal inspection and reconciliation.

```powershell
npm.cmd run --silent worker -- mockupify-writer-dispatch $correlationId create_batch --execute '.\batch-approval.json'
npm.cmd run --silent worker -- mockupify-writer-reconcile $correlationId
```

Preview upload after the journal has a verified batch ID. Obtain separate owner approval before dispatch.

```powershell
npm.cmd run --silent worker -- mockupify-writer-preview $correlationId upload_design
npm.cmd run --silent worker -- mockupify-writer-dispatch $correlationId upload_design --execute '.\upload-approval.json' '.\review.png'
```

### Finalize export review

For the existing Bold Arrow Emblem pilot, use the original `TEES4_DATABASE` and the JSON fields below. The command verifies the recorded source, live catalog, shop identity, Shopify publication read access, and the exact uploaded design in its exclusive batch. It records the uploaded copy as the expected initial Shopify text and projects all 14 initial `Color` × `Size` variants at `18.99` from the rechecked catalog. It preserves the acknowledged claims and leaves Shopify HTML to be observed after export.

| `export-review.json` field | Required evidence |
| --- | --- |
| `descriptionSourceEvidence` | Reference to the verified blank product description on template `10779` and the reviewed copy with attribution on uploaded design `70253`. Use the template settings evidence for the blank description. The catalog API exposes colors, sizes and prices. |
| `variantOptionsEvidence` | Reference to prior verified product evidence supporting the exact Shopify option names `Color` and `Size`. The reviewed variants are projections for this pilot until Shopify confirms them. |
| `publicationSafety` | An object containing `evidence`, `startsAt`, `endsAt`, and `minimumMinutes`. Supply the verified Hextom-safe interval for export and observation, with start and end as Unix epoch milliseconds. Verify that observation can finish before eligible publication and description enhancement. |

```powershell
npm.cmd run --silent worker -- mockupify-writer-review-export $correlationId '.\export-review.json'
npm.cmd run --silent worker -- mockupify-writer-readiness $correlationId
```

The existing `mockupify-writer-finalize` command remains available for reviews backed by previously verified exact HTML. It takes the original preparation JSON, PNG and completed metadata review. A new pilot with complete exact-HTML evidence can use `mockupify-writer-register`.

Set `TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES` to the approved positive integer margin before export. Preview the export after the journal has a verified batch and design ID, then obtain separate approval for that digest before dispatch.

```powershell
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

The CLI reconciliation uses live GETs for a production journal and Shopify's fixed read queries when product IDs are present. For reconciliation, supply dedicated Shopify credentials with a supported [publication read scope set](shopify-readonly.md#authorize-the-first-supervised-connection) through the existing Shopify environment variables. Those credentials also support standard Shopify diagnostics. Reconciliation updates the local journal. Simulation evidence uses the injected fake client. A timeout, failed response, crash after claim, or ambiguous acknowledgment leaves the operation held. Missing evidence leaves the claim in place. There is no reset or resend workflow.

A lost batch or upload acknowledgment requires a unique read-only match and independent recovery evidence. The optional JSON attestation carries `operation`, `remoteId`, `requestDigest`, `by`, `evidence`, and `dispatcherStoppedEvidence`. For a design upload, supply `artworkSha256` from independent verification of the remote artwork. An export acknowledgment supplies an export ID to poll. If the acknowledgment was lost, a unique export found for the batch must also provide explicit design, template and color evidence before the journal adopts the ID. The journal retains returned numeric IDs, GIDs, status, and vendor error references and timestamps. For partial results it records the evidence and keeps the export held.

For full export validation, the writer requires a finished status, exact batch/design/template/color relationships, one created product with an explicit Product GID, and a stable Shopify read of that GID in the approved shop showing Active status, the exact initial metadata and variants, and zero current or staged sales-channel publications. Each variant must have a unique initial SKU in the form `<verified Mockupify design ID>-<exact Color>-<exact Size>`. Blank, mixed, changed, or Hextom-transformed SKUs keep reconciliation held. The assigned Master Input Product SKU remains separate. Reconciliation performs no SKU writes.

Publication is checked through the Shopify APP publication connection. The worker holds if a publication is observed, evidence is incomplete, or the observation falls outside the verified interval. A returned numeric ID can be used for a read-only lookup. Inspect the journal to review the saved in-window snapshots and the latest comparison results. If the interval has elapsed, a fresh read adds current evidence and the export remains held. Retain the original interval and claims.

For a binding after the interval, use the separate [product binding review](product-bindings.md). Have the owner review the exact export-to-Shopify GID and Master Input row linkage, the timestamped original Shopify publication and variant evidence for that GID, and fresh read-only publication and product evidence. If the original state cannot be established or the evidence conflicts, keep the binding on hold. Record the reviewed evidence reference with the owner's approval. The binding workflow still checks the live row and current Shopify snapshot.

## Phase 22A initial SKU replacement preview

Use the existing `TEES4_DATABASE` and the approved binding ID. Configure the standard read-only Shopify credentials and Google Application Default Credentials for Master Input. For the Bold Arrow Emblem pilot, run:

```powershell
npm.cmd run --silent worker -- mockupify-sku-replacement-preview '3e66387c-df11-4d88-ba05-cd498def29cb'
```

The worker matches the binding to a validated Mockupify journal with settled claims and a recorded finished export for the same shop, Shopify Product GID, design and source row. It checks the live Master Input row and compares two full Shopify reads against the approved binding snapshot. The preview requires an Active product with the exact lowercase `adjust` tag and every reviewed variant present. Color must be option 1 and Size option 2. Each current SKU must exactly match its Mockupify design ID, Color and Size. Base SKUs, Hextom-transformed SKUs, duplicate values and drift block the entire preview.

The output lists each eligible variant's GID, Color, Size, current SKU, and proposed base SKU from column H. During the 4:20 PM inclusive to 9:10 PM exclusive America/Chicago protected window, the same inventory is marked `DEFERRED_PROTECTED_WINDOW` and includes the window end. The preview opens SQLite read-only, performs provider reads, and always sets `executionAuthorized` to `false`. Eligibility describes the observed state. Any future write needs separate authorization and immediate safety checks.

## Phase 22B supervised SKU replacement

From the built project, use the existing pilot database via `TEES4_DATABASE`, the standard read-only Shopify installation, and Google Application Default Credentials for Master Input. Run the pilot dry-run in PowerShell.

```powershell
npm.cmd run --silent worker -- mockupify-sku-replacement-dry-run '3e66387c-df11-4d88-ba05-cd498def29cb'
```

The dry-run returns the reviewed variant IDs, exact Color and Size, initial Mockupify SKUs, and the identical proposed base SKU on each row. It also prints the Shopify request it would use and the SHA-256 plan ID. SQLite is opened read-only. Google Sheets and Shopify are queried read-only. Mockupify provenance comes from the validated export already in SQLite.

The owner reviews the complete plan and can record a separate SKU execution approval in SQLite by supplying its exact ID, their name, and the approval evidence reference. Keep that evidence in the operator's approval record. A binding approval only establishes the source assignment. When recording a SKU approval, the worker regenerates the plan using current evidence and requires the same SHA-256 ID. The approval expires after 15 minutes. A newer approval for that plan supersedes the prior approval sequence. An approval recorded without `--for-live` applies to the Phase 22B simulation.

```powershell
npm.cmd run --silent worker -- mockupify-sku-replacement-approve '<binding-id>' '<plan-id>' --by '<owner>' --source '<SKU execution approval evidence>'
npm.cmd run --silent worker -- mockupify-sku-replacement-inspect '<plan-id>'
```

The simulation checks the approval, shop identity, and write scope, repeats the Phase 22A evidence validation, reads all product variants twice as its last remote preflight, and verifies the exact plan again. It requires positive confirmation of a Hextom pause. The lowercase `adjust` tag and original SKUs do not establish that pause. It checks the clock immediately before dispatch and holds from 4:20 PM inclusive to 9:10 PM exclusive America/Chicago. The first SKU approval adds journal tables to the existing database. An existing Mockupify durability receipt is tied to the previous schema version and needs re-verification after this migration if you use the supervised Mockupify writer again.

Shopify supports a synchronous `productVariantsBulkUpdate` for one product. The 14 variants fit in its 250-item input limit. The worker sends only the product GID and each variant GID with `inventoryItem.sku`. It sets `allowPartialUpdates: false` so validation errors reject the whole request. The response includes returned variant IDs and SKUs plus `userErrors` with code, input field path, and message. The minimum mutation scope is `write_products`. Shopify also requires permission to update product variants. [Shopify mutation](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productVariantsBulkUpdate) [SKU input](https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/InventoryItemInput) [Input limits](https://shopify.dev/docs/api/usage/limits#input-limits)

A dispatch claim is committed before sending and is exclusive for the shop and product, even across different plan IDs and worker processes sharing the database. The journal stores the approval, dispatch, available Shopify response or error, and per-variant readback. If a response is lost or a worker stops after claiming, an original SKU seen afterward does not prove the request failed to run. A partial result is also held since it conflicts with the requested all-or-none behavior. Recovery reads the complete product again, records what is already at target or original and flags missing, duplicate or unexpected variants. An unexpected SKU or missing `adjust` tag holds for possible Hextom activity. Recovery sends no updates and never releases an uncertain claim for replay. Duplicate base SKUs are intentional for the pilot. Shopify documents uniqueness requirements for certain integrations such as Shopify Fulfillment Network, and acceptance by the pilot store has not been tested. [Shopify SKU guidance](https://help.shopify.com/en/manual/products/details/sku)

```powershell
npm.cmd run --silent worker -- mockupify-sku-replacement-reconcile '<plan-id>'
```

Live execution also requires a product-specific Hextom pause through readback and coordination with other Shopify editors. The documented mutation takes no expected-current-SKU condition, so a Shopify read followed by this mutation cannot prevent an external edit between requests. The SQLite claim coordinates workers sharing that database.

## Phase 22C gated live SKU adapter

Point `TEES4_DATABASE` at the existing pilot database and configure the standard read-only Shopify installation, Google Application Default Credentials, and `TEES4_MOCKUPIFY_API_KEY`. From the built project, verify the pilot with:

```sh
npm run --silent worker -- mockupify-sku-replacement-run 3e66387c-df11-4d88-ba05-cd498def29cb
```

The default mode opens SQLite read-only, checks the live Master Input row and stable Shopify product snapshot, and reads Mockupify export `20208` via GET to confirm the recorded provenance. It prints the immutable plan ID and the 14 proposed changes for product `gid://shopify/Product/10467506880803` and base SKU `8419620257-S105`. It uses the existing read-only Shopify credentials.

For an owner-authorized run, the owner separately records a live approval for that exact plan with `mockupify-sku-replacement-approve` and `--for-live`. That approval expires after 15 minutes. The live run requires `--execute`, the exact `--plan-id`, and the corresponding `--approval-sequence`. It blocks dispatch from 4:20 PM inclusive through 9:10 PM exclusive America/Chicago and rechecks the window after committing the SQLite claim.

Set `TEES4_SHOPIFY_SKU_WRITE_CLIENT_ID`, `TEES4_SHOPIFY_SKU_WRITE_CLIENT_SECRET`, and `TEES4_SHOPIFY_SKU_WRITE_INSTALLATION_ID` for a separately owner-authorized writer. The last value is the authorized `gid://shopify/AppInstallation/<id>`. Before dispatch the writer exchanges its own credentials for a token and queries the authenticated shop GID and domain, current app installation GID, and granted `write_products` scope. The mutation uses that verified token. There are no scope-change or installation operations.

Set `TEES4_HEXTOM_SKU_PAUSE_FILE` to an access-controlled JSON evidence file maintained by the operator responsible for Hextom. The operator must independently verify that SKU processing, including any pending or in-flight Hextom work, is paused for the specific product and can be kept paused through Shopify readback. Record that observation and hold using these fields:

| Field | Value |
| --- | --- |
| `shopId`, `productId` | Exact Shopify Shop and Product GIDs |
| `paused` | JSON boolean `true` |
| `verifiedBy`, `source` | Verifier and reference to the independent Hextom evidence |
| `verifiedAt`, `holdUntil` | UTC epoch milliseconds for the observation and end of the verified hold, at most 15 minutes apart |

This is an operator attestation from Hextom. The operator must withdraw the evidence if the hold is no longer in effect. The worker checks the same unexpired evidence before dispatch and on both sides of Shopify readback, and journals the evidence with the claim. Changed, missing, or expired evidence blocks dispatch or holds completion. The clock and Shopify's `adjust` tag cannot confirm a Hextom pause.

The mutation is sent once with `allowPartialUpdates: false`. The response must acknowledge every exact variant and target SKU before automatic readback. For errors, timeouts, partial acknowledgment, or failed readback, use `mockupify-sku-replacement-reconcile <plan-id>` to observe the product and journal the results using the read-only Shopify installation. Reconciliation preserves the exclusive claim and does not resend a mutation or substitute for missing Hextom evidence at readback.

## Backup and restoration

Keep the operation journal and binding registry together under the same `TEES4_DATABASE` path. The CLI uses SQLite's online backup API to snapshot the whole database, including committed WAL contents. Supply a new path on access-controlled storage. This uses no additional service.

```sh
npm run --silent worker -- mockupify-writer-backup /path/to/new-backup.sqlite
TEES4_DATABASE=/path/to/restored.sqlite npm run --silent worker -- mockupify-writer-inspect CORRELATION_ID
TEES4_DATABASE=/path/to/restored.sqlite npm run --silent worker -- binding-inspect BINDING_ID
```

For a cutover, stop all dispatchers, back up the database while they are stopped, preserve the latest database and any WAL files, copy the backup to a fresh path, and verify journal claims, identifier relationships, and binding histories before considering that store for use. Resolve any outstanding claims against fresh read-only evidence. A snapshot older than any possible POST cannot establish that an operation was never sent. If the latest journal is lost, stop dispatch and reconcile with the providers and owner records before creating any new authorization.

Tests cover a local process exit after a simulated vendor write, reopening SQLite, backup and restoration of both the claim and binding history, and duplicate prevention after restore. Durability verification exercises the actual database and backup directory and expires after 24 hours. It cannot establish storage persistence across a Codex environment replacement. Before the pilot, confirm owner-controlled storage and check that the exact configured database is admitted.
