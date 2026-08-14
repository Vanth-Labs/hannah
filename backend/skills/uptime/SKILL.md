---
name: uptime
description: How long the machine has been on
run.linux: uptime -p
run.mac: uptime
run.windows: (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
phrases: ["cuánto lleva prendida", "cuánto lleva encendida", "hace cuánto se prendió", "uptime"]
---
Use when the user asks how long the computer has been running. Takes no input.
