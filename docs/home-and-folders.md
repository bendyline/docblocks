# Home, tasks, journals and the Unfiled drawer

How DocBlocks turns folders of Markdown files into a task list, a journal, an
inbox and a record of Ask chats, and gathers them on a Home page. Nothing here
has its own database: every task, entry and note is an ordinary Markdown file,
and every change is a file write or a file move that any other editor can see.

## Document properties

Any Markdown file may carry these frontmatter keys. DocBlocks reads them
everywhere and writes only the ones being changed.

| Key         | Value                                             | Meaning                       |
| ----------- | ------------------------------------------------- | ----------------------------- |
| `due`       | `2026-11-25` or `2026-11-25T15:00` (local time)   | When it is due                |
| `category`  | One short name                                    | A grouping, shown as a colour |
| `tags`      | A list (`[a, b]`, a block list, or `a, b`)        | Labels                        |
| `repeat`    | `daily`, `weekly`, `monthly` or `yearly`          | Comes due again once finished |
| `completed` | `2026-11-23`, or `true` when another tool said so | Done                          |

- **Code:** `@bendyline/docblocks/properties` (`packages/core/src/properties/`).
  `readDocumentProperties` is tolerant: a value it cannot read is left out,
  never an error, and never deleted. `applyDocumentProperties` rewrites the
  named keys through Squisq's `setFrontmatterValues`, keeping every other line
  and the key order.
- **Dates are calendar days, not instants.** They stay `YYYY-MM-DD` text and
  are never passed through `Date` parsing, which would read a bare date as UTC
  midnight. Arithmetic runs on UTC day numbers (`dates.ts`).
- **Repeats** schedule the first occurrence after both the due date and today,
  counted from the original day, so a monthly task due on the 31st returns to
  the 31st after a short month.
- **Capture** (`parseCapture`) reads a due date out of typed text: "Call Priya
  tomorrow", "Pay rent friday", "Taxes due 15th of April", "Lunch fri 12:30 pm".
  English only. Short weekday names count only after a word that announces a
  date, or as the last word, so "the cat sat on the mat" stays a title.

## Folders that say what they are for

A folder becomes a tasks folder, a journal, the Unfiled drawer or a chats
folder when it holds `<folder>/.docblocks/folder.json`:

```json
{
  "version": 1,
  "kind": "tasks",
  "tasks": { "done": ["Done"], "default": "Active" }
}
```

- The file sits inside the folder it describes, so the folder keeps its kind
  when it is moved, zipped, synced or opened as a workspace of its own.
  Deleting the file (or "Make an ordinary folder") turns it back into an
  ordinary folder; nothing in it moves.
- It is parsed as `unknown` with the exact v1 shape. A newer version or an
  unknown kind is reported as unsupported and the folder behaves as an
  ordinary one; a file that cannot be read keeps the kind it last had.
- Kind folders can nest. A path belongs to the nearest one above it.
- **Code:** `@bendyline/docblocks/folders` (`packages/core/src/folders/`).

### Tasks folders

- Every Markdown file inside is a task, named by its file name. The first
  folder below the tasks folder is its **bucket**; folders deeper than that
  only group tasks. Markdown inside a document's own `_files` folder belongs
  to that document and is never a task.
- A bucket named in `tasks.done` (default `Done`) means done; every other
  place means open. **The folder decides**, whatever the frontmatter says, so
  moving a file in a file manager is a real way to finish or reopen a task.
- Finishing a task writes `completed` and moves it to the first done bucket,
  keeping its group folders: `Active/House/Paint.md` becomes
  `Done/House/Paint.md`, and reopening puts it back. The move carries the
  task's `_files` companion folder, so attachments, version history and
  conflict copies follow it.
- A repeating task stays in Done when finished, and a fresh copy (checklist
  cleared, next due date) is created where it was.
