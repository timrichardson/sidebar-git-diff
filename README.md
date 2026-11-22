# sidebar-git-diff

**Beta · `0.5.0-beta.0` · OpenCode V2**

See which files are uncommitted in your Git worktree and which open OpenCode session last recorded an edit to each file.

## Install and update

The beta targets the **OpenCode 2.3.2 terminal UI**. OpenCode V1 and the Desktop GUI are not supported.

Add the plugin to `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json` if set), not `opencode.jsonc`. Keep any existing `plugins` entries. Use only one of the installation methods below. If you already use a local copy of the original sidebar plugin, disable or remove it from plugin discovery first to avoid a duplicate sidebar section.

### From GitHub (available now)

**Install:** Clone the repository. No npm install or build is needed.

```sh
git clone https://github.com/timrichardson/sidebar-git-diff.git "$HOME/sidebar-git-diff"
```

Add the absolute path to your clone to `plugins` in `cli.json`. Replace the example path with your own.

```json
{
  "plugins": ["/home/you/sidebar-git-diff"]
}
```

Run `/reload` in OpenCode.

**Update:** Pull the latest changes into the same clone. OpenCode does not pull GitHub changes for you.

```sh
git -C "$HOME/sidebar-git-diff" pull --ff-only
```

OpenCode watches the local plugin files and normally reloads them after the pull. If the sidebar does not refresh, run `/reload` in OpenCode.

### From npm (after the first beta is published)

**Install:** Add `sidebar-git-diff@beta` to `plugins` in `cli.json`. OpenCode downloads the package for you. Run `/reload` if the plugin does not appear after saving.

```json
{
  "plugins": ["sidebar-git-diff@beta"]
}
```

**Update:** The `beta` tag does not auto-update. Ask OpenCode to check for and install the newer beta:

```sh
opencode plugin update sidebar-git-diff@beta
```

After the update, open a fresh OpenCode terminal UI to load the new package. In OpenCode 2.3.2, `/reload` can leave the old package running in an open TUI. You do not need to restart the background service. See [OpenCode’s plugin update documentation](https://opencode.ai/docs/plugins#manage) for other version selectors.

## Use the sidebar

Open a session. If its sidebar is hidden, use the **Toggle sidebar** command.

- Click a session heading to collapse or reopen it. Groups start expanded.
- Click **Collapse all** or **Expand all** next to **Git changes** to update every listed session group. The same action is available in the command palette (`Ctrl+P` by default). **Unassigned** stays visible.
- Click a filename to open OpenCode’s full-screen **Uncommitted** diff viewer. The white `[A]`, `[M]`, and `[D]` badges are not links.
- Files without a reliable match stay under **Unassigned**. A match identifies a recent recorded edit, not ownership of every line in the patch.

If the sidebar contents do not fit vertically, OpenCode adds a scrollbar. Use the mouse wheel over the sidebar or drag the scrollbar to see the rest of the list.

## Attribution and diff behavior

The plugin reads Git status from the connected OpenCode server. It checks up to 30 open session tabs and up to 100 recent messages per session. It uses completed `write`, `edit`, and `patch` calls in the same worktree. Shell edits, external changes, edits outside the scanned history, and ties can remain unassigned. The sidebar indicates when history is partial.

The filename opens the native diff viewer, not a separate preview. OpenCode 2.3.2 does not expose initial file selection to plugins. Select the file in the viewer’s file tree. The viewer uses the session’s working directory, so open it from the worktree root to review files outside that directory. `Esc` returns to the session.

The plugin is read-only. It does not run Git commands, change files, or send data to a service other than the OpenCode server already connected to the TUI.

## Develop

Use Node.js 26.4 or later for the package checks.

```sh
npm ci --ignore-scripts
npm run check
```

OpenCode compiles the TSX entry point at load time. There is no separate build step. [`PROMPT.md`](PROMPT.md) is a standalone specification you can give to a model to recreate the plugin without the source.

## Publish a beta

GitHub Actions checks pull requests and pushes to `main` without publishing. The `release.yml` workflow publishes only when you push a tag that matches the beta version in `package.json`. It publishes under npm’s `beta` tag, not `latest`.

1. For a new npm package, an authorized maintainer must first publish from an authenticated npm account using `npm publish --access public --tag beta` after running `npm run check`. Do not push a publishing tag for a version already on npm.
2. In the npm package’s settings, add a **GitHub Actions** trusted publisher. Set the owner to `timrichardson`, repository to `sidebar-git-diff`, and workflow filename to `release.yml`. Enable `npm publish`. No GitHub npm token secret is needed.
3. For subsequent releases, update `package.json` and `package-lock.json` to a new beta version. Run `npm run check` and check the intended tag (for example, `npm run release:check -- v0.5.0-beta.1`). Commit and push the version update. Push the matching tag only when you intend to publish to npm.
