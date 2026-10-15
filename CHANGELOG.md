# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Repository essentials: MIT license, contributing guide, security policy, CI workflow (type-check, lint,
  tests, builds, cfn-lint, PowerShell syntax check, secret scan), Dependabot, issue and pull request templates.
- Complete README covering installation, deployment, usage, configuration, testing, cost and troubleshooting.

## [0.1.0] - 2026-10-10

### Added
- Three job types: `csv.summary`, `text.analytics`, `data.validate`.
- Serverless backend: API Gateway HTTP API with demo-token authorizer, API and worker Lambdas, SQS queue
  with dead-letter queue, DynamoDB single table, S3 storage, CloudWatch dashboard and alarms (AWS SAM).
- Retries with exponential backoff, non-retryable error classification, DLQ redrive, per-job retry with
  corrected parameters, idempotent submission, stale/duplicate message protection, backup and restore.
- Clearly labelled fault-injection demo control (transient, permanent, slow).
- React dashboard: pipeline view, job submission, job explorer, job detail, recovery and backups pages.
- PowerShell deployment, testing and teardown scripts; budget alert template.
- 120 unit tests and a 10-test live end-to-end suite.
