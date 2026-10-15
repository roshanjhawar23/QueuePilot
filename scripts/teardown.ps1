<#
.SYNOPSIS
  Deletes everything QueuePilot created, so it costs nothing afterwards.

.DESCRIPTION
  1. Empties the data and website S3 buckets (CloudFormation cannot delete non-empty buckets).
  2. Runs sam delete (asks you to confirm).
  3. Lists any AWS resources still tagged Project=QueuePilot so you can see nothing is left.
  The budget stack (queuepilot-budget) is kept on purpose; remove it with -IncludeBudget.

.EXAMPLE
  .\scripts\teardown.ps1 -Profile queuepilot
#>
param(
    [Alias('Profile')][string]$AwsProfile = $env:AWS_PROFILE,
    [string]$Region = 'us-east-1',
    [string]$StackName = 'queuepilot-dev',
    [switch]$IncludeBudget
)
. "$PSScriptRoot\common.ps1"

$out = Get-StackOutputs -StackName $StackName -AwsProfile $AwsProfile -Region $Region
foreach ($bucket in @($out['DataBucketName'], $out['WebsiteBucketName'])) {
    if (-not $bucket) { continue }
    Write-Step "Emptying s3://$bucket"
    Invoke-Native aws (@('s3', 'rm', "s3://$bucket", '--recursive') + (Get-AwsArgs $AwsProfile $Region))
}

Write-Step "Deleting stack $StackName"
Push-Location $BackendDir
try { Invoke-Native sam (@('delete', '--stack-name', $StackName) + (Get-AwsArgs $AwsProfile $Region)) }
finally { Pop-Location }

if ($IncludeBudget) {
    Write-Step 'Deleting the budget stack'
    Invoke-Native aws (@('cloudformation', 'delete-stack', '--stack-name', 'queuepilot-budget') + (Get-AwsArgs $AwsProfile 'us-east-1'))
}

Write-Step 'Resources still tagged Project=QueuePilot (should be empty, apart from the budget if kept)'
& aws @(@('resourcegroupstaggingapi', 'get-resources', '--tag-filters', 'Key=Project,Values=QueuePilot', '--query', 'ResourceTagMappingList[].ResourceARN', '--output', 'table') + (Get-AwsArgs $AwsProfile $Region))
Write-Host "`nNote: SAM keeps a small 'aws-sam-cli-managed-default' stack/bucket for code uploads (a few MB, under one cent per month)." -ForegroundColor Yellow
Write-Host 'Delete it in the CloudFormation console after emptying its bucket if you want a completely clean account.'
