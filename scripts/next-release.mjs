import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const git = (...args) => execFileSync("git", args, { encoding: "utf8" })
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

// npm records the Git commit it packaged. Use that commit so skipped or failed runs do not lose changes.
function nextVersion({ version, gitHead }) {
  const core = typeof version === "string" ? version.replace(/-beta\.(?:0|[1-9]\d*)$/, "") : ""
  const published = core.match(stableVersion)
  if (!published || typeof gitHead !== "string" || !/^[0-9a-f]{40}$/.test(gitHead)) {
    throw new Error("npm latest must report a stable or beta version and a full Git commit in gitHead.")
  }

  const head = git("rev-parse", "HEAD").trim()
  const common = git("merge-base", gitHead, head).trim()
  // A rerun can target either the version already on npm or an older commit.
  if (common === head) return
  if (common !== gitHead) throw new Error("The published commit is not an ancestor of this commit.")

  const numbers = published.slice(1).map(BigInt)
  if (version !== core) {
    // Use the package version for the first stable release while latest still points to a beta.
    const { version: target } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    const stable = typeof target === "string" && target.match(stableVersion)
    if (!stable) throw new Error("package.json must declare a stable version for the first stable release.")
    const difference = stable.slice(1).map((part, index) => BigInt(part) - numbers[index]).find(Boolean)
    if ((difference ?? 0n) < 0n) {
      throw new Error("The first stable package version must be at or above the published beta's base version.")
    }
    return target
  }

  const messages = git("log", "-z", "--format=%B", `${gitHead}..${head}`).split("\0")
  const breaking = messages.some(
    (message) => /^[a-z][a-z0-9-]*(?:\([^)]+\))?!: /i.test(message) || /^BREAKING(?: |-)CHANGE: \S/m.test(message),
  )
  const feature = messages.some((message) => /^feat(?:\([^)]+\))?: /i.test(message))
  const [major, minor, patch] = numbers

  if (breaking) return `${major + 1n}.0.0`
  if (feature) return `${major}.${minor + 1n}.0`
  return `${major}.${minor}.${patch + 1n}`
}

try {
  const version = nextVersion(JSON.parse(readFileSync(0, "utf8")))
  if (version) console.log(version)
  else console.error("This commit is already included in the published release.")
} catch (error) {
  console.error(`Could not determine the next release version: ${error.message}`)
  process.exitCode = 1
}
