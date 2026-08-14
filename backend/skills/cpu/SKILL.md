---
name: cpu
description: Show the CPU model
run.linux: grep -m1 "model name" /proc/cpuinfo
run.mac: sysctl -n machdep.cpu.brand_string
run.windows: Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name
phrases: ["qué procesador", "que procesador", "qué cpu", "mi procesador"]
---
Use when the user asks which CPU / processor they have. Takes no input.
