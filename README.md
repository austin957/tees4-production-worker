# Tees-4 Production Worker

The TypeScript and Node.js worker exercises artwork intake, product processing, manual publication approval, and initial variant SKU assignment with simulated services. All job and simulated effect records are stored in local SQLite.

## Setup

Use Node.js 24 and npm. Run these commands from the repository root.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run worker -- help
```

## Run a dry-run job

```sh
npm run --silent worker -- submit examples/artwork.json
npm run --silent worker -- run
npm run --silent worker -- list
```

Copy the `jobId` from the submit output. Review the planned actions and recorded designer before approving this fixture.

```sh
npm run --silent worker -- inspect JOB_ID
npm run --silent worker -- approve JOB_ID approve-publication --by local-operator
npm run --silent worker -- run
npm run --silent worker -- inspect JOB_ID
npm run --silent worker -- effects
```

The final report shows `completed` and three `planned` stages. The effects command returns `{}` on a fresh database used for dry runs only. Dry-run writes job, approval, and checkpoint records to SQLite.

## Configuration and usage

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEES4_CONFIG` | `examples/workflow.json` | Workflow JSON used when submitting new jobs |
| `TEES4_DATABASE` | `.tees4/worker.sqlite` | Local queue, simulated effects, and product binding registry |
| `TEES4_MOCKUPIFY_EXPORT_MARGIN_MINUTES` | Unset | Positive whole-minute safety margin required to start a new simulated Mockupify export |

Relative paths are resolved from the current working directory. Repeat `run` after a retry becomes due or after approving a gate. The command processes currently eligible stages and exits. Use `--limit N` to cap the number of stage claims, and `--mode simulate` on submission to exercise simulated writes. Only the simulated adapters are registered in the CLI. Execution logs are newline-delimited JSON on stderr. Commands emit JSON results on stdout and return a nonzero status for command errors or terminal failures encountered by `run`.

- [Architecture](docs/architecture.md)
- [Workflow configuration and recovery walkthrough](docs/workflow.md)
- [Product binding registry](docs/product-bindings.md)
- [Development instructions](AGENTS.md)

## Phase 2 sheet-backed SKU workflow

Use the [SKU processing guide](docs/sku-processing.md) to run a two-garment fixture, preview variant assignments, or simulate local SKU writes. The guide describes the read-only Master Input adapter, Shopify ID bindings, and the Central-time protection window.

## Phase 3 Google Sheets intake

The [Google Sheets intake guide](docs/google-sheets.md) covers read-only authorization, header and eligibility configuration, and previewing or queuing verified garment assignments. Mockupify and Shopify continue to use simulated adapters.

## Phase 4 garment completion

The [garment completion guide](docs/garment-completion.md) shows how to simulate a Master Input column I update and inspect independent results for each garment.

## Phase 5 Mockupify export preparation

The [Mockupify guide](docs/mockupify.md) explains template and color mapping, the simulated export queue, Shopify ID capture, and how to reconcile an uncertain export.

## Phase 6 Shopify read-only inspection

The [Shopify read-only guide](docs/shopify-readonly.md) covers authorizing the dedicated app, inspecting products and variants, and comparing explicit Shopify bindings against Master Input.

## Phase 9 source SKU reconciliation

Use [source SKU reconciliation](docs/shopify-reconciliation.md) to compare independently reviewed source evidence and Master Input rows against a known Shopify product. The command only reports possible bindings for owner review.

## Phase 10 product matching

Use the [product matching guide](docs/shopify-product-matching.md) to rank Shopify candidates against Master Input and produce binding proposals for owner review.
