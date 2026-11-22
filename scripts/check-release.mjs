import { readFileSync } from "node:fs"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const tag = process.argv[2]

if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version) || tag !== `v${version}`) {
  console.error(`Expected a beta package version and matching Git tag; got version ${version}, tag ${tag ?? "(missing)"}.`)
  process.exitCode = 1
}
