// An assistant turn's reasoning goes back on
// assistantResponseMessage.reasoningContent, and a signature Kiro no longer
// takes is left out and the turn asked again.
import { test, expect } from "bun:test"
import { _internal } from "./index.mjs"

const { buildKiro, thinking, events, reply, withoutReasoning, generate, features } = _internal
const SIG = ".KTR~~eyJlbmNyeXB0aW9uUmVnaW9uIjpudWxsLCJtaW50ZWRBdE1zIjoxNzk0MDU1MjcyODg0fQ"

const body = (messages) => {
  const req = { model: "claude-opus-5.5", thinking: { type: "adaptive" }, messages }
  return JSON.parse(buildKiro(req, "claude-opus-5.5", "", thinking(req, "claude-opus-5.5")))
}

function frame(headers, payload) {
  const enc = new TextEncoder()
  const hs = []
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k)
    const val = enc.encode(v)
    const h = new Uint8Array(1 + name.length + 1 + 2 + val.length)
    h[0] = name.length
    h.set(name, 1)
    h[1 + name.length] = 7
    new DataView(h.buffer).setUint16(2 + name.length, val.length)
    h.set(val, 4 + name.length)
    hs.push(h)
  }
  const hlen = hs.reduce((n, h) => n + h.length, 0)
  const payloadBytes = enc.encode(JSON.stringify(payload))
  const total = 12 + hlen + payloadBytes.length + 4
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, total)
  v.setUint32(4, hlen)
  let i = 12
  for (const h of hs) {
    out.set(h, i)
    i += h.length
  }
  out.set(payloadBytes, i)
  return out
}

const stream = (...fs) =>
  new ReadableStream({
    start(c) {
      for (const f of fs) c.enqueue(f)
      c.close()
    },
  })

const ev = (type, payload) => frame({ ":message-type": "event", ":event-type": type }, payload)

test("an assistant turn's thinking goes back as the signature Kiro gave", () => {
  const b = body([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: SIG }, { type: "text", text: "ok" }] },
    { role: "user", content: "again" },
  ])
  expect(b.conversationState.history[1].assistantResponseMessage.reasoningContent).toEqual({ signature: SIG })
})

test("a redacted thinking block goes back as redactedContent", () => {
  const b = body([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "redacted_thinking", data: "REDACTED" }, { type: "text", text: "ok" }] },
    { role: "user", content: "again" },
  ])
  expect(b.conversationState.history[1].assistantResponseMessage.reasoningContent).toEqual({ redactedContent: "REDACTED" })
})

test("a thinking block with no signature of Kiro's goes without", () => {
  const b = body([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "" }, { type: "text", text: "ok" }] },
    { role: "user", content: "again" },
  ])
  expect(b.conversationState.history[1].assistantResponseMessage.reasoningContent).toBeUndefined()
})

test("a redactedContent event comes back as a redacted_thinking block", async () => {
  const answer = () =>
    stream(
      ev("assistantResponseEvent", { content: "OK", modelId: "auto" }),
      ev("reasoningContentEvent", { redactedContent: "REDACTED" }),
      ev("metadataEvent", { stopReason: "END_TURN" }),
    )
  const j = await (await reply(events(answer(), "auto", 0), "auto", false)).json()
  expect(j.content).toEqual([{ type: "text", text: "OK" }, { type: "redacted_thinking", data: "REDACTED" }])
  const out = await (await reply(events(answer(), "auto", 0), "auto", true)).text()
  expect(out).toContain(JSON.stringify({ type: "redacted_thinking", data: "REDACTED" }))
})

test("withoutReasoning leaves every assistant turn's reasoningContent out", () => {
  const b = JSON.stringify({
    conversationState: {
      history: [
        { userInputMessage: { content: "hi" } },
        { assistantResponseMessage: { content: "ok", reasoningContent: { signature: SIG } } },
      ],
      currentMessage: { userInputMessage: { content: "again" } },
    },
  })
  const out = JSON.parse(withoutReasoning(b))
  expect(out.conversationState.history[1].assistantResponseMessage.reasoningContent).toBeUndefined()
  expect(out.conversationState.history[1].assistantResponseMessage.content).toBe("ok")
})

test("THINKING_SIGNATURE_INVALID is asked again without the reasoning", async () => {
  const realFetch = globalThis.fetch
  const bodies = []
  features.clear()
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.pathname === "/featureConfiguration") return Response.json({})
    if (url.pathname === "/generateAssistantResponse") {
      bodies.push(JSON.parse(init.body))
      const frames = bodies.length === 1
        ? [ev("validationError", { message: "signature invalid", reason: "THINKING_SIGNATURE_INVALID" })]
        : [ev("assistantResponseEvent", { content: "hello", modelId: "auto" }), ev("metadataEvent", { stopReason: "END_TURN" })]
      return new Response(stream(...frames), { status: 200, headers: { "Content-Type": "application/vnd.amazon.eventstream" } })
    }
    throw new Error("unexpected " + url)
  }
  try {
    const res = await generate(
      async () => ({ token: "t", tokenType: "", idc: true, profile: "arn:aws:codewhisperer:us-east-1:1:profile/P", region: "us-east-1" }),
      {},
      {
        model: "claude-haiku-5.5",
        thinking: { type: "adaptive" },
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: SIG }, { type: "text", text: "ok" }] },
          { role: "user", content: "again" },
        ],
      },
      undefined,
      "s",
    )
    expect(res.status).toBe(200)
    expect((await res.json()).content).toEqual([{ type: "text", text: "hello" }])
    expect(bodies.length).toBe(2)
    expect(bodies[0].conversationState.history[1].assistantResponseMessage.reasoningContent).toEqual({ signature: SIG })
    expect(bodies[1].conversationState.history[1].assistantResponseMessage.reasoningContent).toBeUndefined()
  } finally {
    globalThis.fetch = realFetch
  }
})
