# Git: recovering lost commits

Git almost never deletes anything right away. Commits that nothing points to are just unreachable, and they stick around until garbage collection prunes them (by default unreachable reflog entries expire after 30 days, and reachable ones after 90).

## The reflog

git reflog shows every position HEAD has been at, even commits no branch points to anymore. Each line looks like `a1b2c3d HEAD@{3}: commit: add search box`.

```bash
git reflog
git reflog show feature/search-box   # history of one branch tip
```

## Getting a deleted branch back

I ran `git branch -D old-experiment` by accident.

```bash
git reflog | grep old-experiment
git branch old-experiment a1b2c3d
```

If I cannot remember the name, scan the reflog for the last commit message I wrote on it and branch from that hash.

## Undoing a bad reset or rebase

After `git reset --hard HEAD~3` the three commits look gone. They are not.

```bash
git reset --hard HEAD@{1}
```

`HEAD@{1}` means "where HEAD was one move ago". For a botched rebase, git also records `ORIG_HEAD`, so `git reset --hard ORIG_HEAD` jumps back to just before the rebase.

## Commits that were never in the reflog

If I staged a file and then lost it, the blob may still exist:

```bash
git fsck --lost-found
```

This lists dangling commits and blobs, and writes them under `.git/lost-found/`. Slow on a big repo but it has saved me once.

## Stash recovery

A dropped stash prints its hash when dropped. Otherwise `git fsck --unreachable | grep commit` and inspect candidates with `git show <hash>`.

## Quick table

| Situation | Command |
| --- | --- |
| Deleted branch | `git branch name <hash-from-reflog>` |
| Bad hard reset | `git reset --hard HEAD@{1}` |
| Bad rebase | `git reset --hard ORIG_HEAD` |
| Lost file never committed | `git fsck --lost-found` |

Related: the rebasing notes. Always run `git status` and `git stash` before experiments.
