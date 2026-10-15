# Deployment guide (Windows, step by step)

You run every command that touches AWS. Nothing here needs, prints or stores AWS access keys.
Total time for a first deployment is about 30–45 minutes, most of it one-time setup.

## 0. Install the tools (one time)

| Tool | Version | Install | Check |
|---|---|---|---|
| Node.js | 22.12 or newer (LTS) | <https://nodejs.org> | `node --version` |
| AWS CLI | v2 | <https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html> | `aws --version` |
| AWS SAM CLI | latest | <https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html> | `sam --version` |
| Git (optional) | any | <https://git-scm.com> | `git --version` |

Docker is **not** required: the Lambda code is bundled with esbuild, not built in containers.

Open **PowerShell** in `D:\QueuePilot`. If scripts are blocked, allow them for this window only:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

## 1. Install dependencies and run the local checks

```powershell
npm ci                 # installs exactly the versions in package-lock.json
npm run check          # typecheck + lint + unit tests + builds (no AWS needed)
```

`node_modules` folders from another computer or operating system must not be reused. If you see esbuild or rollup "platform" errors, delete every `node_modules` folder and run `npm ci` again.

## 2. Create a safe AWS identity (one time, never use root)

1. Sign in to the AWS Console as the account owner **only for this setup step**, and make sure the root user has MFA enabled.
2. Open **IAM Identity Center** → *Enable*.
3. **Users** → *Add user* (e.g. `rajat-dev`) → set a password, then enable MFA when you first sign in.
4. **Permission sets** → *Create* → *Predefined* → `AdministratorAccess` (simplest for a personal learning account, because SAM must create IAM roles) → session duration 4 hours.
5. **AWS accounts** → select your account → *Assign users* → your user + that permission set.
6. Note the **AWS access portal URL** shown on the Identity Center dashboard.
7. In PowerShell:
   ```powershell
   aws configure sso
   # SSO session name: queuepilot
   # SSO start URL:    <your access portal URL>
   # SSO region:       the region where Identity Center is enabled
   # (a browser opens; approve)
   # CLI default region: us-east-1   output format: json   profile name: queuepilot
   ```
   This stores **short-lived** credentials that refresh through the browser. There are no long-lived keys.
   When they expire later, run `aws sso login --profile queuepilot`.

## 3. Preflight (read-only)

```powershell
.\scripts\preflight.ps1 -Profile queuepilot
```
This checks the tools, shows the account and caller ARN, stops if you are root, and warns if your account blocks public S3 buckets. In that case, deploy with `-EnableWebsite false` in step 5 and run the dashboard locally.

## 4. Budget alert (do this before deploying)

```powershell
.\scripts\deploy-budget.ps1 -AlertEmail you@example.com -Profile queuepilot
```
AWS emails you at about $5, $20, $50 and $100 of monthly spend, and when the forecast exceeds $130.

## 5. Deploy the backend

```powershell
.\scripts\deploy-backend.ps1 -Profile queuepilot -GenerateToken
# or choose your own token (hidden prompt):
.\scripts\deploy-backend.ps1 -Profile queuepilot
# options: -EnableWebsite false   -AlarmEmail you@example.com   -Region us-east-1
```
What happens:
1. The Lambda bundles are built.
2. The template is linted.
3. SAM shows a **change set** listing every resource it will create. Review it and type `y`.
4. CloudFormation creates the stack in about 3–5 minutes.
5. The script prints the API URL, website URL and CloudWatch dashboard link.

If you used `-GenerateToken`, copy the token into a password manager **now**; it is shown once.

## 6. Test the live system

```powershell
.\scripts\run-e2e.ps1 -Profile queuepilot
```
This runs 10 end-to-end tests against real AWS in about 4–6 minutes, for a fraction of a cent. See [TESTING.md](TESTING.md).

## 7. Publish the dashboard

```powershell
.\scripts\deploy-frontend.ps1 -Profile queuepilot
```
Open the printed website URL, and sign in with the API URL (pre-filled) and your demo token.

**Local alternative** (also needed when `-EnableWebsite false`):
```powershell
.\scripts\deploy-frontend.ps1 -Profile queuepilot -LocalOnly
npm run dev -w frontend      # http://localhost:5173
```

## 8. Optional: load burst for the demo

```powershell
$env:QP_API_URL = "<ApiUrl from step 5>"
$env:QP_TOKEN = "<demo token>"
node scripts/burst.mjs 50
Remove-Item Env:\QP_TOKEN
```

## 9. Updating after code changes

Re-run step 5 (backend) and/or step 7 (frontend). CloudFormation only changes what differs.

## 10. Tear down

```powershell
.\scripts\teardown.ps1 -Profile queuepilot                 # keeps the budget alert
.\scripts\teardown.ps1 -Profile queuepilot -IncludeBudget  # removes everything
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `The SSO session ... has expired` | `aws sso login --profile queuepilot` |
| Deploy fails on `WebsiteBucketPolicy` with *AccessDenied … public policies are blocked* | The account blocks public buckets: redeploy with `-EnableWebsite false` and use `-LocalOnly` |
| Sign-in says *token was rejected* | Wrong token. Redeploy with a new one if it was lost (the stack updates in place) |
| Upload fails with a CORS error | You opened the dashboard from an origin not in the CORS list. Use the S3 website URL or `http://localhost:5173` |
| Jobs stay `QUEUED` | Check the worker log group in CloudWatch; confirm the stack finished deploying (`CREATE_COMPLETE`) |
| `sam` asks for an S3 bucket | Make sure you run the script (it uses `backend/samconfig.toml` with `resolve_s3 = true`) |
| `npm ci` fails with platform errors | Delete all `node_modules` folders and run it again on this machine |
