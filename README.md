# ⛴ claude-ferry

Start in Claude Chat and finish in Claude Code, or go the other way.

```bash
npx claude-ferry in     # claude.ai chat → new Claude Code session, with the chat as real history
npx claude-ferry out    # Claude Code session → markdown on your clipboard, ready for claude.ai
```

## Chat → Code

1. <a name="bookmarklet"></a>Add the **⛴ Ferry** bookmarklet: drag the button from the [landing page](https://patrickballard.github.io/claude-ferry/) to your bookmarks bar. If you'd rather not drag, create a bookmark and paste the contents of [`docs/bookmarklet.txt`](docs/bookmarklet.txt) as its URL.
2. Open a chat on claude.ai and click **⛴ Ferry**. The conversation is copied to your clipboard. If clipboard access is blocked, it's saved as `~/Downloads/claude-ferry-*.json` instead.
3. In your project folder, run `npx claude-ferry in`.

Claude Code opens with the conversation as its own history. The chat is written as real session turns, so `/resume`, `/compact` and rewind all work. Ask it to "build what we discussed".

What carries over:
- every message, on the branch you're currently viewing (edits and retries you moved away from are left out)
- the full source of each artifact, as code blocks
- text from attached files, plus notes for images that couldn't be carried over
- web searches as one-liners with their source links

What doesn't: thinking blocks (they can't move between products) and images.

Flags: `--last <n>` keeps only the last n exchanges. `--no-launch` writes the session without starting `claude`.

**No bookmarklet?** Export your data from claude.ai (Settings → Privacy → Export data), then run `npx claude-ferry in conversations.json` and choose a chat.

## Code → Chat

From the folder you used Claude Code in, run `npx claude-ferry out`. Choose a session and it's copied as clean markdown: your prompts and Claude's replies, with system noise removed. History from before any compaction is recovered. Paste it into a new chat.

Flags:
- `--tools` adds one-line summaries of tool calls.
- `--last <n>` keeps only the last n exchanges.
- `--save file.md` also writes the markdown to a file.
- `--stdout` prints it instead of copying.
- You can also pass a session id or a path to a `.jsonl` file.

## Privacy

The bookmarklet runs only on claude.ai. It reads the chat through claude.ai's own API using your logged-in session, and copies it to your clipboard. The CLI writes one file to `~/.claude/projects/`. Nothing is sent anywhere else, and the tool has no dependencies.

## Caveats

This is unofficial and not affiliated with Anthropic. It relies on claude.ai's internal conversation API and Claude Code's session file format. Neither is a public contract, so either may change. If something breaks, please open an issue.

MIT
