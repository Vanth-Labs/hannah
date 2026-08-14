---
name: ippublic
description: Show the public (internet) IP address
run.linux: curl -s ifconfig.me
run.mac: curl -s ifconfig.me
run.windows: (Invoke-WebRequest -UseBasicParsing ifconfig.me).Content
phrases: ["mi ip pública", "mi ip publica", "ip de internet", "cuál es mi ip pública"]
---
Use when the user asks for their public/internet IP. Takes no input.
