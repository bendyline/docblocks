/** Where an open document sits as a task, as the properties row sees it. */
export interface StripTask {
  /** The bucket the document is in; null at the tasks folder's top level. */
  readonly bucket: string | null;
  /** Buckets it can move to, in display order. */
  readonly buckets: readonly { readonly name: string; readonly done: boolean }[];
  /** Done because of where it is. */
  readonly done: boolean;
}

/**
 * Whether the List field offers a place the Done box cannot reach. The box
 * finishes a task into the first done list and reopens it into the default
 * one, so with one open list and one done list (Active and Done) the field
 * would only repeat it. A task at the top of the tasks folder is in one more
 * open place, and only the field can move it into a list without finishing it.
 */
export function offersListChoice(task: StripTask): boolean {
  const done = task.buckets.filter((bucket) => bucket.done).length;
  const open = task.buckets.length - done + (task.bucket === null ? 1 : 0);
  return open > 1 || done > 1;
}
