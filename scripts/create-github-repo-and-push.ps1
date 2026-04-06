# Creates a GitHub repo (if needed) via API, then pushes branch main.
# Usage:
#   $env:GITHUB_TOKEN = "ghp_xxxx"   # classic PAT, "repo" scope — https://github.com/settings/tokens
#   .\scripts\create-github-repo-and-push.ps1
param(
  [string] $Owner = "zaeem2195",
  [string] $RepoName = "MightX",
  [switch] $Private
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

if (-not $env:GITHUB_TOKEN) {
  Write-Host "Missing env GITHUB_TOKEN. Create a classic PAT with 'repo' scope at https://github.com/settings/tokens" -ForegroundColor Yellow
  exit 1
}

$headers = @{
  Authorization = "Bearer $($env:GITHUB_TOKEN)"
  Accept        = "application/vnd.github+json"
  "User-Agent"  = "MightX-push-script"
}
$createBody = @{ name = $RepoName; private = [bool]$Private } | ConvertTo-Json

try {
  Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Method Post -Headers $headers -Body $createBody -ContentType "application/json" | Out-Null
  Write-Host "Created https://github.com/$Owner/$RepoName" -ForegroundColor Green
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 422) {
    Write-Host "Repo already exists or name taken — pushing anyway." -ForegroundColor Cyan
  } else {
    Write-Host "API error: $_" -ForegroundColor Red
    exit 1
  }
}

git remote remove origin 2>$null
git remote add origin "https://github.com/$Owner/$RepoName.git"

# HTTPS push with PAT (GitHub: user x-access-token, password = PAT)
$pushUrl = "https://x-access-token:$($env:GITHUB_TOKEN)@github.com/$Owner/$RepoName.git"
git push -u $pushUrl main

git remote set-url origin "https://github.com/$Owner/$RepoName.git"
Write-Host "Remote set to https://github.com/$Owner/$RepoName.git — use Git Credential Manager or SSH for future pushes." -ForegroundColor Green
