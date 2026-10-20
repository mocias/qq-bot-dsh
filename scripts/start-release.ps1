param([string]$Deployment=(Split-Path $PSScriptRoot -Parent))
$ErrorActionPreference='Stop'
$taskDeployment=(Resolve-Path -LiteralPath $Deployment).Path
$taskManifest=Get-Content -LiteralPath (Join-Path $taskDeployment '.runtime/native-release.private.json') -Raw | ConvertFrom-Json
$taskRuntime=Join-Path $taskDeployment 'standalone/.runtime'
$taskLaunchFile=Join-Path $taskRuntime 'launch.private.json'
if(Test-Path -LiteralPath $taskLaunchFile){
  $taskLaunch=Get-Content -LiteralPath $taskLaunchFile -Raw | ConvertFrom-Json
  $taskExisting=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskLaunch.pid)"
  if($taskExisting -and $taskExisting.Name -eq 'node.exe' -and [Math]::Abs(($taskExisting.CreationDate.ToUniversalTime()-([DateTime]$taskLaunch.startedAt).ToUniversalTime()).TotalSeconds) -lt 10){
    if($taskLaunch.version -ne $taskManifest.version -or $taskLaunch.buildId -ne $taskManifest.buildId){throw '旧服务仍运行，请通过统一更新工具切换。'}
    Write-Output ('QQ RSI '+$taskManifest.version+' is running: '+$taskLaunch.url)
    return
  }
}
$taskEntry=Join-Path $taskManifest.releaseRoot 'scripts/start-live.mjs'
$taskStarted=Start-Process -FilePath (Get-Command node).Source -ArgumentList @(('"' + $taskEntry + '"'),('"' + $taskDeployment + '"')) -WorkingDirectory $taskManifest.releaseRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRuntime 'server-native.out.log') -RedirectStandardError (Join-Path $taskRuntime 'server-native.err.log')
for($taskAttempt=0;$taskAttempt -lt 40;$taskAttempt++){
  Start-Sleep -Milliseconds 200
  if(Test-Path -LiteralPath $taskLaunchFile){
    $taskLaunch=Get-Content -LiteralPath $taskLaunchFile -Raw | ConvertFrom-Json
    if($taskLaunch.pid -eq $taskStarted.Id){Write-Output ('QQ RSI '+$taskManifest.version+' started: '+$taskLaunch.url);return}
  }
  if($taskStarted.HasExited){throw '服务启动失败，请检查 standalone/.runtime/server-native.err.log'}
}
throw '服务启动等待超时。'
