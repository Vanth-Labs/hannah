---
name: buscar-archivo
description: Find a file by name
run.linux: find . -iname "*{arg}*" 2>/dev/null | head -20
run.mac: find . -iname "*{arg}*" 2>/dev/null | head -20
run.windows: Get-ChildItem -Recurse -Filter *{arg}* -ErrorAction SilentlyContinue | Select-Object -First 20 FullName
phrases: ["buscá el archivo", "busca el archivo", "encontrá el archivo", "dónde está el archivo"]
---
Use when the user wants to find a file by (part of) its name. Input is the name.
Example: "buscá el archivo config" -> busca *config*.
