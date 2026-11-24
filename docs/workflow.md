# Workflow and recovery

The checked-in [workflow](../examples/workflow.json) validates the [sample job](../examples/artwork.json), checks simulated Drive, Sheets, and Affiliate Portal records, generates a mockup, creates a product draft, pauses for approval, and then simulates publication. The submitted fixture supplies the artwork ID, original artwork reference, designer ID, assigned SKU, and product title. Missing fields or conflicting simulated source responses stop processing. There is no artwork modification stage.

## Configure a workflow

A workflow contains an ID, a list of stages, `maxAttempts` per stage, a fixed delay `retryDelayMs`, and a lease duration `leaseMs`. Give each stage a unique ID. Stage kinds are `validate`, `action`, and `approval`. Use a single validation stage first. An action stage requires an action from the following list.

| Action | Behavior in Phase 1 |
| --- | --- |
| `drive.readArtwork` | Verifies the original artwork reference |
| `sheets.readAssignment` | Verifies the assigned SKU and product title |
| `affiliatePortal.readSubmission` | Verifies designer attribution |
| `teeinblue.readDesign` | Returns a simulated design lookup |
| `flashTransfers.readProduct` | Returns a simulated transfer product lookup |
| `designEngine.readDesign` | Returns a simulated design lookup |
| `mockupify.generate` | Records a reusable mockup reference |
| `shopify.create` | Records a reusable product draft and attribution |
| `shopify.publish` | Records publication after a recorded approval |

A publish stage requires a preceding product creation stage and an approval stage between creation and publication. Approval applies to a particular job and stage. Multiple gates can be configured. Repeating approval for an already approved stage preserves its original recorded approver.

## Exercise simulated recovery

Use a fresh database path if you already ran this example in simulate mode. The commands below expect the repository root and the default example configuration.

```sh
export TEES4_DATABASE=.tees4/recovery-demo.sqlite
npm run --silent worker -- submit examples/artwork.json --mode simulate
npm run --silent worker -- run --fail-after-create
npm run --silent worker -- inspect JOB_ID
npm run --silent worker -- effects
```

Replace `JOB_ID` with the submitted ID. The job reports `retry_wait`, a `retryAt` time in epoch milliseconds, and a `SIMULATED_TIMEOUT` in its history. The effect ledger shows one mockup generation and one product creation. The injection happens after recording product creation, so the retry can reuse the receipt.

```sh
sleep 1
npm run --silent worker -- run
npm run --silent worker -- inspect JOB_ID
npm run --silent worker -- approve JOB_ID approve-publication --by local-operator
npm run --silent worker -- run
npm run --silent worker -- inspect JOB_ID
npm run --silent worker -- effects
```

Before approval, the report shows `awaiting_approval`, the draft stage reports `reused`, and the ledger has no publication. After approval, the completion report shows the designer, stage outcomes, approval details, and job history. The ledger shows one creation and one publication. To exercise recovery from an interrupted process, run the worker again once the interrupted stage's lease expires. The automated suite verifies that the recovered stage reuses the existing receipt.
