---
name: ping
description: Check if a host or website is reachable
run: ping -c 3 {arg}
phrases: ["hacé ping a", "hace ping a", "ping a", "haceme ping a"]
---
Use this when the user wants to check whether a server or website is up / reachable.
The input is the host or domain.
Example: "hacé ping a google.com" -> arg = google.com -> runs `ping -c 3 google.com`.
