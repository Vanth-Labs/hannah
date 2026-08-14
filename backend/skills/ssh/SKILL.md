---
name: ssh
description: Open an SSH session to a host (interactive, in the terminal panel)
terminal: ssh {arg}
phrases: ["conectate a", "conéctate a", "ssh a", "entrá por ssh a", "conectate por ssh a"]
---
Use when the user wants to connect to a remote server by SSH. The backend builds `user@host`
from natural speech, e.g. "192.168.1.30 con el usuario drocho" -> `ssh drocho@192.168.1.30`.
It opens the terminal panel and TYPES the command; the user reviews it and presses Enter
(so a mis-heard host/user can be fixed), then types the password.

Natural ways to say it: "conectate a <ip/host>", "conectate a <ip> con el usuario <user>",
"conectate a <host> como <user>", "ssh a <user>@<host>".
