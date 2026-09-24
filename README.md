# agent-skills

My agent skills, installable as one Claude Code plugin or one skill at a time.

## Skills

### Engineering

- **[upload-image-to-github](docs/engineering/upload-image-to-github.md)**: Attach screenshots, GIFs, and screen recordings to GitHub PRs and issues, automatically shrinking anything over the 10 MB upload limit.

## Install

Claude Code, the whole set as one plugin:

```text
/plugin marketplace add sergnio/agent-skills
/plugin install sergnio-skills@sergnio
```

Codex, Cursor, Gemini CLI, OpenCode, and other agents, or Claude Code if you want editable copies:

```bash
npx skills add sergnio/agent-skills --skill <skill>
```

Pick one: installing both leaves you with every skill twice.

## Adding a skill

1. Create `skills/<category>/<name>/SKILL.md`, and `docs/<category>/<name>.md` for human-facing docs.
2. Add it to the `skills` array in `.claude-plugin/plugin.json`, the category's `README.md`, and the list above.
3. Bump `version` in `.claude-plugin/plugin.json` on every user-visible change, or installed copies will not update.
4. Run `claude plugin validate .` before pushing.

## License

MIT
