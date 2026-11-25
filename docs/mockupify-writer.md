# Phase 20 supervised Mockupify writer

See the [Phase 21 row 36 approval record and preflight](mockupify-pilot-row-36.md) for current pilot evidence.

The existing export queue still uses its simulator. Phase 20 builds and validates the documented Mockupify POST requests through a separately injected fake HTTP transport. Simulation uses `mockupify.invalid` and a synthetic credential. The CLI exposes offline preview and local inspection, SQLite backup, and reconciliation using read-only vendor APIs. There is no CLI dispatch command. The shipped SQLite Store cannot admit production dispatch because it has no verified durability capability.

## Row 36 dry run

Run from the repository root after building.

```sh
npm run --silent worker -- mockupify-writer-dry-run
```

The offline command reports zero HTTP requests and zero claims. It records row 36, Artwork SKU `8419620257`, Product SKU `8419620257-S105`, and the approved Adult Tank Top mapping to template `10779`. Black `20514` and White `20515` are owner-approved. Master Input says **SKU TEST**. The product title and artwork registry say **Bold Arrow Emblem**. The trace preserves the original source name, shows the expected Active status with zero channel publications, and keeps the reviewed compressed PNG and exact upload metadata pending. Batch, design, export and Shopify Product GID are unset.

## Claims and preflight

A supervised plan uses `config/mockupify-approved-v1.json` and the existing preparation checks. It records the physical source row and exact values, both artwork names and a resolution record when the names differ, the reviewed PNG hashes, designer attribution, multipart design fields, selected catalog colors and expected Shopify metadata, prices and variants. The operator supplies independently validated evidence that the Mockupify account is connected to the exact Shopify shop, exports yield Active products with the expected tags and zero sales-channel publications, and the isolated batch is under exclusive control through export completion. Mockupify's export request has only `batch` and `colors` fields. Before export, the worker verifies Shopify publication read access and requires a time-bounded, owner-reviewed Hextom safety record in `publicationSafety`. The record contains an `evidence` reference, `startsAt` and `endsAt` in epoch milliseconds, and the `minimumMinutes` needed for export and observation. The export must leave more than that minimum before the safe interval ends. Verify the actual Hextom channel-assignment rule and its earliest eligible run as described in the [row 36 preflight](mockupify-pilot-row-36.md).

Each POST needs a separate, unexpired owner attestation with operator identity and a reference to their review. The approval digest binds the plan and its expected side effects to the exact request and current batch/design IDs. The request digest covers the method, endpoint and JSON or multipart fields, including the upload file SHA-256. The trust boundary is the authorized operator supplying the attestation, as with existing binding approval. An operation preview supplies a digest for review.

```sh
npm run --silent worker -- mockupify-writer-preview CORRELATION_ID create_batch
npm run --silent worker -- mockupify-writer-inspect CORRELATION_ID
```

For each operation, the writer rechecks the unique physical Master Input row, selected template and colors, current Shopify shop, and conflicts in the binding registry. It checks that a batch is empty before upload, and immediately before export verifies that exactly the approved design is present by batch ID, design ID, reference and metadata. An existing export for the batch blocks dispatch. SQLite claims reserve each Product SKU and remote batch, design and export IDs. Claims persist before POST. Export dispatch checks the daily 4:20 PM inclusive to 9:10 PM exclusive America/Chicago protected window and the explicitly configured safety margin. The journal meters supervised requests at 1,200 per hour and 60 export starts per hour, checks for at most two concurrent exports across local claims and visible vendor jobs, and observes vendor rate-limit responses. Other tools or dashboard activity can consume account capacity. Mockupify remains the authority for account quotas. Allow a few seconds between export status reads.

## Recovery and binding review

```sh
npm run --silent worker -- mockupify-writer-reconcile CORRELATION_ID
npm run --silent worker -- mockupify-writer-reconcile CORRELATION_ID recovery-attestation.json
```

The CLI reconciliation uses live GETs for a production journal and Shopify's fixed read queries when product IDs are present. For reconciliation, supply dedicated Shopify credentials restricted to `read_products` and `read_publications` through the existing Shopify environment variables. Keep the product-only credentials for the other Shopify commands. Reconciliation updates the local journal. Simulation evidence uses the injected fake client. A timeout, failed response, crash after claim, or ambiguous acknowledgment leaves the operation held. Missing evidence leaves the claim in place. There is no reset or resend workflow.

A lost batch or upload acknowledgment requires a unique read-only match and independent recovery evidence. The optional JSON attestation carries `operation`, `remoteId`, `requestDigest`, `by`, `evidence`, and `dispatcherStoppedEvidence`. For a design upload, supply `artworkSha256` from independent verification of the remote artwork. An export acknowledgment supplies an export ID to poll. If the acknowledgment was lost, a unique export found for the batch must also provide explicit design, template and color evidence before the journal adopts the ID. The journal retains returned numeric IDs, GIDs, status, and vendor error references and timestamps. For partial results it records the evidence and keeps the export held.

For full export validation, the writer requires a finished status, exact batch/design/template/color relationships, one created product with an explicit Product GID, and a stable Shopify read of that GID in the approved shop showing Active status, the exact metadata and variants, and zero current or staged sales-channel publications. Publication is checked separately through the Shopify APP publication connection. The worker holds if a publication is observed, evidence is incomplete, or the verified test interval has ended. A returned numeric ID can be used for a read-only lookup. Validated evidence can support the existing [product binding review](product-bindings.md), which still requires the owner's separate approval and live checks.

## Backup and restoration

Keep the operation journal and binding registry together under the same `TEES4_DATABASE` path. The CLI uses SQLite's online backup API to snapshot the whole database, including committed WAL contents. Supply a new path on access-controlled storage. This uses no additional service.

```sh
npm run --silent worker -- mockupify-writer-backup /path/to/new-backup.sqlite
TEES4_DATABASE=/path/to/restored.sqlite npm run --silent worker -- mockupify-writer-inspect CORRELATION_ID
TEES4_DATABASE=/path/to/restored.sqlite npm run --silent worker -- binding-inspect BINDING_ID
```

For a cutover, stop all dispatchers, back up the database while they are stopped, preserve the latest database and any WAL files, copy the backup to a fresh path, and verify journal claims, identifier relationships, and binding histories before considering that store for use. Resolve any outstanding claims against fresh read-only evidence. A snapshot older than any possible POST cannot establish that an operation was never sent. If the latest journal is lost, stop dispatch and reconcile with the providers and owner records before creating any new authorization.

Tests cover a local process exit after a simulated vendor write, reopening SQLite, backup and restoration of both the claim and binding history, and duplicate prevention after restore. Actual storage and restoration across Codex environment replacement remain unverified. Before any supervised production pilot, establish that storage and rehearse cutover, obtain the outstanding owner approvals, and verify the account, publication access, Hextom-safe interval and restricted schedule.
