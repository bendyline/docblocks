/**
 * @bendyline/docblocks/folders — folders that say what they are for (a tasks
 * folder, a journal, the unfiled drawer, saved chats) through `.docblocks/folder.json`,
 * and the path rules each kind follows.
 */

export {
  DEFAULT_CHATS_FOLDER_NAME,
  DEFAULT_JOURNAL_FOLDER_NAME,
  DEFAULT_TASKS_DONE_FOLDER,
  DEFAULT_TASKS_FOLDER_NAME,
  DEFAULT_TASKS_OPEN_FOLDER,
  DEFAULT_UNFILED_FOLDER_NAME,
  FOLDER_KINDS,
  FOLDER_SETTINGS_FILE_NAME,
  FOLDER_SETTINGS_LIMITS,
  FOLDER_SETTINGS_VERSION,
  WORKSPACE_METADATA_DIRECTORY_NAME,
  checkBucketName,
  defaultFolderSettings,
  folderMetadataPath,
  folderOfSettingsPath,
  folderSettingsPath,
  parseFolderSettings,
  parseFolderSettingsText,
  sameBucketName,
  serializeFolderSettings,
  type FolderKind,
  type FolderSettings,
  type FolderSettingsParseResult,
  type TasksFolderSettings,
} from './folder-settings.js';
export {
  readFolderSettings,
  removeFolderSettings,
  writeFolderSettings,
  type FolderSettingsIO,
  type FolderSettingsReader,
  type FolderSettingsState,
  type FolderSettingsStatus,
} from './folder-store.js';
export {
  completedTaskPath,
  isDoneBucket,
  isTaskDone,
  newTaskPath,
  orderBuckets,
  placeTask,
  reopenedTaskPath,
  resolveTasksFolder,
  taskPathInBucket,
  type TaskPlacement,
  type TasksFolder,
} from './tasks.js';
export {
  findJournalEntry,
  journalDateFromPath,
  journalEntryHeading,
  journalEntryMarkdown,
  journalEntryPath,
} from './journal.js';
export {
  CHAT_ANSWER_HEADING,
  CHAT_QUESTION_HEADING,
  appendChatSection,
  chatSection,
  parseChatTranscript,
  type ChatTranscript,
  type ChatTranscriptTurn,
} from './chats.js';
export {
  fileStemForTitle,
  markdownFileNameForTitle,
  numberedFileName,
  titleOfFileName,
} from './names.js';
export {
  kindFolderFor,
  kindFoldersOf,
  locateTask,
  type KindFolder,
  type TaskLocation,
} from './kinds.js';
