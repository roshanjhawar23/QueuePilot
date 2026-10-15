# Teacher demonstration script (about 12 minutes)

## Before the demo (30 minutes earlier)

- [ ] `aws sso login --profile queuepilot` (sessions expire)
- [ ] Open these tabs:
  1. the QueuePilot dashboard, signed in;
  2. CloudWatch dashboard `queuepilot-dev`;
  3. SQS → Queues;
  4. DynamoDB → the Jobs table → Explore items;
  5. S3 → the data bucket;
  6. CloudFormation → `queuepilot-dev` → Resources.
- [ ] Have `sample-data/` open in File Explorer.
- [ ] Run one `sales.csv` job to warm up the Lambdas (avoids a cold start on stage).
- [ ] The DLQ is empty (Recovery page shows 0; redrive or retry any leftovers).
- [ ] **Fallback:** a screen recording of the full rehearsal, in case the network fails.

## 1. What it is (1 min)

> "QueuePilot is a cloud-native asynchronous file-processing platform. Users upload a file, the API answers immediately, and a background worker processes it. The interesting part is what happens when things go wrong: retries with backoff, a dead-letter queue, and recovery."

Show the **architecture diagram** in [ARCHITECTURE.md](ARCHITECTURE.md) and walk the route: Browser → API Gateway → Lambda → SQS → worker Lambda → S3/DynamoDB, with the DLQ below the queue.

## 2. A normal job (2 min)

1. **Submit** → drop `sample-data/sales.csv` → *CSV summary* → **Upload and submit**.
2. Open the job: `QUEUED → PROCESSING → SUCCEEDED` within a few seconds.
3. Point at **Attempt history** and **Result summary**: 63 rows, 60 valid, 3 malformed rows flagged with line numbers.
4. **Download result.json**, a real file from S3 computed by the worker.
5. Prove it is real AWS:
   - **S3:** `outputs/<jobId>/result.json` and `cleaned.csv`.
   - **DynamoDB:** the `JOB#<jobId>` record and its `EVT#…` history items.
   - **CloudWatch Logs Insights:** `filter jobId = "<id>"`.

> "The browser uploaded straight to S3 with a 5-minute signed permission, so the file never went through our servers. The 5 MB limit is enforced by S3 itself."

## 3. Retry with backoff (2 min)

1. Submit `sales.csv` with **Fault injection → Transient fault**.
2. The timeline shows:
   - attempt 1 failed → *Retrying in 5 s*;
   - attempt 2 failed → *Retrying in 20 s*;
   - attempt 3 succeeded.

> "Temporary failures shouldn't need a human. Each failure hides the SQS message for longer (exponential backoff) so a struggling dependency isn't hammered."

## 4. Dead-letter queue (2–3 min)

1. Submit `article.txt` with **Permanent fault**.
2. While it retries, upload `malformed.csv` with no fault. It becomes **FAILED** immediately: "6 of 20 rows (30 %) malformed, exceeds 20 %".

   > "This one is a data problem. Retrying the same bad file can never work, so we don't waste retries and it never goes to the DLQ."

3. After about 30 s the permanent job is **Dead-lettered**. Then show:
   - **Recovery page:** the DLQ count is 1 and the red panel is visible;
   - **SQS console:** the DLQ shows 1 message available, and *Poll for messages* shows `{jobId, dispatchId}`;
   - **CloudWatch dashboard:** the `dlq-not-empty` alarm is red.

## 5. Recovery (2 min)

1. **Corrected-parameter retry:** open the malformed job → **Edit and retry** → *Allowed malformed rows* = 50 → it **succeeds**, processing the 14 valid rows.
2. **Single retry:** open the dead-lettered job → **Edit and retry** → fault injection *No fault* → it succeeds.
3. **Bulk redrive:** submit another permanent job and wait until it is dead-lettered. **Recovery → Inspect messages** shows the earlier job's DLQ copy as **stale**. Then **Redrive all messages**:
   - the stale copy is ignored (its history shows *Stale message ignored*);
   - the other job shows *Redriven from DLQ* and starts a fresh attempt cycle.

> "Each retry gets a new dispatch ID, so old copies of the message can never process a job twice. That matters because SQS guarantees at-least-once delivery, not exactly-once."

## 6. Timeout (optional, 2 min)

Submit with **Slow task (timeout)**. Attempt 1 sleeps past the 15-second Lambda limit: a real timeout. The `worker-errors` alarm fires. After the 90-second visibility timeout, SQS redelivers. The worker sees the expired lease, records "Attempt 1 did not finish", and attempt 2 succeeds.

## 7. Scale and observability (1 min)

`node scripts/burst.mjs 50`, or *Copies to submit = 20* on the Submit page. The CloudWatch dashboard shows the queue depth rising and draining while **concurrency never exceeds 3**, which is our cost cap.

## 8. Backup and restore (1 min)

**Jobs** → select 2 jobs → **Back up selected** → open one → **Delete job record** → **Backups** → **Restore** (only missing). The job is back, with `Restored from backup` at the end of its history. Mention the SHA-256 integrity check.

## 9. Infrastructure, security and cost (1 min)

- **CloudFormation → Resources:** everything comes from one template, and teardown is one command.
- **IAM:** each function has its own least-privilege role; we deployed with SSO, never root; there are no keys in code.
- **Cost:** a budget alert, API throttling, the concurrency cap, 7-day logs and S3 lifecycle rules. Show real month-to-date spend in Billing.

## Likely questions and answers

| Question | Answer |
|---|---|
| Why a queue instead of processing in the API? | The API stays fast and available; slow or failing work is isolated, retried and scaled separately. |
| What if SQS delivers a message twice? | The worker checks the job's dispatchId and status, and claims it with a conditional DynamoDB write; duplicates are discarded or deferred. |
| What's the difference between FAILED and DEAD_LETTERED? | FAILED means the input is bad (retrying won't help). DEAD_LETTERED means a retryable error persisted through all attempts. |
| Is the fault injection fake? | The trigger is deliberate, but everything after it is real: real Lambda exceptions and timeouts, real SQS redelivery, a real DLQ and a real alarm. |
| Why 90 s visibility timeout? | AWS recommends at least 6× the function timeout (15 s), so a slow run is never redelivered while still running. |
| How does it scale? | Lambda scales with the queue; we cap it at 3 concurrent workers for cost. Raising `MaximumConcurrency` raises throughput. |
| How much did it cost? | Show Billing. Expected: a few dollars or less. |
| What would you improve? | Cognito user login, CloudFront + HTTPS for the site, a CI/CD pipeline, sharded indexes for very high volume. |
