# Row 9 supervised pilot preflight

Phase 21B cleared the Shopify publication read-access blocker. Phase 21D confirms the configured Hextom schedule timezone. The run-history display timezone and a safe interval for the pilot remain unverified. The [supervised CLI](mockupify-writer.md#windows-powershell) can register the pilot as `pending_review` with the verified artwork, source and catalog. Finalization requires a complete review and verified Hextom-safe interval. Dispatch also requires durable storage and operation-specific approval.

## Owner approval record

The November 25, 2026 Phase 21 instructions and Phase 21A clarification are the owner-provided evidence. The owner's identity was not independently authenticated. This record approves pilot product details only. Batch creation, design upload and export each require separate live authorization. Any later deletion also requires separate approval.

| Field | Approved or preserved value |
| --- | --- |
| Source | Design Input Master (`1UxdIY03ICu5t2G0fEo0nor6-giAEF4xdMuNEvYN_JMM`) → Master Input, physical row 9 |
| Original artwork-name cell | `SKU TEST`, preserved verbatim |
| Mockupify design title | `Bold Arrow Emblem` |
| Artwork SKU and Product SKU | `8419620257` and `8419620257-S105` |
| Garment and approved template | Adult Tank Top, `10779` (type `Tank Top`) |
| Approved colors in request order | Black `20514`, White `20515` |
| Vendor and designer attribution | `test test`, `Tees-4` |
| Master Input and Mockupify design tags | `Family, Grandpa` |
| Verified template tags | `readytobuy`, `adult`, `S105`, `adjust`, `stock` |
| Expected Shopify tags | `readytobuy`, `adult`, `S105`, `adjust`, `stock`, `Family`, `Grandpa` |
| Approved artwork scope | Reviewed original and compressed copy. Prepared SHA-256 `6bae2628c23f42d960ef36e488bde69f84fe994d68e084218674b465a9354d17` |
| Intended Shopify destination | `gid://shopify/Shop/76973965603` |

## Evidence and limits

- The owner supplied the corrected physical row and its values for columns A, B, E, H and K. The CLI dry-run uses that offline fixture. Supervised preparation and dispatch require a fresh read through the worker's read-only Sheets adapter to verify the physical row, its unique Product SKU, its Artwork SKU and garment, and the rest of the approved source data.
- The previously reviewed original artwork is a 3300 × 2137 RGBA PNG, 1,542,125 bytes, above the worker's 1,500,000-byte upload limit. Confirm the corrected row's artwork reference before relying on the earlier review. Supply the reviewed compressed bytes matching the approved SHA-256. Keep the original and decoded pixel hashes with the private operational evidence.
- The verified settings for template `10779` use `Color` as the Shopify color option. Each color has a base price of `18.99`, quantity 999, weight 128 grams and sizes X-Small, Small, Medium, Large, X-Large, 2X-Large and 3X-Large. Those selections project 14 color and size combinations. Verify the final Shopify option names and variant prices in the metadata review.
- The Shopify read-only client verified the shop GID. Mockupify's authenticated OpenAPI contract exposes no connected-shop read. Obtain independent evidence of the account's current Shopify destination. The export request has only `batch` and `colors` fields.
- The owner confirmed that Mockupify creates an **Active** Shopify product with **zero sales-channel publications** and an existing Hextom automation later assigns channels. In Phase 21B, Shopify Admin GraphQL `2026-10` returned `gid://shopify/Shop/76973965603` and reported exactly `read_products` and `read_publications` for the export verification app. The worker's publication query returned valid data for a sample product. The pilot still requires a direct read of the exact exported Product GID showing zero current or staged sales-channel publications. [Shopify Product publication fields](https://shopify.dev/docs/api/admin-graphql/latest/objects/product#field-Product.fields.resourcePublicationsV2)
- Mockupify documents that it joins the design title, template title and extra title. With the approved title as the design title, the documented composition yields `Bold Arrow Emblem Adult Tank Top`. A supported title configuration or separate approval for an exact composed title is needed. Tags combine template and design values. Review the exact upload and resulting product metadata and all variant prices before authorization. Keep the source and design tags as `Family, Grandpa`. The Shopify review and reconciliation require the exact seven tags above and reject duplicates. [Mockupify OpenAPI](https://mockupify.io/api/schema/)
- The task workspace and shared/download directories use the same local overlay. The environment exposes one executor and no configured persistent data volume or separate restore target. Codex starts new tasks from their prepared environment in separate workspaces. The existing SQLite backup and restore test checks the claim, request digest, correlation ID, product binding and both audit histories locally. The pilot requires owner-controlled durable storage and a passing durability check for the actual SQLite path and backup directory. [Codex Cloud task isolation](https://help.openai.com/en/articles/20001545-using-codex-cloud)

## Initial and Hextom-enhanced descriptions

The design copy comes from Master Input row 9.

> Charge ahead with this striking arrow-shaped design, featuring bold letters that shout confidence and energy. A sharp and dynamic statement piece to show your unstoppable spirit!

Record the exact text that will go in the Mockupify design page, including the `Tees-4` designer attribution, in `design.description`. The owner removed the garment description from Adult Tank Top template `10779`, so the initial Shopify product should contain the artwork description and attribution. Hextom adds the garment information to that description later.

The review file’s `product.descriptionHtml` must be the exact **initial** HTML returned by Shopify. The confirmed plain text establishes the copy. The upload formatting and Shopify’s stored HTML still require review. Before finalization, obtain a trusted pre-Hextom record of the raw Shopify Admin GraphQL `Product.descriptionHtml` for the same design payload and template settings, or obtain exact output confirmed by Mockupify for those inputs. An already enhanced product, rendered storefront text, or a sample with different inputs leaves the exact initial HTML unverified. If suitable evidence is unavailable, record `product.descriptionHtml` as null and keep the plan pending. [Shopify Product fields](https://shopify.dev/docs/api/admin-graphql/latest/objects/product)

After a separately authorized export, use `mockupify-writer-reconcile` during the verified safe interval, before Hextom runs. It reads the exact export-returned Product GID and compares its raw HTML, other reviewed metadata, variants, and publication state. `mockupify-writer-inspect` exposes the recorded Shopify snapshots. A later read of Hextom-enhanced HTML cannot establish that the initial HTML matched. A later `held` result from export reconciliation reflects the current initial-export checks, while the observed GID and earlier evidence remain in the journal. For an approved binding, use `shopify-post-hextom` for the later SKU stage. It uses the bound shop and Product GIDs, variant SKUs and `adjust` state. Description enhancement alone establishes neither a different product identity nor Hextom SKU completion. Binding rechecks still require the saved Shopify snapshot to match the current snapshot. A stale snapshot calls for fresh review of the same GID and source linkage.

## Hextom publication timing

The owner's Phase 21D screenshot of the Hextom Bulk Product Edit scheduling interface confirms the configured schedule for the active **Channel Availability** task. The run history and filters are the owner's Phase 21C observations. This evidence comes from the Hextom interface as reported by the owner.

| Evidence | Displayed value |
| --- | --- |
| Configured frequency | Daily |
| Configured run time | 7:00 PM |
| Configured timezone | (GMT-6) America/Chicago |
| November 24, 2026 run history | Started approximately 6:00 PM and edited 91 products |
| November 23, 2026 run history | Started approximately 6:01 PM and edited 35 products |

The task uses **ALL** of these conditions:

- Product status is Active.
- Product tag is `adjust`.
- Product is not published to selected sales channels.

The task publishes qualifying products to Online Store, Facebook & Instagram, Shop, Faire, Inbox, and Google & YouTube. The pilot’s expected Active product carries the template’s `adjust` tag and is potentially eligible for publication while unpublished to the selected channels. The tag provides no evidence of Hextom completion or a safe interval. The previously observed 6:15 PM SKU transformation and 9:00 PM tag removal are separate tasks and provide no verified timing for channel assignment.

The configured **7:00 PM America/Chicago** run falls within the protected window. The run-history display timezone remains unverified. Approximately **6:00 PM as shown in the run history** is the earliest displayed start among the supplied entries. The difference between the displayed times remains unexplained, and the earliest possible future execution is still unverified. For dispatch planning, treat exposure as possible as soon as the exported product qualifies. A queued or running eligible task could publish it before the first Shopify read.

Before any future dispatch, use read-only evidence to confirm the run-history display timezone, reconcile the historical starts with the configured schedule, and check for queued or running instances. Verify the earliest eligible run and record a safe interval with explicit start and end times and the minimum time needed for export and observation. The entire test must finish before any eligible publication run. Hold if timing, eligibility, or the full interval remains unverified. Keep the Hextom task enabled with its existing configuration. Separately, the daily protected window remains **4:20 PM inclusive to 9:10 PM exclusive America/Chicago**, with the configured export safety margin before cutoff. [Hextom scheduled tasks](https://bpe-help-center.hextom.com/article/732-tutorials-on-using-scheduled-tasks-bpe)

Read the APP publication connection for the exact exported Shopify Product GID immediately after export, during the supervised test, and again before the verified interval ends. Include current and staged publications. Hold if any are observed, publication evidence is unavailable, or the interval expires before completion. An empty publication read describes only that moment. Confirm the product's disposition with the owner before any separately authorized cleanup.

## Pending registration and operation requirements

Use `mockupify-writer-register-pending` to record the verified facts and reviewed values in SQLite, then `mockupify-writer-readiness` to list the remaining requirements. The current missing evidence includes the raw initial Shopify HTML and its evidence reference, and the verified Hextom-safe interval. Leave the expected Shopify title, final variant details or exclusive batch control evidence null as well if they are unconfirmed. Finalize to make the following operations individually eligible for approval.

| Operation | Requirements before dispatch |
| --- | --- |
| `create_batch` | Finalized plan, current durability admission, fresh source, catalog, shop and binding checks, no existing batch or design correlation, quota, and owner approval for the exact batch request |
| `upload_design` | Finalized plan, current durability admission, verified empty isolated batch, exact reviewed PNG and upload metadata, fresh checks and quota, and separate owner approval |
| `start_export` | Finalized plan, current durability admission, exactly one verified design in the exclusive batch, no existing export, fresh Shopify publication read access, available export capacity and quota, a verified Hextom-safe interval and configured margin outside the protected hours, and separate owner approval |

## Operation previews

Use the [supervised writer](mockupify-writer.md) to register the complete plan and preview the exact request, expected side effects, current journal IDs and approval digest. The examples below show the expected request shapes. Nulls denote unresolved values. Where design metadata is incomplete, obtain explicit approval for all six design fields before generating any operation approval digest. The batch request itself already has a stable request digest.

### A · Create the isolated batch

`POST /api/batches/` with JSON `{"name":"tees4-6b7ffdea53cc1985343b375aabac5d5c"}`.

- Effect. One empty Mockupify batch reserved for this Product SKU.
- Request digest. `a3895291c65b4fd5d0e20db5e7e2f5fc81c3c7c8a12d94964ceeb2ce26d34dcd`. Operation approval digest is pending the complete verified plan.
- Preconditions. Verified artwork bytes and full pilot evidence, healthy authoritative source reads, durable journal and binding storage, and separate owner authorization. Check that no matching correlation already exists and that the binding registry is clear.
- Recovery. Read batches and membership. Require exactly one attributable batch and prove it is empty. An independent attestation of ownership and dispatcher termination is required for an uncertain acknowledgment. Preserve the original claim.

### B · Upload the approved PNG

`POST /api/designs/` with multipart fields `batch`, `title`, `description`, `extra_title`, `search_tags`, `vendor`, `extra_price`, `design_id` and `file`. The design reference is `tees4:6b7ffdea53cc1985343b375aabac5d5c421911de79c06f45c7159868ed643eea`. The file part uses name `review.png` and media type `image/png`. The real batch ID and the rest of the exact reviewed design fields come from the journal and metadata review.

- Effect. One design and its reviewed metadata in the reserved batch.
- Approval digest. Pending the exact batch ID and upload fields, including the verified prepared artwork SHA-256.
- Preconditions. A completed batch claim or read-only recovery, an empty exclusive batch, verified approved bytes within the upload limit, and separate owner authorization.
- Recovery. Read `GET /api/designs/?batch={id}` and verify the single exact design reference, metadata and design identity. An uncertain upload also requires independent matching artwork hash evidence and proof the previous dispatcher stopped. Keep conflicts held.

### C · Export one design

`POST /api/exports/` with JSON `{"batch":null,"colors":[20514,20515]}`. Supply only the verified numeric batch ID in place of null. The design ID belongs in the approval scope and final membership check.

- Effect. One Mockupify export and one expected Active Shopify product with the approved variants and zero sales-channel publications.
- Approval digest. Pending the real batch and design IDs, exact Shopify output expectations, and the verified Hextom-safe interval.
- Preconditions. Recheck that the isolated batch contains exactly the intended design, confirm exclusive control through completion, verify live shop, catalog, read-only Shopify publication access, Hextom-safe interval, durable claims and capacity, configure `TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES`, and obtain separate authorization. Export remains blocked from 4:20 PM inclusive until 9:10 PM exclusive America/Chicago and within the configured margin before cutoff.
- Recovery. Read the exact export ID or reconcile a unique result by batch, design, template and color evidence. Use export-returned GIDs and verify Active status and zero current or staged sales-channel publications in the exact shop. Partial or ambiguous evidence remains held. There is no automatic repeat, publication, SKU change or binding approval.
