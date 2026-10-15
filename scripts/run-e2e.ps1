<#
.SYNOPSIS
  Runs the end-to-end tests against the DEPLOYED stack (real S3, SQS, Lambda, DynamoDB).
  Takes about 4-6 minutes. Cost: a fraction of one US cent.

.EXAMPLE
  .\scripts\run-e2e.ps1 -Profile queuepilot
#>
param(
    [Alias('Profile')][string]$AwsProfile = $env:AWS_PROFILE,
    [string]$Region = 'us-east-1',
    [string]$StackName = 'queuepilot-dev'
)
. "$PSScriptRoot\common.ps1"

$out = Get-StackOutputs -StackName $StackName -AwsProfile $AwsProfile -Region $Region
$env:QP_API_URL = $out['ApiUrl']
$env:QP_TOKEN = Read-DemoToken -Prompt 'Demo token used at deploy time'
try {
    Push-Location $RepoRoot
    Invoke-Native npm @('run', 'test:e2e', '-w', 'backend')
}
finally {
    Pop-Location
    Remove-Item Env:\QP_TOKEN -ErrorAction SilentlyContinue
}
