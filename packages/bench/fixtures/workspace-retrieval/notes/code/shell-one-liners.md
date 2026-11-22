# Shell one-liners

```bash
find . -name "*.log" -mtime +30 -delete        # remove logs older than 30 days
du -sh * | sort -h | tail -5                   # five biggest items here
grep -rn --include="*.ts" "TODO" src/          # search with line numbers
ls -t | head -1                                # newest file
lsof -i :3000                                  # who owns port 3000
tar -czf backup.tgz folder/                    # compress; -xzf to extract
xargs -n1 -P4 gzip < filelist.txt              # four gzips in parallel
```

Reminder: put `set -euo pipefail` at the top of every script so it stops on the first error instead of ploughing on.
