# Hannah , launcher for Windows. `hannah.cmd` next to this file makes it a plain `hannah` command
# (install.ps1 adds this folder to your user PATH).
#   hannah            bring up Ollama + voice/listening sidecars + backend (+ agent) and open the overlay
#   hannah stop       shut it all down (add -KeepOllama to leave the model server running)
#   hannah doctor     what is running and what is missing
# Everything runs in your user session, no admin. Logs: <root>\.hannah-logs\
param([string]$Command = 'up', [string]$Arg = '', [switch]$KeepOllama, [switch]$Yes, [switch]$DryRun)
$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$Tools = Join-Path $Root '.tools'
$Back = Join-Path $Root 'backend'; if (-not (Test-Path $Back)) { $Back = Join-Path $Root 'hannah-backend' }
$Agent = Join-Path $Root 'agent'; if (-not (Test-Path $Agent)) { $Agent = Join-Path $Root 'hannah-agent' }
$Lab = Join-Path $Root 'motion-model'; if (-not (Test-Path $Lab)) { $Lab = Join-Path $Root 'hannah-motion-lab' }
function Find-HannahExe {
  $default = Join-Path $env:LOCALAPPDATA 'Programs\Hannah\Hannah.exe'
  if (Test-Path $default) { return $default }
  foreach ($k in (Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue)) {
    $v = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
    if ($v.DisplayName -like 'Hannah*' -and $v.InstallLocation) { $c = Join-Path $v.InstallLocation 'Hannah.exe'; if (Test-Path $c) { return $c } }
  }
  $hit = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Filter 'Hannah.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  return $default
}
$App = if ($env:HANNAH_APP) { $env:HANNAH_APP } else { Find-HannahExe }
$Log = Join-Path $Root '.hannah-launch.log'
$env:Path = "$Root\.tools\git\cmd;$Root\.tools\node;$Root\.tools\ollama;$env:LOCALAPPDATA\Programs\Ollama;$env:USERPROFILE\.local\bin;$env:USERPROFILE\.bun\bin;$env:Path"

