# Command reference — network

When the user asks about network, emit `[RUN: <command>]` (pick the OS line; default Linux).

- Public IP → `curl -s ifconfig.me` · windows `(Invoke-WebRequest ifconfig.me).Content`
- Listening ports → linux `ss -tulpn` · mac `lsof -iTCP -sTCP:LISTEN -n -P` · windows `netstat -ano | findstr LISTENING`
- Ping a host → `ping -c 3 <host>` · windows `ping -n 3 <host>`
- DNS lookup → `nslookup <domain>` (or `dig +short <domain>`)
- Trace route → `traceroute <host>` · windows `tracert <host>`
- Test a URL / HTTP status → `curl -sI <url>`
- Active connections → linux/mac `ss -tp` · windows `netstat -b`
- Wi-Fi networks → linux `nmcli dev wifi` · mac `airport -s`
