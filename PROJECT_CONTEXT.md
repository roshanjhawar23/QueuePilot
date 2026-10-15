# PROJECT_CONTEXT — QueuePilot

A handover file: read this first when resuming work, whether by a person or an AI assistant.

## Goal and constraints

- **Product:** QueuePilot, an asynchronous file-processing platform with visible failure handling and recovery (retries, DLQ, redrive, backups).
- **Audience:** a live demonstration to a teacher. Docs must let a beginner explain every AWS service.
- **Deadline:** about 1.5 days for the MVP. **Budget:** $130 of AWS spend (expected actual: $1–5).
- **Hard rules:**
  - real computation on real files, and no fabricated dashboard data;
  - fault injection must be clearly labelled;
  - never request, read or store AWS credentials;
  - **never deploy without the owner running the command**;
  - never claim live AWS tests passed unless they were run against a deployed stack.

## Current status (10 Oct 2026)

| Area | State |
|---|---|
| Shared schemas (`shared/`) | ✅ Done, 5 tests |
| Processors (3 job types + fault injection) | ✅ Done, tested on real sample files |
| Backend (api router, worker, authorizer, repo, SQS/S3 adapters, retries, idempotency, stale/duplicate protection, DLQ redrive, backup/restore) | ✅ Done, 93 unit tests |
| SAM template (all resources, dashboard, 4 alarms, optional SNS, budget template) | ✅ Done; `sam validate --lint` and `cfn-lint` (including informational checks) clean |
| Frontend (6 pages) | ✅ Done, 22 tests, production build OK, visually reviewed at desktop and mobile widths with throwaway fixture data that is **not** in the repo |
| Docs | ✅ README, this file, docs/* |
| PowerShell scripts | ✅ Written; ⚠️ **not executed**, because PowerShell was unavailable in the build environment |
| E2E suite (`backend/tests/e2e`) | ✅ Written, type-checked, skips without config; ⏳ **never run**, because no stack is deployed |
| AWS deployment | ⏳ **Not started**: waiting for the owner |

## Next steps (in order)

1. In the project folder (the working copy is `C:\dev\QueuePilot`; `D:\QueuePilot` is blocked by Windows Controlled Folder Access): run `npm ci`, then `npm run check`.
2. Create an IAM Identity Center user, then run `aws configure sso` with profile `queuepilot`.
3. `.\scripts\preflight.ps1 -Profile queuepilot`
4. `.\scripts\deploy-budget.ps1 -AlertEmail <email> -Profile queuepilot`
5. `.\scripts\deploy-backend.ps1 -Profile queuepilot -GenerateToken`
6. `.\scripts\run-e2e.ps1 -Profile queuepilot`, then record the results in `docs/TESTING.md`.
7. `.\scripts\deploy-frontend.ps1 -Profile queuepilot`
8. Rehearse `docs/DEMO_SCRIPT.md`, and record a fallback video.
9. After grading: `.\scripts\teardown.ps1 -Profile queuepilot`

## Key decisions (see docs/ARCHITECTURE.md §6 for reasons)

- **Region and stack.** Region `us-east-1`; stack `queuepilot-dev`; resource names `queuepilot-dev-{api,worker,authorizer}`.
- **API.** HTTP API with a Lambda authorizer (shared demo token, a `NoEcho` parameter); throttling 10 req/s, burst 20.
- **Worker.**
  - Batch size 5 with partial batch responses; `MaximumConcurrency` 3; timeout 15 s; queue visibility timeout 90 s.
  - **3 attempts** (`maxReceiveCount` = `MAX_ATTEMPTS` = 3; a test enforces this), with backoff of 5 s then 20 s via `ChangeMessageVisibility`.
- **Statuses.**
  - `FAILED` means non-retryable (no retries, no DLQ).
  - `DEAD_LETTERED` means a retryable error exhausted its attempts (the message is in the DLQ).
- **Concurrency safety:**
  - `dispatchId` fencing, which changes on every manual retry;
  - a 20 s lease (timeout + 5 s);
  - conditional DynamoDB updates on status and dispatchId;
  - redrive resets `cycleAttempts`.
- **DynamoDB.** A single table with GSI1 (newest first) and GSI2 (by status), and TTL on `expiresAt`.
- **S3.**
  - The data bucket is private, with lifecycle rules: 3 days for inputs/outputs, 30 days for backups.
  - The website bucket always exists and is public only when `EnableWebsite=true`.
- **Build and deploy.** Lambdas are bundled by `backend/scripts/build.mjs` (esbuild) into `backend/dist/<fn>/index.mjs`. `sam deploy` packages those folders, with no `sam build` and no Docker.
- **Frontend.** `HashRouter`; the session (API URL + token) lives in `sessionStorage`; the API URL comes from `VITE_API_URL` and is not a secret.

## Toolchain versions (pinned through package-lock.json)

- Node.js ≥ 22.12, TypeScript 5.9, Vite 8, Vitest 5, React 19, zod 3.25, esbuild 0.25, AWS SDK v3.
- Lint: ESLint 9 + typescript-eslint 8.
- **Versions deliberately not used:** TypeScript 7 (too new for typescript-eslint), Vitest 4 (crashes the npm 10 installer).
- Vite 7 was replaced by Vite 8 because Vitest 5 hoists Vite 8, and mixing the two broke the dev server.

## Known limitations / open questions

See docs/ARCHITECTURE.md §7. The most important:
- whether redriven messages behave normally is verified only by e2e test #8, which has not run yet;
- a Lambda timeout on the *final* attempt leaves the job `PROCESSING` with an expired lease (Retry is allowed for this);
- the demo token is a shared secret, not per-user authentication;
- the S3 website is HTTP only (CloudFront would add HTTPS).

## Conventions

- All shared types and schemas live in `shared/src`. The backend must not depend on its own copy of zod; it detects zod errors by shape (`isZodError`).
- Every state change goes through `jobsRepo.transitionJob` (conditional) and adds a timeline event.
- Log with `createLogger().child({...})` (JSON lines with `jobId`). Emit metrics with `emitMetric` (EMF; keep the total custom metrics ≤ 10).
- Before handing over, run `npm run check` and `npm run validate:template`.
