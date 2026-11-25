# Phase 21 supervised pilot preflight

## Owner approval record

The November 25, 2026 Phase 21 instructions are the owner-provided evidence. The owner's identity was not independently authenticated. This record approves pilot product details only. Batch creation, design upload and export each require separate live authorization. Any later deletion also requires separate approval.

| Field | Approved or preserved value |
| --- | --- |
| Source | Design Input Master → Master Input, physical row 36 |
| Original artwork-name cell | `SKU TEST`, preserved verbatim |
| Customer-facing Shopify title | `Bold Arrow Emblem` |
| Artwork SKU and Product SKU | `8419620257` and `8419620257-S105` |
| Garment and approved template | Adult Tank Top, `10779` |
| Approved colors in request order | Black `20514`, White `20515` |
| Pilot designer attribution | `Tees-4` |
| Approved artwork scope | The reviewed original PNG and its reviewed, pixel-identical compressed copy |
| Intended Shopify destination | `gid://shopify/Shop/76973965603` |

## Evidence and limits

- Connected Sheets reads verified the exact row, its blank completion cell, its one Product SKU match across the full Master Input Product SKU column, and the matching title and Artwork SKU in Artwork SKU Registry row 45. The production adapter now accepts the observed column A header. Its separate runtime Google credential exchange must also succeed before supervised dispatch can recheck the source.
- The Drive file referenced on row 36 was retrieved and decoded. The original is a 3300 × 2137 RGBA PNG, 1,542,125 bytes, above the worker's 1,500,000-byte upload limit. The reviewed compressed bytes and their SHA-256 remain outstanding. Keep the original and decoded pixel hashes with the private operational evidence.
- The authenticated Mockupify template read confirmed both color IDs on template `10779`, each with a base price of `18.99` and sizes X-Small, Small, Medium, Large, X-Large, 2X-Large and 3X-Large. Those selections project 14 color/size combinations. The API exposes neither size price adjustments nor final option ordering.
- The Shopify read-only client verified the shop GID. Mockupify's authenticated OpenAPI contract has no connected-shop or publication settings read. The 25 sampled historical export details exposed no products or Shopify IDs for corroboration. Obtain evidence of this account's current Shopify destination and of a supported setting or vendor guarantee that API exports start as draft and unpublished to all channels. The export request has only `batch` and `colors` fields.
- Mockupify documents that it joins the design title, template title and extra title. With the approved title as the design title, the documented composition yields `Bold Arrow Emblem Adult Tank Top`. A supported title configuration or separate approval for an exact composed title is needed. The final description and tags also combine template and design values. Review the template's actual description and tags, the exact upload fields, the vendor and its distinction from designer attribution, and all variant prices before authorization. Verify the resulting tags exclude `adjust`. [Mockupify OpenAPI](https://mockupify.io/api/schema/)
- The task workspace and shared/download directories use the same local overlay. The environment exposes one executor and no configured persistent data volume or separate restore target. Codex starts new tasks from their prepared environment in separate workspaces. The existing SQLite backup and restore test checks the claim, request digest, correlation ID, product binding and both audit histories locally. Production admission remains disabled until a separate Codex task can open the latest journal from owner-controlled durable storage and verify those records. [Codex Cloud task isolation](https://help.openai.com/en/articles/20001545-using-codex-cloud)

## Operation previews

Use the [supervised writer](mockupify-writer.md) to produce the approval digest from the exact complete plan, request, expected side effects and current journal IDs. The previews below are non-dispatchable. Nulls denote unresolved values. Where design metadata is incomplete, obtain explicit approval for all six design fields before generating any operation approval digest. The batch request itself already has a stable request digest.

### A · Create the isolated batch

`POST /api/batches/` with JSON `{"name":"tees4-6b7ffdea53cc1985343b375aabac5d5c"}`.

- Effect. One empty Mockupify batch reserved for this Product SKU.
- Request digest. `a3895291c65b4fd5d0e20db5e7e2f5fc81c3c7c8a12d94964ceeb2ce26d34dcd`. Operation approval digest is pending the complete verified plan.
- Preconditions. Verified artwork bytes and full pilot evidence, healthy authoritative source reads, durable journal and binding storage, and separate owner authorization. Check that no matching correlation already exists and that the binding registry is clear.
- Recovery. Read batches and membership. Require exactly one attributable batch and prove it is empty. An independent attestation of ownership and dispatcher termination is required for an uncertain acknowledgment. Preserve the original claim.

### B · Upload the approved PNG

`POST /api/designs/` with multipart fields `batch`, `title`, `description`, `extra_title`, `search_tags`, `vendor`, `extra_price`, `design_id` and `file`. The design reference is `tees4:6b7ffdea53cc1985343b375aabac5d5c421911de79c06f45c7159868ed643eea`. The file part uses name `review.png` and media type `image/png`. The batch ID, exact approved final design fields and reviewed compressed PNG digest are pending.

- Effect. One design and its reviewed metadata in the reserved batch.
- Approval digest. Pending the exact batch ID and upload fields, including the verified prepared artwork SHA-256.
- Preconditions. A completed batch claim or read-only recovery, an empty exclusive batch, verified approved bytes within the upload limit, and separate owner authorization.
- Recovery. Read `GET /api/designs/?batch={id}` and verify the single exact design reference, metadata and design identity. An uncertain upload also requires independent matching artwork hash evidence and proof the previous dispatcher stopped. Keep conflicts held.

### C · Export one design

`POST /api/exports/` with JSON `{"batch":null,"colors":[20514,20515]}`. Supply only the verified numeric batch ID in place of null. The design ID belongs in the approval scope and final membership check.

- Effect. One Mockupify export and one expected draft Shopify product with the approved variants.
- Approval digest. Pending the real batch and design IDs, exact Shopify output expectations, and verified draft-only setting.
- Preconditions. Recheck that the isolated batch contains exactly the intended design, confirm exclusive control through completion, verify live shop, catalog, durable claims and capacity, configure `TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES`, and obtain separate authorization. Export remains blocked from 4:20 PM inclusive until 9:10 PM exclusive America/Chicago and within the configured margin before cutoff.
- Recovery. Read the exact export ID or reconcile a unique result by batch, design, template and color evidence. Use export-returned GIDs and verify Shopify product state in the exact shop. Partial or ambiguous evidence remains held. There is no automatic repeat, publication, SKU change or binding approval.
