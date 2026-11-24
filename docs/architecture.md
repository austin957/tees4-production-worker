# Architecture

| Module | Responsibility |
| --- | --- |
| `src/config.ts` | Validates artwork, workflow definitions, mode, and environment overrides |
| `src/worker.ts` | Runs workflow stages, checks approval, routes actions, and builds job reports |
| `src/store.ts` | Persists jobs, leases, checkpoints, approvals, retry state, and simulated write receipts |
| `src/adapters.ts` | Defines typed platform boundaries and supplies simulated implementations |
| `src/cli.ts` | Provides local queue commands and structured logging |

The adapter interfaces cover Google Drive, Google Sheets, Mockupify, Shopify, TeeInBlue, Flash Transfers, the Tees-4 Design Engine, and the Tees-4 Affiliate Portal. Their operations reflect the Phase 1 fixtures. Google Drive only exposes reads. Mockupify generates a simulated mockup reference for the supplied artwork. Shopify separates draft creation from publication.

## Queue and recovery

SQLite transactions serialize decisions about submissions, stage claims, and approval. Each claim covers one stage. A worker commits its result only while holding a current claim token. After a lease expires, another invocation can claim that stage and record the recovery in job history. Successfully completed stages keep their checkpoints. Reported retryable errors consume the current stage's attempt budget. Expired leases are recovered independently of that budget because an interrupted process may have recorded an effect without returning an outcome.

A job's workflow is snapshotted at submission, so changing the example configuration cannot alter the stage order or approval requirements for jobs already queued. A matching submission returns the original job. Submissions for the same mode, artwork ID, and SKU with changed input or workflow fail with a conflict.

## Simulated writes

For the Phase 1 fixtures, the assigned SKU is the simulated product identity. Create and publish each use stable write keys scoped to that SKU. Mockup generation keys include both artwork ID and SKU. The simulated effect and its receipt are represented by one SQLite record. Returning the same receipt on retry prevents double creation if a process stops between storing the effect and checkpointing the job. Reusing a key with a different payload stops the job and reports a conflict. All processes exercising the same queue and effect ledger need to use the same database.

Dry-run plans the write before reaching the adapter dispatch, which leaves the simulated effect ledger empty. The worker records explicit approvals in both modes. Terminal failures and transient errors appear in JSON logs and durable job history.

## Sheet-backed SKU assignment

Phase 2 adds a read-only sheet adapter, artwork with multiple garment assignments, and a local Shopify product and variant catalog. See the [SKU processing guide](sku-processing.md) for matching, retry behavior, and the Hextom window.

Phase 3 adds authenticated Google Sheets intake with header validation and explicit row eligibility. It prepares the same queued artwork model from a verified selection and records unexpected variant SKUs for review. See the [Google Sheets intake guide](google-sheets.md).

## Phase 1 scope

This foundation runs against a local database and a CLI that drains currently available work. Operator names are local audit labels. The fixtures do not define production SKU uniqueness, source schemas, approval authority, platform write contracts, or reconciliation rules. Before enabling live integrations, define those rules with the owner and verify that each provider supports idempotent writes or can reliably reconcile an interrupted request.
