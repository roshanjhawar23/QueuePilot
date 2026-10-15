# Every AWS service in QueuePilot, explained

For each service, this page gives what it is in plain words, why QueuePilot needs it, exactly how it is configured, what it costs, where to see it in the AWS Console during a demo, and a one-sentence explanation for your teacher.

> Prices are approximate us-east-1 list prices as of 2026 and may change; check the linked pricing pages before relying on them. At demo scale (a few thousand jobs) every service here costs **cents**, and most usage falls inside the AWS Free Tier.

---

## 1. AWS Lambda — runs our code without servers

**What it is.** You upload a function and AWS runs it when an event happens. You pay only for the milliseconds it runs; nothing runs (or costs) while idle.

**How QueuePilot uses it.** There are three functions (source in `backend/src/handlers/`):

| Function | Triggered by | Memory / timeout | Job |
|---|---|---|---|
| `queuepilot-dev-api` | API Gateway (HTTP request) | 256 MB / 10 s | All API routes: uploads, jobs, retries, DLQ, backups |
| `queuepilot-dev-worker` | SQS (event source mapping) | 512 MB / 15 s | Processes jobs: CSV statistics, text analytics, validation |
| `queuepilot-dev-authorizer` | API Gateway, before every protected route | 128 MB / 3 s | Checks the demo token |

**Configuration choices.**
- **Runtime and architecture.** Node.js 22 on **arm64** (AWS Graviton), which is about 20 % cheaper than x86.
- **Packaging.** Code is bundled with esbuild into a single file per function.
- **Partial batch responses.** The worker uses `ReportBatchItemFailures`, so if 1 of 5 messages fails only that one is retried.
- **Concurrency cap.** The worker's trigger has `MaximumConcurrency: 3`: at most 3 copies run at once, which caps cost.

**Cost.** $0.20 per million requests plus about $0.0000133 per GB-second (arm64). The Free Tier includes 1 million requests and 400,000 GB-seconds per month. A 1-second, 512 MB worker run costs about $0.0000067.

**In the console.** Lambda → Functions → `queuepilot-dev-worker` → *Monitor* tab (invocations, errors, duration) → *View CloudWatch logs*.

**Tell your teacher:** "Lambda runs our API and our background worker only when there is work, so the system costs nothing when nobody uses it."

---

## 2. Amazon API Gateway (HTTP API) — the front door

**What it is.** It gives the backend a public HTTPS URL and routes each request (e.g. `POST /jobs`) to a Lambda function.

**Configuration** (`HttpApi` in the template):
- **14 routes**, all handled by the `api` Lambda.
- **Lambda authorizer.** Every route except `/health` requires `Authorization: Bearer <token>`. Decisions are cached for 5 minutes, so the authorizer rarely runs.
- **CORS.** Only the S3 website and `localhost` dev servers may call the API from a browser.
- **Throttling.** 10 requests per second, with bursts up to 20. Extra requests get HTTP 429. This is a cost guardrail if the URL leaks.
- **Access logs.** Written to CloudWatch Logs (7-day retention).

**Why HTTP API, not REST API.** It is about $1.00 per million requests versus $3.50, and simpler. QueuePilot needs nothing REST APIs add.

**In the console.** API Gateway → APIs → *QueuePilot public API* → Routes / Authorization / Throttling.

**Tell your teacher:** "API Gateway is the secured, rate-limited HTTPS entrance; it checks the token and forwards requests to Lambda."

---

## 3. Amazon SQS — the queue and the dead-letter queue

**What it is.** A managed message queue. Producers put messages in, consumers take them out. A message that is being processed becomes *invisible* for a while (the **visibility timeout**). If the consumer doesn't delete it in time, it reappears and is retried.

**Two queues:**

| Queue | Settings | Purpose |
|---|---|---|
| Jobs queue | Visibility timeout 90 s (6 × the worker timeout, as AWS recommends), retention 1 day, long polling 20 s, **redrive policy `maxReceiveCount: 3` → DLQ**, SSE encryption | Holds jobs waiting for a worker |
| Dead-letter queue (DLQ) | Retention 4 days, SSE encryption | Holds messages that failed 3 times, so they are not lost and not retried forever |

