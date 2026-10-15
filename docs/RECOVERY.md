# Recovery runbook

What to do when something goes wrong, from the dashboard or the AWS Console.

## Which failure is which?

| You see | Meaning | Is the message in the DLQ? | What to do |
|---|---|---|---|
| `RETRY_SCHEDULED` | A retryable error; SQS will try again after 5 s, then 20 s | No | Nothing. Watch it; it may recover on its own |
| `FAILED` | The input or parameters are wrong (e.g. too many malformed rows, invalid JSON, wrong delimiter) | **No.** Retrying unchanged cannot work, so the message was deleted | Read the error, then **Edit and retry** with corrected parameters, or upload a fixed file as a new job |
| `DEAD_LETTERED` | A retryable error happened on all 3 attempts | **Yes** | Fix the cause, then **Retry** (one job) or **Redrive all** (every DLQ message) |
| `PROCESSING` + "lease expired" | The worker stopped mid-job (Lambda timeout or crash) and the message hasn't come back | Possibly | **Retry** is enabled for exactly this case |

## Scenario 1: A job is dead-lettered

1. **Recovery** page: the DLQ count is above zero, and the CloudWatch alarm `queuepilot-dev-dlq-not-empty` is in ALARM.
2. Open the job and read **Attempt history** and **Last error**.
   - For the demo's permanent fault, the error says `Injected permanent fault…`.
   - In real life, check the worker logs (CloudWatch → Logs Insights):
     ```
     fields @timestamp, level, msg, error | filter jobId = "<jobId>" | sort @timestamp
     ```
3. Fix the cause. For the demo: **Edit and retry**, then set fault injection to *No fault*.
4. Choose a recovery path:
   - **Retry** re-queues just this job with a **new dispatchId**. Its old copy in the DLQ becomes *stale*: **Inspect messages** marks it "Ignored", and if redriven later the worker discards it and records `Stale message ignored` in the history.
   - **Redrive all messages** calls SQS `StartMessageMoveTask`. Every DLQ message moves back to the main queue, and each job gets a fresh cycle of 3 attempts (history shows `Redriven from DLQ`). Progress appears under **Redrive tasks**.
5. The DLQ alarm returns to OK within a minute or two after the DLQ is empty.

## Scenario 2: Many jobs failing at once

1. CloudWatch dashboard `queuepilot-dev`: look at **Job outcomes**, **Worker Lambda errors** and **Recent worker warnings and errors**.
2. If the worker itself is erroring (alarm `worker-errors`), look for timeouts (`Task timed out`) or permissions errors (`AccessDenied`) in the worker log group.
3. Fix the issue, redeploy (`deploy-backend.ps1`), then **Redrive all**.

## Scenario 3: The queue is backing up

The alarm `queue-backlog-age` means the oldest message waited more than 5 minutes. The worker is capped at 3 concurrent copies on purpose. For a burst of a few hundred jobs, wait; it drains within minutes. If it does not drain, check for worker errors (Scenario 2).

## Scenario 4: A job record was deleted or damaged

Backups are snapshots of selected job records (with full history) stored as JSON in S3, with a SHA-256 fingerprint.

1. **Before** risky changes: **Jobs** → select jobs → **Back up selected**.
2. To recover: **Backups** → choose *Only bring back jobs that no longer exist* (safe) or *Replace finished jobs* → **Restore**.
3. Rules:
   - Active jobs are **never** overwritten.
   - A job that was mid-processing when backed up is restored as `FAILED` (retryable), so it can't get stuck.
   - Restore refuses a snapshot whose SHA-256 doesn't match (`INTEGRITY_CHECK_FAILED`).
   - Backups restore **records**. Input and result files expire from S3 after 3 days; Retry tells you if the input file is gone.

## Scenario 5: Manual redrive from the AWS Console

SQS → the DLQ → **Start DLQ redrive** → *Redrive to source queue*. This does the same thing as the app's button.

## Alarm reference

| Alarm | Threshold | First check |
|---|---|---|
| `…-dlq-not-empty` | DLQ visible messages ≥ 1 | Recovery page → dead-lettered jobs |
| `…-worker-errors` | Worker Lambda errors ≥ 1 per minute | Worker log group: timeouts, crashes |
| `…-queue-backlog-age` | Oldest message ≥ 300 s for 3 minutes | Worker errors? Burst in progress? |
| `…-api-5xx` | ≥ 5 HTTP 5xx in 5 minutes | API log group, search `"level":"error"` |
