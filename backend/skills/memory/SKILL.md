---
name: memory
description: Show RAM usage
run.linux: free -h
run.mac: top -l 1 | grep -E "PhysMem"
run.windows: Get-CimInstance Win32_OperatingSystem | Select FreePhysicalMemory,TotalVisibleMemorySize
phrases: ["cuánta memoria", "cuanta memoria", "uso de memoria", "memoria ram", "cuánta ram"]
---
Use when the user asks about RAM / memory usage. Takes no input.
