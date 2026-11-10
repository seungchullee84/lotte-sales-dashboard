param([switch]$NoBrowser, [string]$NodePath)
$ErrorActionPreference = 'Stop'
$url = 'http://127.0.0.1:58123/'
function Test-SalesProgram {
  try { return (Invoke-RestMethod -Uri ($url + 'api/health') -TimeoutSec 2).app -eq 'lotte-sales-dashboard' }
  catch { return $false }
}
if (-not (Test-SalesProgram)) {
  $runtime = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $runtime -and $NodePath -and (Test-Path -LiteralPath $NodePath)) { $runtime = $NodePath }
  if (-not $runtime) {
    $bundles = Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' -ErrorAction SilentlyContinue
    $runtime = $bundles | Sort-Object Version -Descending | ForEach-Object {
      Join-Path $_.InstallLocation 'dependencies/node/bin/node.exe'
    } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  }
  if (-not $runtime) { throw 'Node.js 실행 파일을 찾지 못했어요.' }
  $server = Join-Path $PSScriptRoot 'server.mjs'
  $env:LOTTE_SALES_PORT = '58123'
  $process = Start-Process -FilePath $runtime -ArgumentList ('"' + $server + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
  $ready = $false
  for ($attempt = 0; $attempt -lt 25; $attempt++) {
    if (Test-SalesProgram) { $ready = $true; break }
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 160
  }
  if (-not $ready) { throw '동탄점 매출 분석기를 시작하지 못했어요.' }
}
if (-not $NoBrowser) { Start-Process $url }
