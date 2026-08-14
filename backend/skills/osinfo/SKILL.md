---
name: osinfo
description: Show the operating system / version info
run.linux: uname -a
run.mac: sw_vers
run.windows: systeminfo | Select-String "^OS"
phrases: ["qué sistema operativo", "que sistema operativo", "info del sistema", "qué sistema tengo"]
---
Use when the user asks what OS / system they are running.
