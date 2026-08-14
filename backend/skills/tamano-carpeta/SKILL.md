---
name: tamano-carpeta
description: Show the size of a folder
run.linux: du -sh {arg}
run.mac: du -sh {arg}
run.windows: "{0:N1} MB" -f ((Get-ChildItem {arg} -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB)
phrases: ["cuánto pesa la carpeta", "tamaño de la carpeta", "cuánto ocupa"]
---
Use when the user asks how big a folder is. Input is the path.
Example: "cuánto pesa la carpeta ~/Descargas" -> du -sh ~/Descargas
