# Tees-4 Production Worker

Phase 1 is a TypeScript and Node.js worker for exercising artwork intake, product processing, and manual publication approval with simulated services. All job and simulated effect records are stored in local SQLite.

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
| `TEES4_DATABASE` | `.tees4/worker.sqlite` | Local queue and simulated effect database |

Relative paths are resolved from the current working directory. Repeat `run` after a retry becomes due or after approving a gate. The command processes currently eligible stages and exits. Use `--limit N` to cap the number of stage claims, and `--mode simulate` on submission to exercise simulated writes. Only the simulated adapters are registered in the CLI. Execution logs are newline-delimited JSON on stderr. Commands emit JSON results on stdout and return a nonzero status for command errors or terminal failures encountered by `run`.

- [Architecture](docs/architecture.md)
- [Workflow configuration and recovery walkthrough](docs/workflow.md)
- [Development instructions](AGENTS.md)
