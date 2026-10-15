<#
.SYNOPSIS
  Builds the React dashboard against the deployed API and publishes it to the S3 website bucket.

.DESCRIPTION
  Writes frontend/.env.production.local with VITE_API_URL (not a secret), runs the production
  build, and syncs frontend/dist to the website bucket. The demo token is NOT built into the site;
  you type it on the sign-in screen.

.EXAMPLE
  .\scripts\deploy-frontend.ps1 -Profile queuepilot
.EXAMPLE
  .\scripts\deploy-frontend.ps1 -LocalOnly    # just write .env.local for npm run dev
#>
param(
    [Alias('Profile')][string]$AwsProfile = $env:AWS_PROFILE,
    [string]$Region = 'us-east-1',
    [string]$StackName = 'queuepilot-dev',
    [switch]$LocalOnly
)
. "$PSScriptRoot\common.ps1"

$out = Get-StackOutputs -StackName $StackName -AwsProfile $AwsProfile -Region $Region
$apiUrl = $out['ApiUrl']

if ($LocalOnly) {
    "VITE_API_URL=$apiUrl" | Set-Content -Encoding utf8 (Join-Path $FrontendDir '.env.local')
    Write-Host "Wrote frontend/.env.local. Start the dashboard with:  npm run dev -w frontend   (http://localhost:5173)" -ForegroundColor Green
    return
}

if (-not $out.ContainsKey('WebsiteUrl')) {
    throw 'This stack was deployed with EnableWebsite=false. Use -LocalOnly and run the dashboard locally.'
}

Push-Location $RepoRoot
try {
    Write-Step 'Building the dashboard'
    "VITE_API_URL=$apiUrl" | Set-Content -Encoding utf8 (Join-Path $FrontendDir '.env.production.local')
    Invoke-Native npm @('run', 'build', '-w', 'frontend')

    Write-Step "Uploading to s3://$($out['WebsiteBucketName'])"
    $syncArgs = @('s3', 'sync', (Join-Path $FrontendDir 'dist'), "s3://$($out['WebsiteBucketName'])", '--delete') + (Get-AwsArgs $AwsProfile $Region)
    Invoke-Native aws $syncArgs
    # index.html must never be cached long, so a redeploy shows up immediately.
    $cpArgs = @('s3', 'cp', (Join-Path $FrontendDir 'dist\index.html'), "s3://$($out['WebsiteBucketName'])/index.html", '--cache-control', 'no-cache', '--content-type', 'text/html') + (Get-AwsArgs $AwsProfile $Region)
    Invoke-Native aws $cpArgs

    Write-Host "`nDashboard published: $($out['WebsiteUrl'])" -ForegroundColor Green
    Write-Host 'Sign in with the API URL (pre-filled) and your demo token.'
}
finally { Pop-Location }