- A tasks folder is set up from Home ("Add a tasks folder", which reuses one
  that exists), from a folder's right-click menu, or as a new list from the
  New document gallery's "Tasks folder" card, which makes `Tasks` (or
  `Tasks 2`, …) inside the folder the gallery was opened for
  (`PageActions.createKindFolder`). The card is offered only where the pages
  work, which is wherever the workspace keeps an index.
- Outside a tasks folder, a document with `due` or `completed` is still listed
  on Home and the Tasks page. Finishing it stamps `completed` and leaves the
  file where it is.

### Journals

One file per day, named for the day and filed by year:
`Journal/2026/2026-11-23.md`. An entry's date is read from its file name
(`journalDateFromPath`), so an entry made in another editor is dated as surely
as one made here. A name may add words after the date (`2026-11-23 Lisbon.md`).

### The Unfiled drawer

The folder that documents made in Quick Jot and notes typed on its own page
land in, until they are filed. Each waiting note can be filed in a folder (with its companion
folder), made a task (moved into the default tasks folder's default bucket),
or deleted after a confirmation. Where semantic search is on, a note gets a
suggested folder: where the passages nearest to it already live.

## Finding folder settings

Every lister skips dot entries, so `.docblocks/` folders were invisible. The
one exception (`isEnumeratedWorkspaceEntryName` in
`packages/core/src/filesystem/workspace-entry-rules.ts`): a recursive listing
reports a `.docblocks` folder as an ordinary entry and never enters it. The
workspace index notes which folders hold one, reads each
`<folder>/.docblocks/folder.json` once, and publishes them as
`getFolderMarkers()` (at most 256; past that the status reports a
`folder-markers` truncation).

- Desktop main (`node-workspace-filesystem-v2.ts`) and the phone bridge
  (`mobile-wire.ts`) list the folder without descending into it. IndexedDB,
  File System Access and memory providers already return dot entries from
  `readDirectory`.
- The desktop watcher (`workspace-watchers.ts`, `isIgnoredWatchPath`) admits a
  `.docblocks` folder and only `folder.json` inside it, so a kind changed in
  Finder or by a sync client is noticed. Elsewhere the index's focus and
  resume refresh picks it up.
- While a folder's contents are listed again after a change, its settings stay
  in view until the new listing settles them.

## Properties in the index

`IndexedDocument` carries `due`, `category`, `repeat`, `completed` and
`checklist` (ticked items out of how many). A quiz question's choices are a
checklist too, so side information kept in the document — study cards and
slide summaries — is left out before anything is counted
(`workspace-index/content-source.ts`). Records stored by an earlier
version of the app have no such fields; rather than wiping every stored index,
each stored record says which analyzer built it
(`DOCUMENT_ANALYZER_REVISION`), and older ones are rebuilt in the background
from the text the persistent engine already holds (`WorkspaceIndexEngine.reanalyze`).
That reads nothing from the workspace and never downloads a file a cloud
service holds. `WorkspaceIndexStatus.upgrading` counts what is left.

## The shell

- **Places.** Icon buttons right after the app menu in the sidebar header
  (`packages/react/src/Home/ShellNav.tsx`): Home always, Tasks once there is a
  tasks folder or a dated document, Ask whenever AI is on, then each journal
  and Unfiled drawer (a chats folder has no button: Ask is its page). Each
  button's tooltip and accessible name give its label and any count (tasks
  due now, notes waiting), which a corner badge also shows.
- **Routes.** `#<workspace>/:home`, `#<workspace>/:tasks`, `#<workspace>/:ask`
  and `#<workspace>/:folder/<path>` (`shell-routes.ts`). Document routes
  percent-encode their path, so a raw `:` never appears in one. Clicking any
  folder now pushes its folder route, so folder pages survive a reload.
- **Pages** load in one lazy chunk (`packages/react/src/Home/pages.tsx`) and
  render inside the existing `.db-folder-view`, so the desktop titlebar drag
  strip and the phone's "Back to files" apply unchanged.
