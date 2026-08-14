---
name: ports
description: Show listening network ports
run.linux: ss -tulpn
run.mac: lsof -iTCP -sTCP:LISTEN -n -P
run.windows: netstat -ano | Select-String LISTENING
phrases: ["qué puertos", "puertos abiertos", "puertos escuchando", "qué está escuchando"]
---
Use when the user asks which ports are open / listening. Takes no input.
