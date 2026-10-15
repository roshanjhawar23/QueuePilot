<#
.SYNOPSIS
  Builds the Lambda bundles, validates the SAM template, and deploys the QueuePilot stack.

.DESCRIPTION
  1. npm run build (backend)  -> backend/dist/{api,worker,authorizer}
  2. sam validate --lint
  3. Asks for the demo token (hidden input), or generates one with -GenerateToken
  4. sam deploy  -> shows the change set and asks you to confirm before creating anything
  5. Writes backend/e2e.config.json with the API URL only (no secrets)

  The demo token is passed to CloudFormation as a NoEcho parameter. It is not written to any file.

.EXAMPLE
  .\scripts\deploy-backend.ps1 -Profile queuepilot -GenerateToken
.EXAMPLE
  .\scripts\deploy-backend.ps1 -Profile queuepilot -EnableWebsite false -AlarmEmail you@example.com
#>
param(
    [Alias('Profile')][string]$AwsProfile = $env:AWS_PROFILE,
    [string]$Region = 'us-east-1',
    [string]$StackName = 'queuepilot-dev',
    [ValidateSet('true', 'false')][string]$EnableWebsite = 'true',
    [string]$AlarmEmail = '',
    [switch]$GenerateToken
)
. "$PSScriptRoot\common.ps1"

Push-Location $RepoRoot
try {
    if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
        Write-Step 'Installing dependencies (npm ci)'
        Invoke-Native npm @('ci')
    }

    Write-Step 'Building Lambda bundles'
    Invoke-Native npm @('run', 'build', '-w', 'backend')

    Write-Step 'Validating the SAM template'
    Push-Location $BackendDir
    try { Invoke-Native sam @('validate', '--lint', '--template-file', 'template.yaml', '--region', $Region) }
    finally { Pop-Location }

    if ($GenerateToken) {
        $token = New-DemoToken
        Write-Host "`nGenerated demo token (shown once - store it in a password manager):" -ForegroundColor Yellow
        Write-Host "  $token`n" -ForegroundColor Yellow
    } else {
        $token = Read-DemoToken
    }

    Write-Step "Deploying stack '$StackName' to $Region (you will be asked to confirm the change set)"
    $overrides = @("DemoToken=$token", "EnableWebsite=$EnableWebsite")
    if ($AlarmEmail) { $overrides += "AlarmEmail=$AlarmEmail" }
    $deployArgs = @('deploy', '--stack-name', $StackName, '--parameter-overrides') + $overrides + (Get-AwsArgs $AwsProfile $Region)
    Push-Location $BackendDir
    try { Invoke-Native sam $deployArgs }
    finally { Pop-Location; $token = $null }

    $out = Get-StackOutputs -StackName $StackName -AwsProfile $AwsProfile -Region $Region
    @{ apiUrl = $out['ApiUrl'] } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $BackendDir 'e2e.config.json')

    Write-Step 'Deployed'
    Write-Host "  API URL:       $($out['ApiUrl'])"
    if ($out.ContainsKey('WebsiteUrl')) { Write-Host "  Website URL:   $($out['WebsiteUrl'])  (publish it with .\scripts\deploy-frontend.ps1)" }
    Write-Host "  Dashboard:     $($out['DashboardUrl'])"
    Write-Host "`nNext: .\scripts\run-e2e.ps1 to test the live stack, then .\scripts\deploy-frontend.ps1" -ForegroundColor Green
}
finally { Pop-Location }
