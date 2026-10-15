# Security

## Credentials: what never happens

- No AWS access keys, secrets or root credentials are in this repository, in the code, in the frontend build, or in any script output.
- Lambda functions get temporary credentials from their **IAM execution roles**; the AWS SDK picks them up automatically.
- You deploy from your own terminal with your own identity. **Recommended:** AWS IAM Identity Center (SSO) with `aws configure sso`. `scripts/preflight.ps1` prints only the caller ARN and **refuses to run as the root user**.
- `samconfig.toml` contains only the stack name, region and tags.

## The demo token

| Aspect | How it is handled |
|---|---|
| Created | You type it, or `deploy-backend.ps1 -GenerateToken` creates 32 random characters with a cryptographic RNG |
| Entered | `Read-Host -AsSecureString`, so it is not echoed and not in shell history |
| Stored in AWS | CloudFormation `NoEcho` parameter → `DEMO_TOKEN` environment variable of the authorizer Lambda only |
| Stored locally | **Nowhere.** `e2e.config.json` holds only the API URL; the e2e script reads the token from a hidden prompt into an environment variable and removes it afterwards |
| In the browser | Typed on the sign-in screen and kept in `sessionStorage` (cleared when the tab closes); never in the JavaScript bundle |
| Checked | Constant-time comparison of SHA-256 digests; fails closed if the server token is missing or shorter than 12 characters |

**Accepted trade-off.** Anyone with Lambda console access to your account can read the environment variable, and a shared token is not per-user authentication. For a production system, replace it with Amazon Cognito user pools (a JWT authorizer) or AWS Secrets Manager plus per-user identity. For a class demo, a shared token behind HTTPS with throttling is proportionate.

## Least-privilege IAM (from `backend/template.yaml`)

| Role | Allowed actions | On |
|---|---|---|
| API | DynamoDB Get/Put/Update/Delete/Query/BatchGet/BatchWrite/ConditionCheck | Jobs table + its indexes |
| | SQS SendMessage, GetQueueAttributes | Jobs queue |
| | SQS GetQueueAttributes, ReceiveMessage, DeleteMessage, StartMessageMoveTask, ListMessageMoveTasks | DLQ only (redrive requires Receive/Delete on the source) |
| | S3 PutObject, GetObject | `inputs/*`, `backups/*` |
| | S3 GetObject | `outputs/*` |
| | S3 ListBucket | Data bucket (so a missing file returns 404 instead of 403) |
| Worker | DynamoDB GetItem/PutItem/UpdateItem | Jobs table only |
| | S3 GetObject / PutObject | `inputs/*` / `outputs/*` |
| | SQS ReceiveMessage, DeleteMessage, ChangeMessageVisibility, GetQueueAttributes | Jobs queue only |
| Authorizer | none (CloudWatch Logs only) | — |

All roles also get `AWSLambdaBasicExecutionRole` (write their own logs).

## Data protection

- **S3 data bucket:**
  - Block Public Access fully on;
  - SSE-S3 encryption;
  - a bucket policy **denies any non-HTTPS request**;
  - ownership enforced (ACLs disabled);
  - CORS limited to the dashboard origins.
- **Uploads.** The presigned POST fixes the exact object key, the content type, a **1 byte – 5 MB** size range and a 5-minute expiry. The API re-checks the size with `HeadObject` before accepting a job.
- **Downloads.** Presigned GET links expire after 15 minutes.
- **Encryption at rest.**
  - **SQS:** SSE (SQS-managed keys).
  - **DynamoDB:** AWS-owned key.
- **Integrity.**
  - Results and backups are written with a SHA-256 checksum that S3 verifies.
  - Restore refuses a backup whose SHA-256 no longer matches the recorded value.

## Input handling

- Every request body and parameter is validated with **zod** schemas shared by the frontend and backend. Unknown fields are rejected.
- File names are restricted to simple characters plus `.csv/.txt/.md/.json`, so path traversal like `../../x.csv` is rejected.
- The worker rejects binary files and invalid UTF-8 as non-retryable errors.
- `cleaned.csv` neutralises spreadsheet formula injection: a value starting with `=`, `+`, `@`, or a non-numeric `-` is prefixed with `'`.
- Request bodies over 64 KB are rejected.
- Pagination cursors are validated, so a forged cursor gets HTTP 400.
- **Error responses** never include stack traces or internal messages, only a code, a safe message and a `requestId` for CloudWatch Logs.

## Abuse and cost protection

API throttling, the worker concurrency cap, log retention and lifecycle rules: see [COST_CONTROL.md](COST_CONTROL.md).

## Public website bucket

When `EnableWebsite=true`, the **website** bucket (React files only, no data) is publicly readable, which is required for S3 static website hosting. S3 website endpoints are **HTTP only**. The dashboard still calls the API over HTTPS. Do not type sensitive data into the dashboard on untrusted networks. Adding Amazon CloudFront in front of a private bucket gives HTTPS and is the recommended next step beyond the MVP.

## Security checklist before the demo

- [ ] Deployed with an SSO/IAM user, not root (preflight passed)
- [ ] Budget alert stack deployed and confirmation email accepted
- [ ] Demo token is 16+ random characters and not reused anywhere else
- [ ] `git status` shows no `.env*`, `e2e.config.json` or token files committed (they are git-ignored)
- [ ] After grading: `scripts/teardown.ps1`
