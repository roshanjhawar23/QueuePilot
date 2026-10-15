# Testing

## Summary of the last local run

Run on 10 October 2026 in a Linux build environment with Node.js 22.22, from a clean `npm install`:

| Check | Command | Result |
|---|---|---|
| TypeScript (shared, backend, frontend) | `npm run typecheck` | ✅ no errors |
| ESLint | `npm run lint` | ✅ no errors or warnings |
| Shared schema tests | `npm test -w shared` | ✅ 5 / 5 passed |
| Backend unit tests | `npm test -w backend` | ✅ 93 / 93 passed (7 files) |
| Frontend tests | `npm test -w frontend` | ✅ 22 / 22 passed (2 files) |
| Backend coverage | `npm run test:coverage -w backend` | 83 % statements, 87 % lines, 74 % branches (processors 94 % statements) |
| Lambda bundles | `npm run build -w backend` | ✅ api, worker and authorizer built and loaded in Node |
| Frontend production build | `npm run build -w frontend` | ✅ |
| SAM template | `sam validate --lint` | ✅ valid |
| CloudFormation lint incl. informational rules | `cfn-lint --include-checks I` | ✅ no findings (main template and budget template) |
| **End-to-end against AWS** | `scripts/run-e2e.ps1` | ⏳ **Not run yet.** There is no deployed stack. Written, type-checked, and correctly skipped without credentials. |
| PowerShell scripts | — | ⚠️ **Not executed.** PowerShell was not available in the build environment. Review them on first use. |

All of these except the last two run with **`npm run check`** (no AWS account needed).

## What each test suite proves

### Processors (`backend/tests/unit/processors.test.ts`, 21 tests)
These run on the **real files in `sample-data/`**:
- **Exact CSV statistics.** `sales.csv` results match values computed independently with Python's `statistics` module: units min 1, max 39, mean 18.7667, median 18, standard deviation 11.2074, sum 1126.
- **Malformed rows.** They are detected with their line numbers (16, 34, 49).
- **Corrected-parameter path.** `malformed.csv` fails non-retryably at 30 % > 20 %, then succeeds with `maxMalformedPercent: 50`.
- **Delimiter detection.** A wrong delimiter produces a helpful "retry with delimiter ;" error.
- **Text analytics.** Word, sentence and paragraph counts on `article.txt` match a hand count; Markdown code blocks and link URLs are excluded.
- **Validation.** Violations in `customers.csv` and `orders.json` are reported exactly, including calendar-invalid dates such as 2026-02-30 and JSON strings where numbers are required.
- **CSV parser edge cases.** Quotes, escaped quotes, embedded newlines, CRLF, BOM, binary or invalid UTF-8 rejection, and formula-injection escaping.

### Worker state machine (`worker.test.ts`, 14 tests)
These use in-memory stand-ins for DynamoDB, S3 and SQS that enforce the same conditional-update rules. They cover:
- the success path, with outputs written;
- **transient**: 5 s and 20 s backoff, then success on attempt 3;
- **permanent**: `DEAD_LETTERED` on attempt 3 and visibility reset to 0 so SQS moves it to the DLQ;
- non-retryable data error leading to `FAILED` with no backoff;
- the **slow task**: a simulated Lambda kill, then redelivery after the lease expires takes over and succeeds;
- **duplicates**: deferred while a lease is active, discarded after finish;
- **stale `dispatchId`** discarded;
- **redrive** starting a fresh attempt cycle;
- the **partial batch response** (only failed message IDs are returned);
- unstarted messages released when the invocation is nearly out of time.

### API (`api.test.ts`, 22 tests)
- routing and safe error bodies (no internal details leak);
- upload validation: 5 MB, extension, path traversal;
- **idempotent submission**: same key returns the same job and no second SQS message; same key with a different body returns 409;
- parameter validation and SQS outage handling (job marked `FAILED`, retryable);
- retry rules, including corrected-parameter merge, stuck-job retry and expired-input refusal;
- **backup → delete → restore**, the **tampered backup** refusal (SHA-256), and that active jobs are never deleted or overwritten.

### AWS request shapes (`jobsRepo.test.ts`, `awsAdapters.test.ts`)
These use `aws-sdk-client-mock` to check the **exact requests** sent to AWS:
- the DynamoDB transaction conditions, the optimistic-concurrency condition expressions, GSI selection and cursor handling;
- SQS `ChangeMessageVisibility`, a DLQ peek with `VisibilityTimeout 0`, and `StartMessageMoveTask` source/destination ARNs;
- the S3 presigned POST policy (5 MB `content-length-range`, exact key, content type) and the SHA-256 upload checksum.

These run with **dummy** credentials and contact no AWS endpoint.

### Configuration guards (`template.test.ts`)
These fail if the template drifts from the code:
- `maxReceiveCount` equals `MAX_ATTEMPTS`;
- the visibility timeout is at least 6 × the worker timeout;
- every log group has a retention period;
- the concurrency cap, throttling and the `NoEcho` token are present.

### Frontend (`frontend/tests`, 22 tests)
- **API client:** bearer token, idempotency header, error mapping, S3 multipart upload with the file last and **no token sent to S3**, and the S3 `EntityTooLarge` message.
- **Components:** the pipeline highlights a non-empty DLQ and shows placeholders (not invented numbers) before data arrives.
- **Forms and pages:**
  - the submit form blocks files over 5 MB before calling the API;
  - the submit form sends the fault-injection choice;
  - the job page sends corrected retry settings;
  - the Recovery page enables redrive only when the DLQ is non-empty.
- **Sign-in** verifies the token with a real API call.
- **Polling** pauses while the tab is hidden.

### What is *not* proven by local tests
Unit tests use stand-ins for AWS, so they cannot prove these, which need the deployed stack:
- IAM permissions are sufficient;
- CORS works from the real website origin;
- SQS really redrives;
- Lambda really times out at 15 s;
- alarms fire.

That is the job of the end-to-end suite.

## End-to-end suite (real AWS) — `backend/tests/e2e/live.test.ts`

Runs only when `QP_API_URL` and `QP_TOKEN` are set (`scripts/run-e2e.ps1` does this). Ten tests:

1. `/health` is public; other routes return 401/403 without or with a wrong token.
2. S3 rejects a 5 MB + 100 byte upload with `EntityTooLarge`.
3. The same `Idempotency-Key` returns the same job.
4. `csv.summary` succeeds, and `result.json` downloaded from S3 shows 60 valid / 3 malformed rows.
5. `text.analytics` and `data.validate` succeed (8 violations found).
6. **Transient** fault: 2 `RETRY_SCHEDULED` events, then success (3 total attempts).
7. **Non-retryable**: `malformed.csv` reaches `FAILED` after 1 attempt, then a corrected-parameter retry succeeds.
8. **Permanent** fault: two jobs reach `DEAD_LETTERED`, and the DLQ depth reaches 2 in real SQS. Then:
   - one job is retried with the fault off and succeeds;
   - a **native redrive** moves both messages; the retried job's copy is discarded as **stale**, and the other shows `REDRIVEN`. This also verifies that redriven messages are processed normally.
9. **Slow** fault: a real Lambda timeout, then success, with an "Attempt 1 did not finish" event.
10. **Backup → delete → restore** of a job record.

Expected runtime is 4–6 minutes; expected cost is a fraction of a cent. **Record the actual result in this file after the first deployment.**

## How to run

```powershell
npm run check                                  # everything local
npm run test:coverage -w backend               # coverage report
npm run validate:template                      # SAM + cfn-lint
.\scripts\run-e2e.ps1 -Profile queuepilot      # after deployment only
```
