import { test, expect } from "bun:test"

const model = "glm-5"
const request = { model, output_config: { effort: "high" }, messages: [{ role: "user", content: "hi" }] }
const account = { accountId: "account-a", uid: "enterprise" }
const credentials = { token: "t", tokenType: "SSO_OIDC", idc: true, profile: "arn:aws:codewhisperer:us-east-1:1:profile/P", region: "us-east-1" }

function answer() {
  const header = Buffer.concat(Object.entries({ ":message-type": "event", ":event-type": "assistantResponseEvent" }).map(([key, value]) =>
    Buffer.concat([Buffer.from([Buffer.byteLength(key)]), Buffer.from(key), Buffer.from([7, 0, Buffer.byteLength(value)]), Buffer.from(value)])))
  const payload = Buffer.from(JSON.stringify({ content: "OK" }))
  const frame = Buffer.alloc(16 + header.length + payload.length)
  frame.writeUInt32BE(frame.length, 0)
  frame.writeUInt32BE(header.length, 4)
  header.copy(frame, 12)
  payload.copy(frame, 12 + header.length)
  return new Response(frame)
}

async function setup(name, catalogResponse) {
  const { _internal } = await import(`./index.mjs?catalog-${name}`)
  const originalFetch = globalThis.fetch
  const reads = [], calls = [], statuses = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === "/List-Available-Models") {
      reads.push(url)
      return catalogResponse()
    }
    if (url.pathname === "/featureConfiguration") return Response.json({})
    if (url.pathname !== "/generateAssistantResponse") throw new Error("unexpected " + url.pathname)
    calls.push(JSON.parse(init.body))
    const status = statuses.shift()
    return status ? new Response("expired", { status }) : answer()
  }
  return { reads, calls, statuses, generate: _internal.generate, restore: () => { globalThis.fetch = originalFetch } }
}

for (const kind of ["http-error", "empty"]) {
  test(`an optional catalog ${kind} still sends the chat request`, async () => {
    const s = await setup(kind, () => kind === "http-error" ? Response.json({ message: "Internal Server Error" }, { status: 500 }) : Response.json({ models: [] }))
    try {
      const res = await s.generate(async () => credentials, account, { ...request, model: "deepseek-3.2" }, undefined, "session")
      expect(res.status).toBe(200)
      expect((await res.json()).content).toEqual([{ type: "text", text: "OK" }])
      expect(s.reads).toHaveLength(1)
      expect(s.calls).toHaveLength(1)
      expect(s.calls[0].additionalModelRequestFields).toBeUndefined()
    } finally {
      s.restore()
    }
  })
}

test("an unlisted model shares one catalog lookup across consecutive requests", async () => {
  const s = await setup("absent", () => Response.json({ models: [{ modelId: "claude-sonnet-4.5" }] }))
  try {
    for (let i = 0; i < 3; i++) {
      const res = await s.generate(async () => credentials, account, request, undefined, "session")
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(s.reads).toHaveLength(1)
    expect(s.calls).toHaveLength(3)
  } finally {
    s.restore()
  }
})

test("concurrent requests share one optional catalog lookup", async () => {
  let release, started
  const pending = new Promise(resolve => { release = resolve })
  const reading = new Promise(resolve => { started = resolve })
  const s = await setup("concurrent", () => { started(); return pending })
  try {
    const requests = Array.from({ length: 3 }, () => s.generate(async () => credentials, account, request, undefined, "session"))
    await reading
    expect(s.calls).toHaveLength(0)
    release(Response.json({ models: [{ modelId: "claude-sonnet-4.5" }] }))
    for (const res of await Promise.all(requests)) {
      expect(res.status).toBe(200)
      await res.text()
    }
    expect(s.reads).toHaveLength(1)
    expect(s.calls).toHaveLength(3)
  } finally {
    s.restore()
  }
})

test("failed catalog lookups expire and are separate for each account and region", async () => {
  const originalNow = Date.now
  let now = Date.now()
  Date.now = () => now
  const s = await setup("scope", () => Response.json({ message: "Internal Server Error" }, { status: 500 }))
  const call = async (owner, a) => {
    const res = await s.generate(async () => a, owner, request, undefined, "session")
    expect(res.status).toBe(200)
    await res.text()
  }
  try {
    await call(account, credentials)
    await call(account, { ...credentials, token: "refreshed" })
    expect(s.reads).toHaveLength(1)
    await call({ ...account, accountId: "account-b" }, credentials)
    await call(account, { ...credentials, region: "eu-central-1", profile: "arn:aws:codewhisperer:eu-central-1:1:profile/P" })
    expect(s.reads).toHaveLength(3)
    now += 10 * 60 * 1000 + 1
    await call(account, credentials)
    expect(s.reads).toHaveLength(4)
  } finally {
    Date.now = originalNow
    s.restore()
  }
})

test("a token refresh keeps the failed catalog lookup cached", async () => {
  const s = await setup("refresh", () => Response.json({ message: "Internal Server Error" }, { status: 500 }))
  s.statuses.push(403)
  try {
    const res = await s.generate(async (_, stale) => ({ ...credentials, token: stale ? "refreshed" : "t" }), account, request, undefined, "session")
    expect(res.status).toBe(200)
    expect((await res.json()).content).toEqual([{ type: "text", text: "OK" }])
    expect(s.reads).toHaveLength(1)
    expect(s.calls).toHaveLength(2)
  } finally {
    s.restore()
  }
})
