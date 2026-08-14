---
name: ssh
description: Open an SSH session to a host (interactive, in the terminal panel)
terminal: ssh {arg}
phrases: ["conectate a", "conéctate a", "ssh a", "entrá por ssh a"]
---
Use when the user wants to connect to a remote server by SSH. Input is user@host (or host).
This opens the terminal panel and starts the SSH session so the user can type their
password and drive the session.
Example: "conectate a pedro@192.168.1.10" -> ssh pedro@192.168.1.10
