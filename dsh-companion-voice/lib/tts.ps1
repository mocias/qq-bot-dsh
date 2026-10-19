param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$request=Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$speaker=New-Object System.Speech.Synthesis.SpeechSynthesizer
try{
 $speaker.SelectVoice([string]$request.voice)
 $speaker.SetOutputToWaveFile([string]$request.file)
 $speaker.Speak([string]$request.text)
}finally{$speaker.Dispose()}
@{ok=$true}|ConvertTo-Json -Compress
