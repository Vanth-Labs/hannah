---
name: diskspace
description: Show free disk space
run: df -h --total | tail -1
phrases: ["espacio en disco", "cuánto espacio", "cuanto espacio", "disco libre"]
---
Use this when the user asks how much disk space is free or used.
Takes no input.
