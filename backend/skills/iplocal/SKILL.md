---
name: iplocal
description: Show local network IP addresses
run.linux: ip -brief addr
run.mac: ifconfig | grep "inet "
run.windows: ipconfig
phrases: ["mi ip local", "dirección ip", "direccion ip", "qué ip tengo", "mi ip"]
---
Use when the user asks for their local/LAN IP address. Takes no input.
