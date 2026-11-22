# sidebar-git-diff

**Beta · `0.5.0-beta.0` · OpenCode V2**

See which files are uncommitted in your Git worktree and which open OpenCode session last recorded an edit to each file.

- Click a session heading to collapse or reopen it. Groups start expanded.
- Click a filename to open OpenCode’s full-screen **Uncommitted** diff viewer. The white `[A]`, `[M]`, and `[D]` badges are not links.
- Files without a reliable match stay under **Unassigned**. A match identifies a recent recorded edit, not ownership of every line in the patch.

## Install

Requires the OpenCode V2 terminal UI. The beta targets OpenCode **2.3.2**. OpenCode V1 and the Desktop GUI are not supported.

Once the beta is published to npm, add it to the `plugins` list in your OpenCode `cli.json` (`~/.config/opencode/cli.json` by default). Keep any existing entries.

```json
{
  "plugins": ["sidebar-git-diff@beta"]
}
```

To use the beta before it is on npm, clone this repository and use the absolute path to the clone instead:

```json
{
  "plugins": ["/absolute/path/to/sidebar-git-diff"]
}
```

Use `/reload` in OpenCode. Open the session sidebar with the **Toggle sidebar** command if it is hidden. Remove any local copy of the original sidebar plugin from discovery before enabling this package, or both will render.

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