**Retry mechanics** (the core of the project):
1. A failed attempt calls `ChangeMessageVisibility` to hide the message for 5 s, then 20 s. This is *exponential backoff*.
2. On the 3rd failure SQS's redrive policy moves the message to the DLQ.
3. **Redrive.** `StartMessageMoveTask` (SQS's native DLQ redrive API) moves messages back to the jobs queue after you fix the cause.

**At-least-once delivery.** SQS may occasionally deliver a message twice. QueuePilot handles this with `dispatchId` fencing, leases and conditional DynamoDB writes (see [ARCHITECTURE.md](ARCHITECTURE.md)).

**Cost.** $0.40 per million requests after the first 1 million each month (free). Messages are tiny.

**In the console.** SQS → Queues → the jobs queue / DLQ → *Monitoring* tab. On the DLQ, *Send and receive messages → Poll for messages* shows the dead-lettered message, and *Start DLQ redrive* is the same API the app calls.

**Tell your teacher:** "SQS decouples the API from the worker; failed messages are retried with backoff, and after three failures they move to a dead-letter queue where we can inspect and redrive them."

---

## 4. Amazon DynamoDB — the job database

**What it is.** A serverless NoSQL database. You pay per read and write, with no server to manage.

**Configuration** (`JobsTable`):
- **On-demand capacity.** No capacity planning and no idle cost.
- **Single-table design.** Jobs, timeline events, idempotency keys and backup metadata share one table.
- **Two global secondary indexes.**
  - GSI1 lists the newest jobs and backups.
  - GSI2 filters and counts by status.
- **TTL** on `expiresAt` deletes old items automatically for free: jobs after 7 days, idempotency keys after 24 h, backup records after 30 days.
- **Encryption at rest** with an AWS-owned key (free).
- **Concurrency safety.** **Conditional writes** (e.g. "update only if status is still QUEUED and dispatchId matches") let two workers never process the same job. **Transactions** make "create job + event + idempotency key" all-or-nothing.

**Cost.** On-demand writes are about $0.625 per million write units and reads about $0.125 per million. Storage is $0.25 per GB-month, and the always-free tier covers 25 GB.

**In the console.** DynamoDB → Tables → `…JobsTable…` → *Explore table items*. Filter `PK` begins with `JOB#` to see job records and their `EVT#` history items.

**Tell your teacher:** "DynamoDB stores each job's state and full attempt history; conditional writes guarantee a job is processed by only one worker even when SQS delivers a message twice."

---

## 5. Amazon S3 — files, results, backups and the website

**What it is.** Object storage: you put and get files ("objects") by key.

**Two buckets:**

| Bucket | Contents | Settings |
|---|---|---|
| Data bucket | `inputs/` (uploads), `outputs/` (results), `backups/` (snapshots) | **Private**: Block Public Access on; SSE-S3 encryption; HTTPS-only bucket policy; lifecycle rules (inputs/outputs expire after 3 days, backups after 30, incomplete uploads aborted after 1); CORS for browser uploads |
| Website bucket | The built React dashboard | Static website hosting; public **read** only when `EnableWebsite=true` |

**Security details.**
- **Presigned POST.** The browser uploads directly to S3 with a 5-minute policy that fixes the exact key, the content type and the **5 MB maximum**. S3 rejects violations itself.
- **Integrity checks.** Results and backups are written with a SHA-256 checksum that S3 verifies on upload.
- **Downloads.** Download links are presigned GETs valid for 15 minutes.

**Cost.** About $0.023 per GB-month plus fractions of a cent per thousand requests. Demo data is a few MB that expire within days.

**In the console.** S3 → Buckets → the data bucket → browse `inputs/`, `outputs/<jobId>/`, `backups/`. The *Management* tab shows the lifecycle rules.

**Tell your teacher:** "Files go straight from the browser to a private S3 bucket using short-lived signed permissions; results and backup snapshots are stored there too and expire automatically."

---

## 6. Amazon CloudWatch — logs, metrics, dashboard and alarms

**What it is.** AWS's monitoring service.

**Logs.**
- Each Lambda writes **structured JSON logs** (every line has `level`, `msg`, `jobId`, `attempt`, …) to its own log group, with **7-day retention** (the default is forever, which slowly costs money).
- API Gateway access logs go to a fourth log group.
- Example *Logs Insights* query for one job:
  ```
  fields @timestamp, level, msg, attempt, error | filter jobId = "<id>" | sort @timestamp
  ```

**Custom metrics.**
- The worker emits `JobsSubmitted`, `JobsSucceeded`, `JobsFailed`, `JobsDeadLettered`, `JobRetriesScheduled`, `StaleMessagesDiscarded` and `JobDurationMs`.
- It uses the **Embedded Metric Format**: a specially shaped log line becomes a metric, so no extra API calls or permissions are needed.

**Dashboard** (`queuepilot-dev`) shows:
- the alarm status;
- queue depth (main queue and DLQ);
- job outcomes;
- worker invocations, errors and concurrency;
- durations;
- API requests and 4xx/5xx counts;
- a live table of recent worker warnings and errors.

**Alarms:**

| Alarm | Fires when | Meaning |
|---|---|---|
| `…-dlq-not-empty` | DLQ has ≥ 1 message | A job ran out of attempts and needs attention |
| `…-worker-errors` | Worker Lambda errors ≥ 1 in a minute | The worker crashed or **timed out** (the slow-task demo triggers this) |
| `…-queue-backlog-age` | Oldest message older than 5 minutes for 3 minutes | Workers can't keep up or keep failing |
| `…-api-5xx` | ≥ 5 server errors in 5 minutes | The API is failing |

Optional: deploy with `-AlarmEmail` to get emails via an Amazon SNS topic. You must confirm the subscription email.

**Cost.** Log ingestion is about $0.50 per GB, and the demo produces a few MB. The Free Tier includes 10 custom metrics (QueuePilot uses 7), 10 alarms (we use 4) and 3 dashboards (we use 1).

**In the console.** CloudWatch → Dashboards → `queuepilot-dev`; CloudWatch → Alarms; CloudWatch → Logs Insights.

**Tell your teacher:** "CloudWatch gives us structured logs per job, custom metrics, one dashboard and four alarms; the DLQ alarm turns red the moment a job is dead-lettered."

---

## 7. AWS IAM — who may do what

**What it is.** Identity and Access Management: roles and policies that grant permissions.

**In QueuePilot:**
- **Each Lambda has its own execution role.** SAM creates them, and the code uses that role, so there are **no access keys in code**.
- **Least privilege.** Each role lists exact actions on exact resources:
  - the worker can read only `inputs/*`, write only `outputs/*`, and receive, delete and change visibility only on the jobs queue;
  - the authorizer has no AWS permissions at all (logs only);
  - the template avoids SAM's convenience policies that grant access to *all* queues or include unneeded actions (e.g. DynamoDB `Scan`).
- **`s3:ListBucket` on the data bucket** is granted on purpose: without it S3 answers "403 Access Denied" instead of "404 Not Found" for a missing file, and the app could not tell "expired" from "forbidden".
- **Deployment.** You deploy with your own IAM Identity Center (SSO) user, never the root user. `preflight.ps1` refuses to continue as root.

**Tell your teacher:** "Each function has its own role with only the permissions it needs, and nobody uses long-lived keys or the root account."

---

## 8. AWS SAM and AWS CloudFormation — infrastructure as code

**What they are.**
- **CloudFormation** creates and deletes a whole set of AWS resources (a *stack*) from a template file.
- **SAM** (Serverless Application Model) is a shorter syntax for serverless resources that turns into CloudFormation.

**In QueuePilot:**
- `backend/template.yaml` describes **everything** listed on this page.
- `sam deploy` uploads the Lambda code, shows a **change set** (the list of what will be created or changed) and asks for confirmation.
- `sam delete` (via `scripts/teardown.ps1`) removes it all.
- **Parameters:**
  - `DemoToken` is `NoEcho`, so CloudFormation never displays it;
  - `EnableWebsite` controls whether the website bucket is public;
  - `AlarmEmail` is optional.
- **Validation:** `sam validate --lint` (which runs cfn-lint) checks the template before every deployment.

**In the console.** CloudFormation → Stacks → `queuepilot-dev` → *Resources* (every created resource), *Outputs* (API URL, website URL, dashboard link), *Events* (deployment history).

**Tell your teacher:** "The whole system is one version-controlled template; we can create an identical environment or delete everything with one command."

---

## 9. Optional or supporting services

| Service | Used for | Cost |
|---|---|---|
| **AWS Budgets** (`infra/budget.yaml`) | Email alerts at about $5, $20, $50 and $100 of monthly spend, plus a forecast alert | First 2 budgets free |
| **Amazon SNS** (only if `AlarmEmail` is set) | Emails CloudWatch alarm notifications | Free at this volume |
| **AWS STS** | `preflight.ps1` runs `get-caller-identity` to show which account you are using | Free |

**Not used, on purpose.** Each of these would cost money even when idle, or isn't needed:
- **VPC/NAT Gateway:** about $32 per month.
- **EC2 / RDS:** always-on servers.
- **KMS customer keys:** $1 per month each.
- **X-Ray:** not needed; CloudWatch covers it.
- **CloudFront:** optional, not required for the demo.
