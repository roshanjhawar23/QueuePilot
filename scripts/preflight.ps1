<#
.SYNOPSIS
  Checks your machine and AWS identity before the first deployment. Makes NO changes.

.DESCRIPTION
  - Verifies Node.js, npm, AWS CLI v2 and AWS SAM CLI are installed.
  - Shows WHICH AWS identity and account will be used (ARN only - never keys).
  - Refuses to continue if that identity is the account root user.
  - Warns if the account blocks public S3 buckets (then deploy with -EnableWebsite false).

.EXAMPLE
  .\scripts\preflight.ps1 -Profile queuepilot -Region us-east-1
#>
param(
    [Alias('Profile')][string]$AwsProfile = $env:AWS_PROFILE,
    [string]$Region = 'us-east-1'
)
. "$PSScriptRoot\common.ps1"

$ok = $true
Write-Step 'Local tools'
foreach ($t in @(
        @{ Name = 'node'; Args = @('--version'); Need = 'Node.js 22.12 or newer (https://nodejs.org)' },
        @{ Name = 'npm'; Args = @('--version'); Need = 'npm (installed with Node.js)' },
        @{ Name = 'aws'; Args = @('--version'); Need = 'AWS CLI v2 (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)' },
        @{ Name = 'sam'; Args = @('--version'); Need = 'AWS SAM CLI (https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)' }
    )) {
    $cmd = Get-Command $t.Name -ErrorAction SilentlyContinue
    if (-not $cmd) { Write-Host "  MISSING  $($t.Name): install $($t.Need)" -ForegroundColor Red; $ok = $false; continue }
    $v = (& $t.Name @($t.Args) 2>&1 | Select-Object -First 1)
    Write-Host "  found    $($t.Name): $v"
}
if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVersion = [version]((node --version).TrimStart('v'))
    if ($nodeVersion -lt [version]'22.12.0') { Write-Host "  Node.js $nodeVersion is too old; install 22.12+." -ForegroundColor Red; $ok = $false }
}
if (-not $ok) { throw 'Install the missing tools, then run this script again.' }

Write-Step 'AWS identity (read-only check)'
$awsArgs = @('sts', 'get-caller-identity', '--output', 'json') + (Get-AwsArgs $AwsProfile $Region)
$idJson = & aws @awsArgs
if ($LASTEXITCODE -ne 0) {
    throw "No working AWS credentials for profile '$AwsProfile'. Run: aws configure sso   (or: aws sso login --profile $AwsProfile)"
}
$id = $idJson | ConvertFrom-Json
Write-Host "  Account: $($id.Account)"
Write-Host "  Caller:  $($id.Arn)"
if ($id.Arn -match ':root$') {
    throw 'You are signed in as the ROOT user. Create an IAM Identity Center user (or IAM user with MFA) and use that instead.'
}

Write-Step 'S3 public-access settings for the account (affects the public website bucket)'
$bpaArgs = @('s3control', 'get-public-access-block', '--account-id', $id.Account, '--output', 'json') + (Get-AwsArgs $AwsProfile $Region)
$bpa = & aws @bpaArgs 2>$null
if ($LASTEXITCODE -eq 0) {
    $cfg = ($bpa | ConvertFrom-Json).PublicAccessBlockConfiguration
    if ($cfg.BlockPublicPolicy -or $cfg.RestrictPublicBuckets) {
        Write-Host '  Your account blocks public bucket policies. Deploy with:  -EnableWebsite false' -ForegroundColor Yellow
        Write-Host '  and run the dashboard locally (npm run dev -w frontend). Everything else works the same.' -ForegroundColor Yellow
    } else {
        Write-Host '  Public static website hosting is allowed.'
    }
} else {
    Write-Host '  No account-level block configured (or no permission to read it). Website hosting should work.'
}

Write-Step 'Budget reminder'
Write-Host '  Create the cost alert BEFORE deploying:  .\scripts\deploy-budget.ps1 -AlertEmail you@example.com'
Write-Host "`nPreflight passed." -ForegroundColor Green
