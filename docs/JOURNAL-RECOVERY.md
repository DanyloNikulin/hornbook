# Recovering an incomplete first run

Hornbook preserves a folder with existing files. It does not fill missing samples into an existing journal automatically: missing lessons may have been deliberately deleted.

If startup reports that the configuration exists but all section folders are missing, an older first run may have stopped after saving only the configuration. This is also a valid deliberately emptied journal. Keep the folder and its configuration until you have checked it.

- To recover your own lessons, restore a known backup into a separate folder, then select that folder in Application settings → Change folder. Check its lessons before changing or deleting the original.
- To get fresh sample lessons, select a **new empty folder** with Change folder in the desktop application, or run `hornbook --journal <new-empty-folder>` from the installed command line. Hornbook seeds that new folder transactionally. The original folder stays intact.
- To continue with an empty journal, keep the current folder and add a lesson. No recovery is required if you intentionally removed its lesson folders.

Do not remove `journal.config.json` to force setup. If a nonempty folder has lost that file, restore its configuration from a backup. Corrupt configurations and files left by an interrupted transaction should be retained for diagnosis; do not delete recovery copies.
