---
name: dns
description: Resolve a domain name (DNS lookup)
run: nslookup {arg}
phrases: ["resolvé el dominio", "dns de", "qué ip tiene", "resolve"]
---
Use when the user wants to resolve a domain to an IP. Input is the domain.
Example: "dns de google.com" -> nslookup google.com