- **Writes** go through one gateway built by the shell: the open document
  changes through its session, moves go through the file tree's own rename
  (so the session, pins, recent documents and the hash follow), and anything
  else is a conditional write retried once on a conflict
  (`packages/react/src/Tasks/task-operations.ts`). Page actions report their
  own outcomes in plain words (`page-actions.ts`).
- **Right-click a folder** to make it a tasks folder, a journal or the Unfiled
  drawer, or to make a kind folder ordinary again.
- **Launch.** DocBlocks reopens the last document. A checkbox on Home ("Show
  Home when DocBlocks opens", `preferences/launch-view.ts`) opens Home
  instead; an explicit link or open request still wins.

## Quick Jot

A box at the bottom of the left pane, below the file list and above the
footer, for getting something down without leaving the open document
(`packages/react/src/QuickJot/`). It keeps its bottom edge and grows upward as
lines are added, up to six, and the file list gives way. It replaced Home's own capture row; the
Tasks, Journal and Unfiled pages keep theirs.

- **In:** type, paste, drop files, the **Paste from clipboard** button, and
  **Dictate** where the host can transcribe (the mic, `QuickJotDictation.tsx`,
  is its own lazy chunk on `useNarrationCapture`; while it records, the
  editor's own dictation is switched off). A paste of HTML that carries
  structure the plain text lost (headings, lists, links) goes in as Markdown
  (`markdownForFieldPaste`); anything else pastes exactly as copied. Pasted
  and dropped files wait as chips under the text (up to 20, 200 MB each).
- **Out:** **New document from jot** (also Cmd/Ctrl+Enter) saves a note in the
  Unfiled drawer, named from the first line, and opens it. Word, PDF or slides
  dropped with no text are imported into the drawer instead. **New task from
  jot** takes the first line as the title (its date read by `parseCapture`)
  and the rest as notes. **Add jot to journal** adds one timestamped bullet to
  today's entry, with further lines and attachments as bullets nested under
  it (`appendToJournal(text, { keepLines })`). Nested bullets are the shape
  Squisq's editor keeps inside the entry when the day is opened and saved; a
  plain indented line would be split out of the list. The task and journal
  buttons show only when the workspace has a tasks folder or a journal; set
  one up from Home's Get started cards.
- **Attachments** are written into the new document's companion folder
  (`Note.md` → `Note_files/`) and referenced after the text, a picture as
  `![name](Note_files/name.png)`, anything else as a link
  (`Home/attachments.ts`, `PageActions.saveNote` / `attach` /
  `appendToJournal`). Storing them is all or nothing: if one file cannot be
  written, those already written are removed and nothing is saved. For a task,
  which is created first, a failure keeps the task and leaves the chips in the
  box.
- **Where it shows:** wherever the pages work (a workspace with an index, not
  a loose file). It is a sibling of the file list, not inside it, because the
  file list remounts on many changes and would lose what was typed. It can be
  turned off in Settings → Appearance → Left pane ("Show Quick Jot",
  `preferences/quick-jot.ts`, per device). VS Code has no left pane, so no
  Quick Jot.
- **On phones** it sits in the drawer; a drag that starts in its text no
  longer swipes the drawer shut (`useEdgeSwipe`).
- **Why a text area and not a Squisq editor:** a second `EditorShell` in the
  pane would take DocBlocks' editor-toolbar styling (a 48px toolbar that is a
  window-drag region in the desktop app), load the editor chunk on Home, and
  needs Squisq changes (shortcut and tooltip scoping, mic placement, drop
  overlay size). `QuickJotActions` takes a plain draft (text plus files), so a
  richer box can replace the text area without changing what the buttons do.

## The properties row in the editor

`DocumentPropertiesStrip` (`packages/react/src/Properties/`) edits Done, Due
date, Category, Tags, Repeat and List in a row between the toolbar and the
document, in Write and Source. It is passed to Squisq's `EditorShell` as
`documentHeaderSlot`, together with `hostFrontmatterKeys`
(`DOCUMENT_PROPERTY_KEYS`), which tells Squisq's own Properties list to leave
those keys out so they are not offered twice. Both props are spread untyped
(`editorDocumentHeaderProps`), so a Squisq release without them simply has no
row. Edits go through the editor (`applySourceEdits`), one undoable step each,
so `DocumentSession` stays the only writer of the open document.

## Home across workspaces

Home and the Tasks page list what is due in every workspace on the device, not
only the open one. Each workspace's index is projected into a small digest
(`Home/home-digest.ts`) kept in IndexedDB (`docblocks-home` / `digests`,
`packages/core/src/workspace/digest-store.ts`), exact-shape parsed and
rebuildable at any time. The open workspace's digest follows its live index;
the others are refreshed one at a time, read-only, by a short-lived index
(`Home/useHomeDigests.ts`). Rows from another workspace open their document in
that workspace.

They can also be ticked off where they are (`Home/elsewhere-tasks.ts`). The
task is finished or reopened on that workspace's storage by the same
operations as the open workspace's: its folder settings are read there first,
because the digest knows where a tasks folder is but not which buckets count
as done. The saved digest is then amended (`useHomeDigests`'s `amend`), so the
row, the counts and the reminders change at once. A background read that
began before the tick is not kept over it. Pins and recent documents follow a
task that moved. A browser folder whose permission has lapsed asks for it
again, since a tick is a click; a workspace that cannot be opened says so and
changes nothing.

Pasting or dropping files on Home, a document made in Quick Jot, and Ask's
"Save as note" land in the Unfiled drawer once one exists
(`importDroppedFiles(…, { folder })`). A drop on a folder in the tree or on
the editor keeps its usual place.

## Reminders

`host.notifications` (`packages/core/src/host/notifications.ts`) reminds the
person when a task comes due and shows a count on the app icon. The renderer
decides what to remind about (`Tasks/reminders.ts`: open tasks due in the next
14 days, all-day ones at a chosen time, default 09:00, at most 64) and hands
the whole set to the host each time it changes (`syncReminders`). The host
keeps the set, re-arms it after a relaunch, fires each with the operating
system's notifications, and opens the task through the ordinary open-request
channel when one is chosen. Reminders are off until turned on from Home.

- **Desktop** (`packages/desktop/main/reminders.ts`, `ipc-notifications.ts`):
  the set is kept in `userData/reminders.json`, written one save at a time.
  Reminders missed while the app was closed are shown once at launch, as one
  summary when there are several. Timers stop while the computer sleeps, so
  one timer runs at most a minute before the wall clock is read again, waking
  or unlocking reads it at once, and a reminder whose time came during sleep
  is shown rather than dropped when the next set leaves it out.
- **Only turning reminders off cancels them.** While the tasks cannot be read
  (a loose file opened from the operating system, no workspace yet, an index
  still loading) the renderer sends nothing and the host keeps its set.
  On Windows and Linux the app stays in the tray after its last window closes
  while the tray is shown and a reminder is still to come.
- **Phones** (`packages/mobile/src/notifications.ts`): through
  `@capacitor/local-notifications`, so the operating system fires reminders
  with the app closed, and Android re-arms them after a restart. The renderer
  reaches the plugin by name and registers it under its published type, so a
  plugin release that changes the calls DocBlocks makes fails the typecheck.
  Android shows reminders with `ic_stat_docblocks` (the "D" as a silhouette).
  A tap that launches the app is held until the shell listens for it.
  On Android 14 and later exact alarms are off unless the person allows them,
  and the plugin then schedules inexact ones, which can arrive some minutes
  late. `verify-package.py` fails a store build that lacks the plugin or, on
  Android, `POST_NOTIFICATIONS`.
- **Limit:** a device reminds only about tasks it has seen. A task added on
  another device is reminded about after it syncs and DocBlocks next runs.

## Ask

- **A chat, not a search.** Every message reaches the model. Passages from the
  open workspace's notes (and knowledge catalogs) go with it as reference
  material when search by meaning finds any; with none, or none Gezel judges
  relevant, the model answers as any chat would. Notes are enrichment, never
  a gate. The last eight finished turns (8,000 characters at most, newest
  kept) go with each message. Only an answer that drew on sources has its
  details checked against them. Search by meaning being off, the model
  missing or the workspace switched off for AI answers is a notice above the
  chat, not a reason to disable it.
- **The Ask page** (`#<workspace>/:ask`, `Home/AskPage.tsx`) shows the saved
  chats beside the conversation; the side panel beside a document keeps them
  behind a **Chats** button, as the page does when it is narrow. Insert is
  hidden on the page, where there is no document to insert into.
- **Chats are Markdown files.** Each conversation is one file in the
  workspace's chats folder (`kind: "chats"`, `Chats/` by default, set up on
  the first answer), named for its first message. Each exchange is appended
  as it settles (an answer stopped part way too), so what the person writes
  in the file between exchanges stays:

  ```markdown
  ## You

  What did I decide about the hotel?

  ## AI

  The Panama Hotel.[^source-1]

  [^source-1]: [Trip notes](../Trips/Seattle.md), a note in this workspace.
  ```

  Only those two headings split turns: an answer's own `#`/`##` headings are
  written as `###`, and a message line that would read as a heading or a
  footnote is escaped (`core/src/folders/chats.ts`). Reopening a chat reads
  the footnotes back into numbered citations that open their notes
  (`Ai/ask-chats.ts`); a file with no `## You` opens as an ordinary note.

- **Session management** is file management: the list (newest first, from
  the index, `Ai/chat-folders.ts`) opens a chat to continue it, renames it
  (the file, through the file tree's rename) or deletes it (after asking).
  The file tree shows the same files.
- **Across workspaces.** The conversation belongs to the shell, so it keeps
  going when another workspace is opened, and goes on saving into the
  workspace it started in (opened for the write, as Home's ticks are).
  Passages come from the open workspace only; a cited note in another one
  says which workspace to open. Suggested edits are limited to the open
  workspace's notes (`AskActions.catalogId`).
- **Saved chats are never sources.** They hold the model's words, so Ask and
  every other AI action leave the chats folders out of the passages they
  send (`chatDocumentPaths`); an older DocBlocks, which does not know the
  kind, treats the folder as ordinary.
- **Task facts** (`Ai/task-context.ts`): every question carries today's date
  and the open, overdue, upcoming and recently finished tasks across
  workspaces, so "what is due this week?" is answered from data rather than
  from passages.
- **Suggestions** (`Ai/chat-actions.ts`, `Ai/AskProposals.tsx`): after an
  answer, "Suggest tasks and notes" asks the model for actions it can confirm:
  new tasks, new notes (into Unfiled) and lines for today's journal. After
  "Allow edits to cited notes" is ticked for the conversation, it may also
  propose changing a cited document's properties or adding to its end. Each
  suggestion is a card and nothing is written until it is confirmed; an edit
  needs its own click and is never part of "Do all". Each card starts once
  (`ProposalStore.claim`): one skipped, done or already running is passed
  over, by "Do all" too, and an edit card waits while edits are not allowed.
  Creating never replaces a document (a taken name gets a number). Before an
  edit, the document's text is kept as a version in its companion folder
  (`Home/keep-version.ts`), even where automatic versions are off, and the
  write is conditional, for the open document too: typing in the meantime
  makes the edit start again on the new text, once.
- **Why structured output and not tool calls.** Suggestions come back as one
  JSON value matching a schema (`responseFormat`). Tool calls are not carried
  by every layer yet (the AI wire types, the desktop Gezel connector and the
  phone SDK), while structured output already is. Only documents the answer
  cited can be edited: the notes behind the passages it marks with `[n]`, or
  all its passages when it marks none. The reply is checked before anything
  is shown: unknown kinds and other paths are dropped, and an empty or
  malformed field is no change, never a deletion (small models fill every
  field). Clearing a property is left to the properties row.

## From other apps (phones)

- **Android** accepts the share sheet (`ACTION_SEND`, `ACTION_SEND_MULTIPLE`)
  for text and Markdown. A shared link or passage becomes a note
  (`SharedNotes.java`: the subject becomes its heading and name, a bare link
  becomes an autolink), and a shared `.txt` file is kept as Markdown. A file
  name storage would refuse, or that would be hidden, is cleaned rather than
  kept. Up to eight items wait at once, files and texts together, which is
  what one batch to the page carries. One unreadable item no longer loses the
  others, a share that arrives while a batch is being taken is picked up
  right after it, and a share is not taken in twice when Android rebuilds the
  app or it is reopened from Recents.
- **Into the Unfiled drawer** (`DocBlocksShell/incoming-share.ts`): native
  intake on both phones writes to the device workspace's `Inbox/<id>/`. When
  there is a drawer to put it in, the document is filed there through the
  same create-only import as a drop, its Inbox copy is removed, and it opens
  in the drawer. The drawer is the open workspace's when it has one
  (`chooseUnfiledDrawer`); otherwise the only drawer among the device's other
  workspaces, which then opens. With two or more elsewhere the choice is left
  to the person and the document stays in the Inbox. A share that launched the
  app arrives before the index has found the markers, so drawers are taken
  from the workspaces' last digests, and used only while their marker is
  still there. Without a drawer, or on any failure, the document stays in the
  Inbox and opens as before.
- **What already waits in the Inbox** is offered to the open workspace's
  drawer, on Home and on the drawer's page ("Move them here", "Not now";
  `Home/PhoneInboxOffer.tsx`). Each document is offered once: "Not now", or a
  move that failed, leaves it in the Inbox folder and it is not offered
  again. The ones already offered are remembered on the device only. The
  listing takes one document from each share folder, up to 100 at a time.
- **iOS** handles "Open with" today. A share-sheet extension is a separate
  app target with its own App ID, provisioning profile and App Group, so it
  waits on that setup.

## Not built yet

- The iOS share extension.
- Choosing which drawer gets phone shares when several workspaces have one
  (the plan's per-device preference).

## Testing

- Core: `packages/core/test/properties.test.ts`, `folders.test.ts`,
  `workspace-index-properties.test.ts`, `workspace-index-folders.test.ts`,
  `host-notifications.test.ts`.
- React: `task-operations.test.ts`, `task-model.test.ts`, `page-actions.test.ts`,
  `shell-routes.test.ts`, `home-digest.test.ts`, `launch-view.test.ts`,
  `task-reminders.test.ts`, `task-context.test.ts`, `chat-actions.test.ts`,
  `ai-ask-panel.test.ts`, `incoming-share.test.ts`, `elsewhere-tasks.test.ts`,
  `new-document-gallery.test.ts`, `quick-jot.test.ts`,
  `quick-jot-model.test.ts`, `quick-jot-preferences.test.ts`, and the real
  live index in `live-index-engine.test.ts`.
- Desktop: `reminders.test.ts`, `workspace-watchers.test.ts`,
  `node-filesystem-v2-enumerate.test.ts`; end to end `e2e/reminders.spec.ts`
  and `host-api-contract.spec.ts`.
- Mobile: `notifications.test.ts`; Android `native/android/SharedNotesHarness.java`
  (run by `npm run mobile:test:android`).
- Site end to end: `e2e/home-and-tasks.spec.ts`, `e2e/adaptive-home.spec.ts`,
  `e2e/quick-jot.spec.ts`, `e2e/adaptive-quick-jot.spec.ts`.
