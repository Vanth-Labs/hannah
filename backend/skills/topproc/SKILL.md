---
name: topproc
description: Show the top processes by CPU
run.linux: ps -eo pid,comm,%cpu --sort=-%cpu | head -11
run.mac: ps -Ao pid,comm,%cpu -r | head -11
run.windows: Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name,CPU,Id
phrases: ["qué procesos", "procesos pesados", "qué está consumiendo", "procesos activos"]
---
Use when the user asks which processes use the most CPU. Takes no input.
