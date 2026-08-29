# Restoring a playwright-mcp backup

These archives were written by `/workforce audit` (claude-workforce). Each contains `CLAUDE.md`
and `.claude/` as they were before the run.

## Guided restore
- `claude-workforce-pre-*` / `claude-baseline-*` : run `/workforce restore`

## Hand restore (works even if workforce is uninstalled)
    cd /home/francis/lab/playwright-mcp
    unzip -o .claude-backups/<archive>.zip

A restore MERGES: it overwrites what the archive holds and leaves everything else in place. So after
restoring a pre-audit archive you still have any employees the audit registered; delete `.claude/agents/`
and `.claude/workforce/` by hand if you want a full revert.

## Symlinks
`.claude/agents/` entries can be symlinks. `unzip` restores them; `Expand-Archive` (Windows) does not.
The link manifest is stored inside the archive at `.claude/.symlink-manifest.txt` (column 2 = the raw
relative link text — the only form to recreate). Replay after extract:

    while IFS=$'\t' read -r link target _; do
      case "$link" in \#*) continue;; esac
      ln -sfn "$target" "$link"
    done < .claude/.symlink-manifest.txt
