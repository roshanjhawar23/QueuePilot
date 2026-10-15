# Contributing to QueuePilot

Thanks for your interest! Issues, ideas and pull requests are welcome.

## Development setup

1. Install **Node.js 22.12+** and **Git** (AWS tools are only needed to deploy; see the [README](README.md#prerequisites)).
2. Fork and clone the repository, then:
   ```bash
   npm ci
   npm run check      # must pass before you open a pull request
   ```

## Making changes

- Create a branch from `main`: `git checkout -b feature/short-description`.
- Keep shared types and schemas in `shared/src`. The backend and the frontend both import them.
- Every job state change goes through `transitionJob` in `backend/src/lib/jobsRepo.ts` and adds a timeline event.
- Add or update tests with your change. Processor changes should be tested against files in `sample-data/`.
- Infrastructure changes go in `backend/template.yaml`. Run `npm run validate:template` (needs the SAM CLI) or let CI run cfn-lint.
- Update the relevant document in `docs/` when behaviour, cost or security changes.
- Never commit secrets, `.env` files, `backend/e2e.config.json`, `node_modules` or build output.

## Commit messages

Use short, imperative summaries, for example `Add CSV delimiter auto-detection`. Reference issues with `#123` where relevant.

## Pull requests

1. Make sure `npm run check` passes locally. CI runs the same checks.
2. Describe what changed and why, and how you tested it. If you deployed to your own AWS account,
   include the result of `scripts/run-e2e.ps1`.
3. Keep pull requests focused: one feature or fix at a time.

## Reporting bugs

Open an issue using the **Bug report** template. Include steps to reproduce, what you expected and what
happened, and any `requestId` shown in the error. Do **not** include tokens or AWS account details.
Security issues: follow [SECURITY.md](SECURITY.md) instead.
