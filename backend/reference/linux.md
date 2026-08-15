# Command reference — system & files

When the user asks for any of these, emit `[RUN: <command>]` (pick the line for the current OS;
default to Linux). You figure out the exact command; don't ask the user to phrase it.

## System info
- OS / version → linux `uname -a` · mac `sw_vers` · windows `systeminfo`
- CPU model → linux `grep -m1 "model name" /proc/cpuinfo` · mac `sysctl -n machdep.cpu.brand_string` · windows `Get-CimInstance Win32_Processor | Select Name`
- Uptime → linux `uptime -p` · mac `uptime` · windows `(Get-CimInstance Win32_OperatingSystem).LastBootUpTime`
- Date / time → `date` · windows `Get-Date`
- Logged-in user → `whoami`

## Files & folders
- List files here → linux/mac `ls -la` · windows `Get-ChildItem`
- Read a file → linux/mac `cat <path>` · windows `Get-Content <path>`
- Create empty file → `touch <name>` · windows `New-Item <name>`
- Create file with text → `printf '%s\n' "TEXT" > <name>`
- Make a folder → `mkdir <name>`
- Delete a file/folder → `rm <path>` / `rm -r <dir>` (the app asks the user to confirm)
- Move / rename → `mv <src> <dst>`
- Copy → `cp <src> <dst>` (`cp -r` for folders)
- Count files here → linux/mac `ls -1 | wc -l` · windows `(Get-ChildItem).Count`
- Find a file by name → linux/mac `find . -iname "*NAME*"` · windows `Get-ChildItem -Recurse -Filter *NAME*`
- Search text inside files → linux/mac `grep -rn "TEXT" .` · windows `Select-String -Path * -Pattern "TEXT"`
- Folder size → linux/mac `du -sh <dir>` · windows `(Get-ChildItem <dir> -Recurse | Measure Length -Sum).Sum`

## Processes & resources
- Top processes by CPU → linux `ps -eo pid,comm,%cpu --sort=-%cpu | head` · mac `ps -Ao pid,comm,%cpu -r | head` · windows `Get-Process | Sort CPU -Desc | Select -First 10`
- Kill a process → `pkill <name>` or `kill <pid>` (destructive → confirm)
- Compress → `tar -czf out.tgz <dir>` · Extract → `tar -xzf file.tgz` / `unzip file.zip`
- Download a URL → `curl -sL <url> -o <file>` or `wget <url>`
