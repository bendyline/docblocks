/**
 * A rebuild must never end a live editor session. In particular, recorded
 * media can still exist only in renderer memory while its save is pending.
 */
export function createDevBuildPolicy(launch: () => void, notifyRebuild: () => void) {
  const completed = new Set<'main' | 'preload'>();
  let launched = false;
  return (target: 'main' | 'preload'): void => {
    if (launched) {
      notifyRebuild();
      return;
    }
    completed.add(target);
    if (completed.size !== 2) return;
    launch();
    launched = true;
  };
}
