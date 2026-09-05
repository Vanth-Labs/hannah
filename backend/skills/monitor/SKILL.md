---
name: monitor
description: Open a live process monitor in the terminal
terminal.linux: htop || top
terminal.mac: top
terminal.windows: Get-Process | Sort-Object CPU -Descending | Format-Table -AutoSize
phrases: ["monitor de procesos", "abrí el monitor", "abrí htop", "monitor del sistema"]
---
Use when the user wants a live/interactive process monitor. Opens it in the terminal panel.
Takes no input.
