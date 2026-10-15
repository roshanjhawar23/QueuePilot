# QueuePilot

A cloud-native **asynchronous file-processing and failure-recovery platform** on AWS.

You upload a CSV, text or JSON file; QueuePilot queues a job, processes it in the background on AWS Lambda, and shows every attempt. When jobs fail you can see why, watch retries with backoff, find dead-lettered jobs in a real SQS dead-letter queue, and recover them with a corrected retry or a bulk redrive.

**Everything the dashboard shows comes from AWS at request time:** S3, SQS, DynamoDB and Lambda results. There is no mock or sample data in the application. The only deliberate failures come from the clearly labelled **fault-injection demo control**. It makes the real worker fail on purpose, and everything after that (exceptions, timeouts, SQS redelivery, the DLQ, the alarm) is genuine.

> **Status (10 Oct 2026):** implemented and tested locally (120 automated tests passing, template validated). **Not yet deployed.** The next step is the AWS deployment described in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). See [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) for the exact state.

## What it does

| Job type | Input | Real computation | Output in S3 |
|---|---|---|---|
| `csv.summary` | `.csv` | Parses and validates rows, per-column counts and missing values, min/max/mean/median/std-dev, top categories, date ranges, malformed-row report | `result.json`, `cleaned.csv` |
| `text.analytics` | `.txt`, `.md` | Word, sentence and paragraph counts, reading time, top meaningful terms, long sentences (Markdown syntax stripped) | `result.json` |
| `data.validate` | `.csv`, `.json` + rules | Required fields, types (string/number/integer/boolean/date/email), numeric ranges, allowed values | `report.json` |

**Reliability features:**
- 5 MB upload limit enforced by S3;
- idempotent submission;
- retries with exponential backoff (5 s, then 20 s);
- non-retryable errors fail fast;
- a dead-letter queue after 3 attempts;
- per-job retry with corrected parameters;
- bulk DLQ redrive (SQS `StartMessageMoveTask`);
- stale and duplicate message protection;
- Lambda timeout recovery;
- backup and restore of job records;
- CloudWatch logs, custom metrics, a dashboard and 4 alarms.

## Architecture

```
Browser (React) ──HTTPS──> API Gateway (HTTP API, token authorizer, throttled) ──> Lambda "api" ──> DynamoDB
     │                                                                                │
     └── presigned POST (≤ 5 MB) ──> S3 (inputs/outputs/backups)              SQS jobs queue ──> Lambda "worker" ──> S3 + DynamoDB
                                                                                      │ 3 failed attempts
                                                                                      └──> SQS dead-letter queue ──(redrive)──┘
                                         CloudWatch: logs · metrics · dashboard · alarms
```
Full diagrams and design decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tech stack

- **Frontend:** React 19 + TypeScript + Vite.
- **Backend:** TypeScript on AWS Lambda (Node.js 22, arm64), API Gateway HTTP API, SQS + DLQ, DynamoDB (on-demand), S3, CloudWatch and IAM.
- **Infrastructure as code:** AWS SAM / CloudFormation (`backend/template.yaml`).
- **Tests:** Vitest, Testing Library, aws-sdk-client-mock (unit tests only), and a live end-to-end suite.

## Quick start

```powershell
npm ci             # install (Node.js 22.12+)
npm run check      # typecheck + lint + 120 tests + builds; no AWS account needed
```
Then follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**:
1. `preflight.ps1`
2. `deploy-budget.ps1`
3. `deploy-backend.ps1`
4. `run-e2e.ps1`
5. `deploy-frontend.ps1`

## Repository map

```
QueuePilot/
├─ README.md, PROJECT_CONTEXT.md
├─ docs/            ARCHITECTURE, AWS_SERVICES, COST_CONTROL, SECURITY, DEPLOYMENT,
│                   TESTING, RECOVERY, DEMO_SCRIPT, PLAN
├─ shared/          job model + API schemas (zod) used by backend AND frontend
├─ backend/
│  ├─ template.yaml        all AWS resources (SAM/CloudFormation)
│  ├─ samconfig.toml       stack name/region/tags (no secrets)
│  ├─ scripts/build.mjs    esbuild bundling of the 3 Lambdas
│  ├─ src/handlers/        api.ts (router), worker.ts (SQS consumer), authorizer.ts
│  ├─ src/routes/          uploads, jobs (+retry/delete), system (metrics/DLQ), backups
│  ├─ src/processors/      csvSummary, textAnalytics, dataValidate, faultInjection, csv parser
│  ├─ src/lib/             DynamoDB repo, SQS/S3 adapters, claim/lease logic, backoff, logging, EMF metrics
│  └─ tests/unit, tests/e2e
├─ frontend/src/    pages: Dashboard, Submit, Jobs, JobDetail, Recovery, Backups
├─ infra/budget.yaml       AWS Budget with email alerts
├─ scripts/         preflight, deploy-budget, deploy-backend, run-e2e, deploy-frontend, teardown (.ps1), burst.mjs
└─ sample-data/     sales.csv, malformed.csv, customers.csv (+rules), orders.json (+rules), article.txt, release-notes.md
```

## Documentation

| Read this | To learn |
|---|---|
| [docs/AWS_SERVICES.md](docs/AWS_SERVICES.md) | Every AWS service: what it is, how it is configured here, its cost, where to see it, and what to tell your teacher |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Request flow, job states, data model, API, design trade-offs, known limitations |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Step-by-step deployment on Windows with a safe AWS identity |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | The 12-minute live demonstration with likely questions |
| [docs/RECOVERY.md](docs/RECOVERY.md) | Runbook for failed, dead-lettered and stuck jobs, and alarms |
| [docs/COST_CONTROL.md](docs/COST_CONTROL.md) | Expected cost and the 14 guardrails |
| [docs/SECURITY.md](docs/SECURITY.md) | Credentials, token handling, IAM, data protection |
| [docs/TESTING.md](docs/TESTING.md) | Test suites and the latest actual results |

## Cost and teardown

Expected total spend for building, testing and demonstrating: **about $1–5**. When finished:
```powershell
.\scripts\teardown.ps1 -Profile queuepilot
```