function Has($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Up($port) { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function HealthPath($port) { switch ($port) { 3001 { '/api/v1/health' } 8006 { '/hannah/v0/health' } 11434 { '/api/tags' } default { '/health' } } }
function Healthy($port) { try { Invoke-WebRequest "http://127.0.0.1:$port$(HealthPath $port)" -UseBasicParsing -TimeoutSec 2 | Out-Null; $true } catch { $false } }
function EnvVal($key) {
  # dotenv-like: quotes respected, `#` after a space is a comment
  $f = Join-Path $Back '.env'; if (-not (Test-Path $f)) { return '' }
  foreach ($line in Get-Content $f) {
    $m = [regex]::Match($line, '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$')
    if (-not $m.Success -or $m.Groups[1].Value -ne $key) { continue }
    $v = $m.Groups[2].Value.Trim()
    if ($v.Length -ge 2 -and $v[0] -eq $v[-1] -and ($v[0] -eq '"' -or $v[0] -eq "'")) { return $v.Substring(1, $v.Length - 2) }
    return ($v -split '\s+#', 2)[0].Trim()
  }
  return ''
}
function Settings($section, $key) {
  $f = Join-Path $Back 'data\settings.json'; if (-not (Test-Path $f)) { return '' }
  try { $j = Get-Content $f -Raw | ConvertFrom-Json; $s = $j.$section; if ($s -and $s.$key) { return [string]$s.$key } } catch {}
  return ''
}
function AgentOn { (EnvVal 'AGENT_ENABLED') -eq 'true' }
function AgentKey { $k = Settings 'agent' 'apiKey'; if ($k) { return $k }; foreach ($v in 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY') { $k = EnvVal $v; if ($k) { return $k } }; '' }
function AgentKeyVar { $k = AgentKey; if ($k -like 'sk-or-*') { 'OPENROUTER_API_KEY' } else { 'ANTHROPIC_API_KEY' } }
function AgentToken {
  $t = Settings 'agent' 'token'; if (-not $t) { $t = EnvVal 'HANNAH_AGENT_TOKEN' }
  if (-not $t) {
    $t = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    $f = Join-Path $Back '.env'; $txt = Get-Content $f -Raw
    if ($txt -match '(?m)^#?\s*HANNAH_AGENT_TOKEN=') { $txt = $txt -replace '(?m)^#?\s*HANNAH_AGENT_TOKEN=.*$', "HANNAH_AGENT_TOKEN=$t" } else { $txt += "`nHANNAH_AGENT_TOKEN=$t`n" }
    Set-Content $f $txt -NoNewline
  }
  $t
}
function SenseOn { (EnvVal 'SENSE_ENABLED') -ne 'false' }
function SenseToken {
  $t = Settings 'sense' 'token'; if (-not $t) { $t = EnvVal 'HANNAH_SENSE_TOKEN' }
  if (-not $t) {
    $t = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    $f = Join-Path $Back '.env'; $txt = Get-Content $f -Raw
    if ($txt -match '(?m)^#?\s*HANNAH_SENSE_TOKEN=') { $txt = $txt -replace '(?m)^#?\s*HANNAH_SENSE_TOKEN=.*$', "HANNAH_SENSE_TOKEN=$t" } else { $txt += "`nHANNAH_SENSE_TOKEN=$t`n" }
    Set-Content $f $txt -NoNewline
  }
  $t
}
function WatchCounts {
  try { $w = (Invoke-RestMethod 'http://127.0.0.1:8007/health' -TimeoutSec 2).watches; "$($w.armed) armed - $($w.blind) blind - $($w.suspended) suspended" } catch { '' }
}
# our own processes: anchored to this checkout's path (never other apps)
function OwnProcs { Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Root\*" -and $_.ProcessId -ne $PID } }
# one log per service under <root>\.hannah-logs (two processes cannot share one redirected file)
$Logs = Join-Path $Root '.hannah-logs'; New-Item -ItemType Directory -Force -Path $Logs | Out-Null
function StartBg($name, $dir, $exe, $argList, $extraEnv) {
  foreach ($k in $extraEnv.Keys) { Set-Item "env:$k" $extraEnv[$k] }
  Start-Process -WindowStyle Hidden -WorkingDirectory $dir -FilePath $exe -ArgumentList $argList -RedirectStandardOutput (Join-Path $Logs "$name.log") -RedirectStandardError (Join-Path $Logs "$name.err.log")
  foreach ($k in $extraEnv.Keys) { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
}

switch ($Command) {
  'doctor' {
    Write-Host 'Hannah , Windows'
    Write-Host "  root       : $Root"
    $t = foreach ($x in 'node', 'uv', 'bun', 'ollama') { if (Has $x) { "$x ok" } else { "$x missing" } }; Write-Host "  tools      : $($t -join ' ')"
    $s = foreach ($p in @{11434='ollama'; 8002='tts'; 8001='asr'; 8005='motion'; 3001='backend'; 8006='agent'; 8007='sense'}.GetEnumerator() | Sort-Object Name) {
      if (Healthy $p.Name) { "$($p.Value) ok" } elseif (Up $p.Name) { "$($p.Value) !(port busy)" } else { "$($p.Value) missing" } }
    Write-Host "  services   : $($s -join ' ')"
    Write-Host "  app        : $App $(if (Test-Path $App) { 'ok' } else { 'x (re-run the installer)' })"
    $mh = try { Invoke-RestMethod 'http://127.0.0.1:8005/health' -TimeoutSec 2 } catch { $null }
    Write-Host "  gestures   : $(if (-not $mh) { 'not running' } elseif ($mh.ready -eq $false) { "warming up on $($mh.device) (first start downloads the text encoder; a minute or two)" } else { "on $($mh.device)" })"
    # a service that is down should say why, right here: the tail of its error log
    foreach ($svc in 'motion', 'backend', 'tts', 'asr', 'sense', 'agent') {
      $port = @{ motion = 8005; backend = 3001; tts = 8002; asr = 8001; sense = 8007; agent = 8006 }[$svc]
      $errLog = Join-Path $Logs "$svc.err.log"
      if (-not (Healthy $port) -and (Test-Path $errLog) -and (Get-Item $errLog).Length -gt 0) {
        Write-Host "  --- $svc is down; last lines of $errLog :" -ForegroundColor Yellow
        Get-Content $errLog -Tail 8 | ForEach-Object { Write-Host "      $_" }
      }
    }
    Write-Host "  hands      : $(if (AgentOn) { "AGENT_ENABLED=true - key $(if (AgentKey) { 'ok' } else { 'x' })" } else { 'off (enable: hannah hands on)' })"
    Write-Host "  watches    : $(if (SenseOn) { $c = WatchCounts; if ($c) { $c } else { ':8007 is not answering (missing sidecar\sense\.venv? re-run the installer)' } } else { 'off (SENSE_ENABLED=false)' })"
    exit 0
  }
  'stop' {
    Write-Host 'Hannah , shutting down:'
    Get-Process -Name Hannah -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $App } | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host '  overlay ok'
    OwnProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host '  backend, sidecars, agent ok'
    if (-not $KeepOllama) { Get-Process -Name ollama -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Host '  ollama ok' } else { Write-Host '  ollama kept' }
    exit 0
  }
  'uninstall' {
    # What the installer created and nothing else. Ollama and its models are the user's (used
    # outside Hannah too); uv, bun and ~\.local\bin are shared tools: they stay.
    $appDir = Split-Path $App
    $unins = Join-Path $appDir 'Uninstall Hannah.exe'
    $appData = Join-Path $env:APPDATA 'hannah-desktop'
    $agentCfg = Join-Path $env:USERPROFILE '.config\hannah-agent'
    Write-Host 'Hannah, uninstall. This removes:'
    Write-Host "  $Root"
    Write-Host '      (repos, Python envs, weights, and data\ with your settings, keys and memory)'
    if (Test-Path $App) { Write-Host "  $appDir (the app)" }
    if (Test-Path $appData) { Write-Host "  $appData (window position)" }
    if (Test-Path $agentCfg) { Write-Host "  $agentCfg" }
    Write-Host "  the PATH entries the installer added ($Root and $Tools\*)"
    Write-Host 'Kept: Ollama and its models, uv, bun, ~\.local\bin.'
    if ($DryRun) { Write-Host '(dry run: nothing removed)'; exit 0 }
    if (-not $Yes) { $a = Read-Host 'Type "yes" to remove all of that'; if ($a -ne 'yes') { Write-Host 'cancelled, nothing touched'; exit 1 } }
    Get-Process -Name Hannah -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $App } | Stop-Process -Force -ErrorAction SilentlyContinue
    OwnProcs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep 1
    if (Test-Path $unins) { Start-Process -Wait -FilePath $unins -ArgumentList '/S' -ErrorAction SilentlyContinue }
    if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir -ErrorAction SilentlyContinue }
    foreach ($d in @($appData, $agentCfg)) { if (Test-Path $d) { Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue } }
    $keep = ([Environment]::GetEnvironmentVariable('Path', 'User') -split ';') | Where-Object { $_ -and ($_ -ne $Root) -and (-not $_.StartsWith($Tools, 'OrdinalIgnoreCase')) }
    [Environment]::SetEnvironmentVariable('Path', ($keep -join ';'), 'User')
    # this script lives inside $Root: the folder goes right after we exit
    Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList "/c timeout /t 3 /nobreak >nul & rmdir /s /q `"$Root`""
    Write-Host 'Hannah uninstalled (the folder disappears in a few seconds). To come back: irm https://vanthlabs.org/install.ps1 | iex'
    exit 0
  }
  'hands' {
    # The hands, on demand: the installer no longer brings the agent (repo, 870 MB of
    # dependencies and bun) because it is off by default.
    function Set-EnvKey($key, $value) {
      $f = Join-Path $Back '.env'
      $text = Get-Content $f -Raw
      if ($text -match "(?m)^#?\s*$key=") { $text = $text -replace "(?m)^#?\s*$key=.*$", "$key=$value" } else { $text = $text.TrimEnd() + "`r`n$key=$value`r`n" }
      Set-Content $f $text -NoNewline
    }
    switch ($Arg) {
      'on' {
        if (-not (Test-Path (Join-Path $Agent '.git'))) {
          Write-Host "Hannah: downloading the agent to $Agent"
          git clone -q https://github.com/Vanth-Labs/agent.git $Agent; if ($LASTEXITCODE) { Write-Host 'hannah: could not clone the agent'; exit 1 }
        }
        if (-not (Has bun)) {
          Write-Host 'Hannah: installing bun (your user only)'
          $t = Join-Path ([IO.Path]::GetTempPath()) 'bun-install.ps1'
          Invoke-WebRequest 'https://bun.sh/install.ps1' -OutFile $t -UseBasicParsing
          & powershell -NoProfile -ExecutionPolicy Bypass -File $t | Out-Null
          $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
          if (-not (Has bun)) { Write-Host 'hannah: bun did not install (https://bun.sh)'; exit 1 }
        }
        Write-Host 'Hannah: agent dependencies (bun install, about a minute)'
        Push-Location $Agent; bun install 2>&1 | Out-Null; $rc = $LASTEXITCODE; Pop-Location
        if ($rc) { Write-Host "hannah: bun install failed in $Agent"; exit 1 }
        Set-EnvKey 'AGENT_ENABLED' 'true'
        Write-Host 'Hands on (AGENT_ENABLED=true).'
        Write-Host "Missing: the provider key (Anthropic or OpenRouter): the overlay's settings -> Hands, or ANTHROPIC_API_KEY / OPENROUTER_API_KEY in $Back\.env."
        Write-Host 'Restart so the agent starts: hannah stop, then hannah'
        exit 0
      }
      'off' { Set-EnvKey 'AGENT_ENABLED' 'false'; Write-Host "Hands off (AGENT_ENABLED=false). Nothing is removed; 'hannah hands on' enables them again. Applies on the next start."; exit 0 }
      default { Write-Host 'Usage: hannah hands on|off'; exit 2 }
    }
  }
  'up' { }
  default {
    Write-Host "hannah: unknown command: $Command"
    Write-Host 'Usage: hannah [stop [-KeepOllama] | doctor | uninstall [-Yes] [-DryRun] | hands on|off]'
    exit 2
  }
}

if (-not (Test-Path (Join-Path $Back '.env'))) { Write-Host "hannah: $Back\.env is missing , run the installer first"; exit 1 }
Add-Content $Log "[hannah] $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') up"
if (-not (Healthy 11434) -and (Has ollama)) { Start-Process -WindowStyle Hidden -FilePath 'ollama' -ArgumentList 'serve' }
$py = Join-Path $Back 'sidecar\.venv\Scripts\python.exe'
if (-not (Up 8002)) { StartBg 'tts' (Join-Path $Back 'sidecar\tts') $py '-m uvicorn main:app --port 8002' @{ TTS_DEVICE = 'cpu' } }
if (-not (Up 8001)) { StartBg 'asr' (Join-Path $Back 'sidecar\asr') $py '-m uvicorn main:app --port 8001' @{ ASR_DEVICE = 'cpu' } }
# gestures: the NVIDIA card if there is one, else the CPU , never skipped
$mpy = Join-Path $Lab '.venv\Scripts\python.exe'
if (-not (Up 8005) -and (Test-Path $mpy)) { StartBg 'motion' $Lab $mpy '-m uvicorn serve.main:app --port 8005' @{ MOTION_DEVICE = 'auto'; PYTHONPATH = (Join-Path $Lab 'src') } }
# the watches, before the backend so its capability probe finds them
$spy = Join-Path $Back 'sidecar\sense\.venv\Scripts\python.exe'
if ((SenseOn) -and (Test-Path $spy) -and -not (Up 8007)) { StartBg 'sense' (Join-Path $Back 'sidecar\sense') $spy '-m uvicorn main:app --host 127.0.0.1 --port 8007' @{ HANNAH_SENSE_TOKEN = (SenseToken); SENSE_MAX_WATCHES = (EnvVal 'SENSE_MAX_WATCHES'); SENSE_MIN_PERIOD_MS = (EnvVal 'SENSE_MIN_PERIOD_MS'); SENSE_DEBOUNCE_N = (EnvVal 'SENSE_DEBOUNCE_N'); SENSE_BLIND_MS = (EnvVal 'SENSE_BLIND_MS') } }
if ((AgentOn) -and (Has bun) -and (Test-Path $Agent) -and -not (Up 8006)) {
  $tok = AgentToken
  $aenv = @{ HANNAH_AGENT_TOKEN = $tok; HANNAH_AGENT_SERVER_PASSWORD = $tok; HANNAH_AGENT_MAX_MODE = (EnvVal 'AGENT_MODE'); HANNAH_AGENT_DENY_DIRS = (Join-Path $Back 'data') }
  $aenv[(AgentKeyVar)] = (AgentKey)
  StartBg 'agent' $Agent 'bun' 'run dev serve --port 8006' $aenv
}
if (-not (Up 3001)) { StartBg 'backend' $Back 'node' 'src\server.js' @{} }
for ($i = 0; $i -lt 60 -and -not (Healthy 3001); $i++) { Start-Sleep 1 }
if (-not (Healthy 3001)) { Write-Host "hannah: the backend did not come up , see $Logs\backend.err.log"; exit 1 }
foreach ($p in 8001, 8002, 8005, 8006, 8007) { if ((Up $p) -and -not (Healthy $p)) { Add-Content $Log "[hannah] WARNING: port $p is busy with something else" } }
if (Test-Path $App) {
  # the packaged app serves its own frontend and talks to the backend at localhost:3001;
  # it holds a single-instance lock, so a second launch just focuses the existing window.
  # Chromium's own log (renderer console errors included) goes to .hannah-logs\app.log, so a
  # blank or frozen overlay can be diagnosed from the logs folder alone.
  Start-Process -FilePath $App -ArgumentList "--enable-logging=file", "--log-file=`"$Logs\app.log`""

} else {
  $setup = Join-Path $Root 'HannahSetup.exe'
  Write-Host "hannah: the overlay app is not installed ($App). $(if (Test-Path $setup) { "Run $setup (SmartScreen: More info -> Run anyway) and try again." } else { 'Re-run the installer.' }) Meanwhile: http://localhost:3001/test-client.html"
}
