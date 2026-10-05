---
name: review
description: Review the diff of a Lookout chat. Use when the user wants to see what a Lookout agent changed, or before trusting a Lookout chat's edits.
---

# Review a Lookout chat

The diff comes from the chat's checkpoints, not from guessing which files it touched.

1. `lookout_changes` with the `threadId`. `scope` defaults to `chat` (everything that chat changed). Use `turn` plus `seq` for one turn, `since` for that turn through the files now, `uncommitted` for the workspace's own git.
2. Read the file stats first (`path`, `status`, `added`, `removed`). Open a hunk only when you need it. A huge diff returns `patchOmitted` and still has the stats: read those files in the workspace instead of asking for the whole patch again.
3. Report what changed in your own words, then anything that looks wrong. Do not revert unless the user asked. A revert is the Lookout app's review controls, not a `git checkout` you improvise.
4. If the chat is still `working`, say so and do not review a half-written tree. `lookout_check` with `waitSeconds: 600` waits it out.

`lookout_check` is the transcript. `lookout_changes` is the files. Use both when the user asked "what did it do", and only the diff when they asked "what did it change".
