# Shared helpers for the QueuePilot PowerShell scripts. Dot-source it: . "$PSScriptRoot\common.ps1"
# These scripts never read, print or store AWS access keys. They use whatever identity your
# AWS CLI profile already has (ideally IAM Identity Center / SSO, never the root user).

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:BackendDir = Join-Path $RepoRoot 'backend'
$script:FrontendDir = Join-Path $RepoRoot 'frontend'

function Invoke-Native {
    # Runs a native command and stops the script if it fails.
    param([Parameter(Mandatory)][string]$File, [string[]]$Arguments = @())
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): $File $($Arguments -join ' ')" }
}

function Get-AwsArgs {
    param([string]$AwsProfile, [string]$Region)
    $a = @()
    if ($AwsProfile) { $a += @('--profile', $AwsProfile) }
    if ($Region) { $a += @('--region', $Region) }
    return $a
}

function Get-StackOutputs {
    # Returns a hashtable of CloudFormation stack outputs (names -> values).
    param([Parameter(Mandatory)][string]$StackName, [string]$AwsProfile, [string]$Region)
    $awsArgs = @('cloudformation', 'describe-stacks', '--stack-name', $StackName, '--query', 'Stacks[0].Outputs', '--output', 'json') + (Get-AwsArgs $AwsProfile $Region)
    $json = & aws @awsArgs
    if ($LASTEXITCODE -ne 0) { throw "Could not read outputs of stack '$StackName'. Is it deployed in this region?" }
    $map = @{}
    foreach ($o in ($json | ConvertFrom-Json)) { $map[$o.OutputKey] = $o.OutputValue }
    return $map
}

function Read-DemoToken {
    # Reads the demo token without echoing it to the screen or saving it in shell history.
    param([string]$Prompt = 'Demo token (16+ characters: letters, digits, - _ .)')
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($plain.Length -lt 16 -or $plain -notmatch '^[A-Za-z0-9_\-\.]+$') {
        throw 'The token must be 16-128 characters using letters, digits, "-", "_" or ".".'
    }
    return $plain
}

function New-DemoToken {
    # 32 random characters from a cryptographic random generator.
    $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

function Write-Step([string]$Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }
