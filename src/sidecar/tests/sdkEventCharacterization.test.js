const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const packageJson = require("../package.json")
const { normalizeAgentRuntimeEvent } = require("../dist/infrastructure/sdk/ClineSdkEventTranslator")

const fixtureRoot = path.join(__dirname, "..", "fixtures", "sdk-events")

test("bundled Cline SDK has a reviewed raw-to-domain event characterization fixture", () => {
	const declaredVersion = String(packageJson.dependencies["@cline/sdk"]).replace(/^[^0-9]*/, "")
	const fixturePath = path.join(fixtureRoot, `${declaredVersion}.json`)
	assert.equal(fs.existsSync(fixturePath), true, `Missing SDK characterization fixture: ${fixturePath}`)
	const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"))
	assert.equal(fixture.sdkVersion, declaredVersion)
	assert.equal(fixture.cases.length >= 4, true)
	for (const item of fixture.cases) {
		assert.deepEqual(normalizeAgentRuntimeEvent(item.input), item.expected, item.name)
	}
})
