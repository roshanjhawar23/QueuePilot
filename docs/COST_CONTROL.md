# Cost control ($130 budget, realistic spend: a few dollars at most)

## Why this design is cheap

Every component is **serverless and pay-per-use**, so QueuePilot costs **nothing while nobody is using it**:
- no virtual machines, databases-on-servers, NAT gateways or load balancers;
- no customer-managed encryption keys.

The only "standing" items are tiny: a few MB in S3, and alarms and a dashboard that fit in the CloudWatch free tier.

## Estimated cost for the whole project (build + testing + demo, ~5,000 jobs)

| Service | Usage | Estimate |
|---|---|---|
| Lambda (arm64) | ~20,000 invocations, mostly < 1 s | $0.00–$0.10 (free tier covers it) |
| API Gateway HTTP API | ~50,000 requests (the dashboard polls every few seconds) | ~$0.05 |
| SQS | ~30,000 requests | $0.00 (first 1 M free) |
| DynamoDB on-demand | ~100,000 reads/writes, < 50 MB | < $0.15 |
| S3 | < 100 MB, deleted after 3 days | < $0.05 |
| CloudWatch | Logs ≪ 1 GB; 7 custom metrics, 4 alarms, 1 dashboard | < $1.00 |
| **Total** | | **≈ $1–5** |

These are estimates based on list prices; verify them at <https://aws.amazon.com/pricing/>. Free-tier eligibility depends on your account's age and plan.

## Guardrails built into the project

| # | Guardrail | Where | What it prevents |
|---|---|---|---|
| 1 | **AWS Budget** with alerts at ≈ $5, $20, $50, $100 + a forecast alert | `infra/budget.yaml`, `scripts/deploy-budget.ps1` | Surprise bills. **Deploy this first.** Budgets alert; they do not stop spending. |
| 2 | API throttling: 10 req/s, burst 20 | `HttpApi.DefaultRouteSettings` | A leaked URL or runaway script generating costs |
| 3 | Demo-token authorizer with 5-minute caching | `HttpApi.Auth` | Strangers using the API; also keeps authorizer calls rare |
| 4 | Worker `MaximumConcurrency: 3`, timeout 15 s | `WorkerQueueMapping`, `WorkerFunction` | Runaway parallel processing |
| 5 | 5 MB upload limit enforced **by S3** | Presigned POST policy | Large files driving storage or compute costs |
| 6 | Log retention 7 days (all 4 log groups) | `*LogGroup` resources | Logs piling up forever |
| 7 | S3 lifecycle: inputs/outputs 3 days, backups 30 days, incomplete uploads 1 day | `DataBucket.LifecycleConfiguration` | Storage growth |
| 8 | DynamoDB TTL (7 days for jobs) | `JobsTable.TimeToLiveSpecification` | Table growth |
| 9 | SQS retention 1 day (main) / 4 days (DLQ) | Queue properties | Forgotten messages |
| 10 | Only 7 custom metrics with one fixed dimension | `backend/src/lib/metrics.ts` | Metric costs (each metric is $0.30/month outside the free tier) |
| 11 | Dashboard polling pauses when the tab is hidden | `frontend/src/hooks/usePolling.ts` | Background API traffic from forgotten tabs |
| 12 | `burst.mjs` refuses more than 200 jobs per run | `scripts/burst.mjs` | Accidental load tests |
| 13 | Tags `Project=QueuePilot`, `Env=dev` on the stack | `samconfig.toml` | Lets you filter Cost Explorer by project |
| 14 | One-command teardown that verifies nothing is left | `scripts/teardown.ps1` | Paying for resources after the project ends |

## Things that *could* cost money, and how to avoid them

- **Leaving a browser tab open on the dashboard for days.** Polling is about 1 request per second while the tab is visible. That is roughly $0.09 per day of API Gateway, so close the tab or sign out.
- **Turning on X-Ray, a VPC, or a NAT gateway.** Don't. None are needed.
- **The SAM managed bucket** (`aws-sam-cli-managed-default-…`) keeps uploaded code zips: a few MB, under one cent per month. `teardown.ps1` explains how to remove it.
- **Forgetting to tear down.** It would still cost very little, but run `scripts/teardown.ps1` after grading.

## How to check real spend

1. AWS Console → **Billing and Cost Management → Bills** for month-to-date charges.
2. **Cost Explorer**: filter by tag `Project = QueuePilot` (activate the tag under *Cost allocation tags* first; it takes up to 24 h to appear).
3. **Budgets**: `queuepilot-monthly-cost` shows actual versus forecast.
