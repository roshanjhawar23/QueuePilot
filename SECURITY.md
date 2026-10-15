# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub: **Security → Report a vulnerability** on this repository
(GitHub private vulnerability reporting). Include the affected file or endpoint, steps to reproduce and
the impact you expect. You should receive a response within 7 days.

## Never commit secrets

This repository must never contain AWS access keys, the demo token, `.env` files or any other credential.
`.gitignore` blocks the common cases and CI scans every push. If a secret is ever committed:

1. **Revoke or rotate it immediately** (for AWS keys: IAM console → deactivate and delete the key;
   for the demo token: redeploy the stack with a new `DemoToken`).
2. Then remove it from the Git history. Deleting the file in a new commit is not enough.

## Supported versions

Only the latest commit on `main` is maintained.

## How QueuePilot is secured

See [docs/SECURITY.md](docs/SECURITY.md) for credential handling, IAM least privilege, data protection
and the known trade-offs of the demo-token authorizer.
