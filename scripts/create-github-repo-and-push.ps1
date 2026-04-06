# Creates zaeem2195/MightX on GitHub (if missing) and pushes branch main.
#
# Pick ONE auth method:
#   A) GitHub CLI:  & "C:\Program Files\GitHub CLI\gh.exe" auth login
#      then:         .\scripts\create-github-repo-and-push.ps1
#   B) Classic PAT (repo scope): https://github.com/settings/tokens
#      $env:GITHUB_TOKEN = "ghp_xxxx"
#      .\scripts\create-github-repo-and-push.ps1
#      Or put the token (one line) in .github-token at repo root (gitignored).

param(
  [string] $Owner = "zaeem2195",
  [string] $RepoName = "MightX",
  [switch] $Private
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

function Find-Gh {
  $defaultPath = "C:\Program Files\GitHub CLI\gh.exe"
  if (Test-Path $defaultPath) { return $defaultPath }
  $cmd = Get-Command gh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Get-GitHubToken {
  if ($env:GITHUB_TOKEN) { return $env:GITHUB_TOKEN.Trim() }
  if ($env:GH_TOKEN) { return $env:GH_TOKEN.Trim() }
  $tokenFile = Join-Path $repoRoot ".github-token"
  if (Test-Path $tokenFile) {
    return (Get-Content $tokenFile -Raw).Trim()
  }
  $envFile = Join-Path $repoRoot ".env"
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match '^\s*GITHUB_TOKEN\s*=\s*(.+)$') {
        return $matches[1].Trim().Trim('"').Trim([char]39)
      }
    }
  }
  return $null
}

# --- Prefer GitHub CLI when installed and already logged in ---
$gh = Find-Gh
if ($gh) {
  $errPref = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  $null = & $gh auth status 2>&1
  $ghAuthed = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $errPref
  if ($ghAuthed) {
    Write-Host "Using GitHub CLI (logged in)..." -ForegroundColor Cyan
    if ($Private) {
      & $gh repo create "$Owner/$RepoName" --private --source=. --remote=origin --push
    } else {
      & $gh repo create "$Owner/$RepoName" --public --source=. --remote=origin --push
    }
    if ($LASTEXITCODE -eq 0) {
      Write-Host "Done: https://github.com/$Owner/$RepoName" -ForegroundColor Green
      exit 0
    }
    Write-Host "gh repo create exited with an error - if the repo already exists, try: git push -u origin main" -ForegroundColor Yellow
    exit $LASTEXITCODE
  }
}

# --- REST API + git push (PAT) ---
$token = Get-GitHubToken
if (-not $token) {
  Write-Host ""
  Write-Host "No GitHub auth found. Do one of the following, then run this script again:" -ForegroundColor Yellow
  Write-Host ""
  Write-Host '  [CLI]  & "C:\Program Files\GitHub CLI\gh.exe" auth login' -ForegroundColor Gray
  Write-Host "         .\scripts\create-github-repo-and-push.ps1" -ForegroundColor Gray
  Write-Host ""
  Write-Host "  [PAT]  https://github.com/settings/tokens (classic token, repo scope)" -ForegroundColor Gray
  Write-Host '         $env:GITHUB_TOKEN = "ghp_xxxx"' -ForegroundColor Gray
  Write-Host "         .\scripts\create-github-repo-and-push.ps1" -ForegroundColor Gray
  Write-Host ""
  Write-Host "         Or save the token (one line) in .github-token at repo root (gitignored)." -ForegroundColor Gray
  Write-Host ""
  exit 1
}

$env:GITHUB_TOKEN = $token

$headers = @{
  Authorization = "Bearer $token"
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
    Write-Host "Repo already exists or name taken - pushing anyway." -ForegroundColor Cyan
  } else {
    Write-Host "API error: $_" -ForegroundColor Red
    exit 1
  }
}

git remote remove origin 2>$null
git remote add origin "https://github.com/$Owner/$RepoName.git"

$pushUrl = "https://x-access-token:$token@github.com/$Owner/$RepoName.git"
git push -u $pushUrl main

git remote set-url origin "https://github.com/$Owner/$RepoName.git"
Write-Host "Remote: https://github.com/$Owner/$RepoName.git - use Git Credential Manager or SSH for future pushes." -ForegroundColor Green
