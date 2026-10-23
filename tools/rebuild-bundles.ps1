# DELIGHT: refresh the compiled code inside the six .mcpb bundles.
# Keeps each bundle's manifest and node_modules exactly as they were,
# and replaces only dist\ with the freshly compiled version.
# Does NOT touch GitHub. Run from any PowerShell window.

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root    = "D:\mcp-servers"
$bundles = "$root\bundles"
$dl      = "$root\downloads"
$work    = "D:\pack-tmp\rebuild"
$backup  = "D:\Downloads\mcpb-backup"

$map = [ordered]@{
  "delight-filesystem" = "filesystem-mcp-server"
  "delight-web-fetch"  = "fetch-mcp-server"
  "delight-memory"     = "memory-mcp-server"
  "delight-github"     = "github-mcp-server"
  "delight-database"   = "postgres-mcp-server"
  "delight-payments"   = "stripe-mcp-server"
}

New-Item -ItemType Directory -Force $backup, $work, $dl | Out-Null
$ok = 0; $bad = 0

foreach ($name in $map.Keys) {
  $server = $map[$name]
  $dist   = "$root\$server\dist"
  $bundle = "$bundles\$name.mcpb"

  if (-not (Test-Path "$dist\index.js")) { Write-Host "SKIP  $name : $dist\index.js not found. Run npm run build in $server" -ForegroundColor Red; $bad++; continue }
  if (-not (Test-Path $bundle))          { Write-Host "SKIP  $name : $bundle not found" -ForegroundColor Red; $bad++; continue }

  if (Select-String -Path "$dist\index.js" -Pattern 'mcp-server - Built in' -Quiet) {
    Write-Host "SKIP  $name : $server\dist is still the OLD build (name has the banner). Run npm run build there first." -ForegroundColor Red; $bad++; continue
  }

  Copy-Item $bundle "$backup\$name-$(Get-Date -Format yyyyMMdd-HHmmss).mcpb" -Force

  $tmp = "$work\$name"
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $tmp | Out-Null
  & tar -xf $bundle -C $tmp
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$tmp\manifest.json")) { Write-Host "FAIL  $name : could not open the old bundle" -ForegroundColor Red; $bad++; continue }

  Remove-Item "$tmp\dist" -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item $dist "$tmp\dist" -Recurse

  $out = "$work\$name.mcpb"
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  [System.IO.Compression.ZipFile]::CreateFromDirectory($tmp, $out, [System.IO.Compression.CompressionLevel]::Optimal, $false)

  Copy-Item $out $bundle -Force
  Copy-Item $out "$dl\$name.mcpb" -Force
  Write-Host ("OK    {0}  ({1} KB)" -f $name, [math]::Round((Get-Item $bundle).Length / 1KB)) -ForegroundColor Green
  $ok++
}

Write-Host ""
Write-Host "$ok rebuilt, $bad skipped. Old bundles are saved in $backup" -ForegroundColor Cyan
Write-Host "Next: node tests\bundle-test.mjs D:\mcp-servers\downloads"
