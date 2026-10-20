param(
 [string]$Runtime = (Join-Path (Split-Path $PSScriptRoot -Parent) '.runtime'),
 [string]$StartScript = '',
 [switch]$CheckOnly
)
$ErrorActionPreference='Stop'
$taskLaunchFile=Join-Path $Runtime 'launch.private.json'
function Read-RunningPanel {
 if(!(Test-Path -LiteralPath $taskLaunchFile)){return $null}
 $taskLaunch=Get-Content -LiteralPath $taskLaunchFile -Raw | ConvertFrom-Json
 $taskUri=[Uri]$taskLaunch.url
 if($taskUri.Scheme -ne 'http' -or $taskUri.Host -ne '127.0.0.1' -or $taskUri.AbsolutePath -ne '/login' -or $taskUri.UserInfo -or $taskUri.Query -notmatch '^\?token=[a-f0-9]{64}$'){throw 'Invalid local panel link'}
 $taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskLaunch.pid)"
 if(!$taskProcess -or $taskProcess.Name -ne 'node.exe'){return $null}
 if([Math]::Abs(($taskProcess.CreationDate.ToUniversalTime()-([DateTime]$taskLaunch.startedAt).ToUniversalTime()).TotalSeconds) -gt 10){return $null}
 return $taskLaunch
}
$taskRunning=Read-RunningPanel
if(!$taskRunning -and !$CheckOnly){
 if($StartScript){
  & $StartScript | Out-Null
 }else{
  $taskStandalone=Split-Path $PSScriptRoot -Parent
  New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
  Start-Process -FilePath (Get-Command node).Source -ArgumentList 'server.mjs' -WorkingDirectory $taskStandalone -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Runtime 'panel.out.log') -RedirectStandardError (Join-Path $Runtime 'panel.err.log') | Out-Null
 }
 for($taskTry=0;$taskTry -lt 30;$taskTry++){
  Start-Sleep -Milliseconds 200
  $taskRunning=Read-RunningPanel
  if($taskRunning){break}
 }
}
if(!$taskRunning){throw 'Panel is not running. Check the panel log in the runtime folder.'}
if($CheckOnly){Write-Output 'Panel launcher: valid running local service';return}
# The user explicitly double-clicked to open a visible browser.
Start-Process -FilePath $taskRunning.url | Out-Null
