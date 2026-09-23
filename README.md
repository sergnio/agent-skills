# agent-skills

Agent skills and Claude Code plugins. Each plugin installs on its own.

| Plugin | What it does |
|---|---|
| [`upload-image-to-github`](plugins/upload-image-to-github) | Attach screenshots, GIFs, and screen recordings to GitHub PRs and issues, automatically shrinking anything over the 10 MB upload limit |

## Install

Claude Code:

```text
/plugin marketplace add sergnio/agent-skills
/plugin install <plugin>@sergnio
```

Codex, Cursor, Gemini CLI, OpenCode, and other agents:

```bash
npx skills add sergnio/agent-skills --skill <skill>
```

## Adding a plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json` and `plugins/<name>/skills/<name>/SKILL.md`.
2. List it in `.claude-plugin/marketplace.json` and in the table above.
3. Bump the plugin's `version` on every user-visible change, or installed copies will not update.
4. Run `claude plugin validate .` before pushing.

## License

MIT
