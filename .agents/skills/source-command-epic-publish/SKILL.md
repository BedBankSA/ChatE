---
name: "source-command-epic-publish"
description: "Publish a validated epic update back to the issue and local cache."
---

# source-command-epic-publish

Use this skill when the user asks to run the migrated source command `epic-publish`.

## Command Template

# /epic-publish

Publish a validated coordination update to GitHub.

```bash
node scripts/github-coordination.js publish <issue-number> --repo <owner/repo>
```

What this does:

1. Re-validates the epic before publishing.
2. Updates the coordination block in the issue body.
3. Appends a concise publish comment.
4. Records the final local snapshot.

Compatibility aliases:

- `/pr`
- `/prp-pr`
