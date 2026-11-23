import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const git = (...args) => execFileSync("git", args, { encoding: "utf8" })

// npm records the Git commit it packaged. Use that commit so skipped or failed runs do not lose changes.
function nextVersion({ version, gitHead }) {
  const beta =
    typeof version === "string" && version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/)
  if (!beta || typeof gitHead !== "string" || !/^[0-9a-f]{40}$/.test(gitHead)) {
    throw new Error("The npm beta must report a beta version and full Git commit in gitHead.")
  }

  const head = git("rev-parse", "HEAD").trim()
  const common = git("merge-base", gitHead, head).trim()
  // A rerun can target either the version already on npm or an older commit.
  if (common === head) return
  if (common !== gitHead) throw new Error("The published beta commit is not an ancestor of this commit.")

  const messages = git("log", "-z", "--format=%B", `${gitHead}..${head}`).split("\0")
  const breaking = messages.some(
    (message) => /^[a-z][a-z0-9-]*(?:\([^)]+\))?!: /i.test(message) || /^BREAKING(?: |-)CHANGE: \S/m.test(message),
  )
  const feature = messages.some((message) => /^feat(?:\([^)]+\))?: /i.test(message))
  const [major, minor, patch] = beta.slice(1, 4).map(BigInt)

  if (breaking) return `${major + 1n}.0.0-beta.0`
  if (feature) return `${major}.${minor + 1n}.0-beta.0`
  return `${major}.${minor}.${patch + 1n}-beta.0`
}

try {
  const version = nextVersion(JSON.parse(readFileSync(0, "utf8")))
  if (version) console.log(version)
  else console.error("This commit is already included in the published beta.")
} catch (error) {
  console.error(`Could not determine the next beta version: ${error.message}`)
  process.exitCode = 1
}
