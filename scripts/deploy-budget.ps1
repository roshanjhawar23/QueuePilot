<#
.SYNOPSIS
  Creates an AWS Budget ($130/month) with email alerts at about $5, $20, $50, $100 and a forecast alert.
  Budgets send alerts; they do not stop spending. The first two budgets in an account are free.

.EXAMPLE
  .\scripts\deploy-budget.ps1 -AlertEmail you@example.com -Profile queuepilot
#>
param(
    [Parameter(Mandatory)][string]$AlertEmail,
    [Alias('Profile')][string]$AwsProfile = $env:AWS_PROFILE,
    [int]$MonthlyLimitUsd = 130
)
. "$PSScriptRoot\common.ps1"

Write-Step "Deploying the budget stack (queuepilot-budget) in us-east-1"
$cfnArgs = @(
    'cloudformation', 'deploy',
    '--template-file', (Join-Path $RepoRoot 'infra\budget.yaml'),
    '--stack-name', 'queuepilot-budget',
    '--parameter-overrides', "AlertEmail=$AlertEmail", "MonthlyLimitUsd=$MonthlyLimitUsd",
    '--tags', 'Project=QueuePilot', 'Env=dev'
) + (Get-AwsArgs $AwsProfile 'us-east-1')
Invoke-Native aws $cfnArgs
Write-Host "Budget created. Alerts go to $AlertEmail." -ForegroundColor Green
