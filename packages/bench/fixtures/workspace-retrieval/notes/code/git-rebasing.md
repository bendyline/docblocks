# Git rebasing cheat sheet

Notes from finally sitting down to understand rebase instead of copy-pasting commands. The one-line mental model: rebase replays my commits on top of a new base, creating brand new commits with new hashes.

## Basic rebase

```bash
git fetch origin
git switch feature/search-box
git rebase origin/main
```

If a commit conflicts, git stops. Fix the files, then `git add` them and run `git rebase --continue`. To bail out entirely: `git rebase --abort`. To skip a commit that has become empty or pointless: `git rebase --skip`.

## Interactive rebase for cleaning up history

```bash
git rebase -i HEAD~4
```

The editor lists the last four commits, oldest first. Change the word at the start of each line:

- `pick` keeps the commit as is
- `reword` keeps the changes but lets me edit the message
- `squash` melds the commit into the one above and combines the messages
- `fixup` does the same as squash but throws away the message
- `drop` deletes the commit

Trick: `git commit --fixup <hash>` creates a commit named "fixup! ..." and then `git rebase -i --autosquash origin/main` puts it in the right place automatically. Set `git config --global rebase.autosquash true` so I never forget the flag.

## Moving a branch with --onto

Use rebase --onto when you need to move a range of commits onto a different base. Example: I branched `topic-b` off `topic-a`, then `topic-a` got squash-merged into main. Now `topic-b` still carries all of topic-a's old commits.

```bash
git rebase --onto main topic-a topic-b
```

Read it as: take the commits after `topic-a` up to `topic-b`, and replay them onto `main`.

## Rules I keep breaking

1. Never rebase commits other people have already pulled. If it is shared, use `git merge` or `git revert`.
2. After a rebase my local branch has diverged from the remote copy, so pushing needs `git push --force-with-lease`. The lease refuses to overwrite if someone else pushed in the meantime, which plain `--force` would happily destroy.
3. `git pull --rebase` is a fetch followed by a rebase; I made it the default with `git config --global pull.rebase true`.

Note to self: if a rebase goes wrong, see the notes on recovering lost commits. The old commits are still there for a while.
