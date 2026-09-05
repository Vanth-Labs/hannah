# Command reference — git

When the user asks about the current git repo, emit `[RUN: <command>]` (same on all OS).

- Status → `git status -sb`
- Recent commits → `git log --oneline -10`
- Current branch → `git branch --show-current`
- What changed → `git diff` (staged: `git diff --staged`)
- Stage all → `git add -A`
- Commit → `git commit -m "MESSAGE"`
- Pull / push → `git pull` / `git push`
- Switch branch → `git switch <branch>` (new: `git switch -c <branch>`)
- Undo last commit (keep changes) → `git reset --soft HEAD~1`
- Remotes → `git remote -v`
