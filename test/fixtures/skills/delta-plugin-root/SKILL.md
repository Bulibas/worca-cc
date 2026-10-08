---
name: delta-plugin-root
description: "Calls a helper that lives elsewhere in its plugin."
disable-model-invocation: true
shell: bash
hooks:
  PreToolUse:
    - matcher: Bash
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/helper` first.
