# Recovering an incomplete first run

Hornbook preserves a folder with existing files. It does not fill missing samples into an existing journal automatically: missing lessons may have been deliberately deleted.

If startup reports that the configuration exists but all section folders are missing, an older first run may have stopped after saving only the configuration. This is also a valid deliberately emptied journal. Keep the folder and its configuration until you have checked it.

- To recover your own lessons, restore a known backup into a separate folder, then select that folder in Application settings → Change folder. Check its lessons before changing or deleting the original.
- To get fresh sample lessons, select a **new empty folder** with Change folder in the desktop application, or run `hornbook --journal <new-empty-folder>` from the installed command line. Hornbook seeds that new folder transactionally. The original folder stays intact.
- To continue with an empty journal, keep the current folder and add a lesson. No recovery is required if you intentionally removed its lesson folders.

Do not remove `journal.config.json` to force setup. If a nonempty folder has lost that file, restore its configuration from a backup. Corrupt configurations and files left by an interrupted transaction should be retained for diagnosis; do not delete recovery copies.

## Writer locks and interrupted transactions

Hornbook normally recovers `_transaction` automatically when opening the journal.
An existing `_write.lock` contains the writer's process ID. Hornbook keeps the
lock while that process is alive (or its status cannot be checked), and clears
it automatically when the operating system reports that the process has exited.
An unrelated process that has reused the same ID can also keep the lock busy.

An empty, malformed or unrecognized lock requires manual inspection. A crash
during lock recovery can also leave an empty `_write.reclaim` directory, which
blocks another recovery attempt. To recover either case:

1. Close every Hornbook window and stop all servers, imports and command-line
   jobs using this journal. Check that their processes have exited. If you cannot
   establish that no writer is using it, leave the lock in place.
2. Copy the **entire journal folder** to a separate backup, including hidden
   files, `_write.lock`, `_write.reclaim` and `_transaction` if present.
3. With all writers stopped, move `_write.lock` out of the active journal into
   that backup. Remove `_write.reclaim` only if it is an empty directory. If it
   contains files or either control path is a link, stop and inspect it.
4. Reopen the original journal once. Leave `_transaction` and its contents in
   place so Hornbook can finish recovery. If recovery still fails, keep both
   folders and the exact error for diagnosis; do not delete transaction backups.

## Deleted or replaced content

New lesson deletions, lesson edits and import replacements retain changed
original JSON and Markdown bytes in
`_trash/<timestamp>-<unique-id>/files/<section>/`. Deleting an empty section also
retains its files and the previous journal configuration. Each trash entry has
a `manifest.json` listing original paths. Retention commits with the change:
if creating the recovery copy fails, the deletion or replacement rolls back.
Earlier deletions cannot be recovered by this feature.

Replaced or removed backdrop images are retained in the same way, including
replacements that use the same filename. To restore one, select the saved image
from the trash entry in the pair's backdrop settings.

To restore a lesson, import its saved JSON through the normal lesson import
screen. Use **keep both** if a current lesson shares its slug and you want to
retain both versions; use **replace** to restore the old version in its place.
The current version is retained in a new trash entry when replacement changes
it. Hornbook regenerates Markdown and derived data from the imported JSON.

To restore a deleted section, first close all writers and back up the current
journal. Restore the section's files from the entry's `files/<section>/`
directory and merge only that section's entry from the saved configuration into
the current `journal.config.json`. The saved configuration is at
`_trash/<entry>/files/journal.config.json`. Do not replace the entire current configuration:
other pairs or settings may have changed since the deletion. Lesson deletions
made before deleting the section have their own trash entries.

Trash has no automatic expiry and no in-app trash browser yet. Include `_trash`
in folder backups; exported pair archives do not include it. After verifying a
backup, you can remove individual trash entries manually to reclaim disk space.

## A damaged lesson

The lesson list names files it cannot read and continues to show healthy
lessons. Vocabulary, cards and search are built from readable source lessons,
even if the stored derived cache is stale. The original damaged files and
learning history remain intact. With every lesson damaged, the list still
shows the affected filenames.

Copy the affected files to a separate backup before repairing them or moving
them out of the section. Reload the pair after repair. Lesson edits, deletions,
imports, full-pair exports and command-line rebuilds still require every source
lesson to validate; they fail explicitly rather than omit damaged content from
a write or backup. The lesson-list API accepts `?diagnostics=1` to return
`{ lessons, issues }`, including filenames and validation errors; the default
response remains the metadata array.
