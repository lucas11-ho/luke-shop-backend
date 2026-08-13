$ErrorActionPreference='Stop'
$Root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location $Root
Write-Host '[1/5] Checking Node.js...' -ForegroundColor Cyan
$node=& node -p "process.versions.node" 2>$null
if(!$node){throw 'Node.js was not found. Install Node.js 24 LTS first.'}
$major=[int]($node.Split('.')[0])
if($major -lt 24){throw "Node.js 24+ is required. Found $node"}
Write-Host "PASS Node.js $node" -ForegroundColor Green
Write-Host '[2/5] Preparing .env...' -ForegroundColor Cyan
if(!(Test-Path -LiteralPath '.env')){Copy-Item -LiteralPath '.env.example' -Destination '.env';Write-Warning 'Created .env from .env.example. Replace the example secrets before starting the API.'}
else{Write-Host 'PASS .env already exists; it was not overwritten.' -ForegroundColor Green}
Write-Host '[3/5] Preparing dependency lock...' -ForegroundColor Cyan
if(!(Test-Path -LiteralPath 'package-lock.json')){
  & npm install --package-lock-only --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
  if($LASTEXITCODE){throw 'Unable to create package-lock.json.'}
  Write-Warning 'A new package-lock.json was generated. Review and commit it before production.'
}else{Write-Host 'PASS package-lock.json exists.' -ForegroundColor Green}
Write-Host '[4/5] Installing dependencies...' -ForegroundColor Cyan
& npm ci --no-audit --no-fund --registry=https://registry.npmjs.org/
if($LASTEXITCODE){throw 'npm ci failed.'}
Write-Host '[5/5] Running source verification...' -ForegroundColor Cyan
& npm run verify
if($LASTEXITCODE){throw 'Source verification failed.'}
Write-Host ''
Write-Host 'Next: edit .env, start PostgreSQL, run npm run migrate, bootstrap a tenant, then npm run dev.' -ForegroundColor Yellow
