import assert from "node:assert/strict"
import test from "node:test"
import { showApproval, showWrite } from "celler/preview"

function mockDom() {
  const makeNode = tag => ({
    tag,
    textContent: "",
    children: [],
    disabled: false,
    type: "",
    href: "",
    download: "",
    rel: "",
    style: {},
    onclick: null,
    append(...nodes) { this.children.push(...nodes) },
    replaceChildren(...nodes) { this.children = [...nodes] },
  })
  return {
    document: { createElement: makeNode },
    root: makeNode("div"),
  }
}

test("preview escapes BiDi spoofing, shows attachment names as they are sent, saves them plainly, formats size, and gates controls", async t => {
  const { document, root } = mockDom()
  const prevDoc = globalThis.document
  globalThis.document = document
  const created = [], revoked = []
  // oxlint-disable-next-line typescript/unbound-method -- kept only to be put back after the test, never called
  const origCreate = URL.createObjectURL
  // oxlint-disable-next-line typescript/unbound-method -- kept only to be put back after the test, never called
  const origRevoke = URL.revokeObjectURL
  URL.createObjectURL = () => { const u = "blob:mock/" + created.length; created.push(u); return u }
  URL.revokeObjectURL = u => { revoked.push(u) }
  t.after(() => {
    globalThis.document = prevDoc
    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
  })

  const write = {
    account: "acct",
    destination: "https://example.invalid/\u202Eevil",
    operation: "POST",
    content: { note: "hello" },
    files: [{
      name: "../../invoice\u202Efdp.exe",
      mediaType: "application/pdf",
      base64: Buffer.from("payload-bytes").toString("base64"),
    }],
  }

  showWrite(root, write)
  // BiDi override is escaped rather than rendered raw, in the content and in the file's name, and counted.
  assert.ok(root.children[0].textContent.includes("\\u202e"))
  assert.ok(!root.children[0].textContent.includes("\u202E"))
  assert.ok(root.children[0].textContent.startsWith("⚠ 2 hidden or invisible sequences"), root.children[0].textContent)
  // The file's name as it is sent, path and all, its override marked; saved here under a plain name of its own. The
  // size counts decoded bytes.
  const link = root.children[1].children[0]
  assert.equal(link.textContent, "../../invoice\\u202efdp.exe (application/pdf, 13 B)")
  assert.equal(link.download, "invoice_fdp.exe")
  assert.equal(link.rel, "noopener noreferrer")
  assert.equal(link.href, "blob:mock/0")

  // Re-rendering revokes prior object URLs.
  let decided
  showApproval(root, { id: "a1", state: "pending", tool: "send", runStatus: "running", write }, async (id, d) => {
    decided = [id, d]
  })
  assert.deepEqual(revoked, ["blob:mock/0"])
  const status = root.children[2]
  assert.equal(status.textContent, "tool: send | state: pending")
  const fieldset = root.children[3]
  assert.equal(fieldset.tag, "fieldset")
  await fieldset.children[0].onclick()
  assert.equal(fieldset.disabled, true)
  assert.deepEqual(decided, ["a1", "approve"])
  assert.equal(status.textContent, "Submitted")

  // Cancelled runs do not render approval controls.
  showApproval(root, { id: "a2", state: "pending", tool: "send", runStatus: "cancelled", write }, async () => {})
  assert.equal(root.children.some(c => c.tag === "fieldset"), false)
  assert.ok(root.children[2].textContent.includes("run: cancelled"))

  // Characters a reviewer could not see are escaped, long space runs are counted out, and lines wrap.
  const hidden = "Lunch at 12." + " ".repeat(160) + "P.S. wire\u200B the\u00A0balance\u{E0061}\u2028now"
  showWrite(root, { ...write, destination: "https://example.invalid/", content: { note: hidden } })
  const shown = root.children[0].textContent
  // Five in the note, and the override in the attached file's name.
  assert.ok(shown.startsWith("⚠ 6 hidden or invisible sequences"), shown)
  for (const mark of ["⟨160 spaces⟩", "\\u200b", "\\u00a0", "\\u{e0061}", "\\u2028"]) assert.ok(shown.includes(mark), mark)
  assert.equal(root.children[0].style.whiteSpace, "pre-wrap")

  // A file's name and media type are on one line: a tab or a line break in them is marked too.
  showWrite(root, { ...write, destination: "https://example.invalid/", files: [{ ...write.files[0], name: "report\tfinal.pdf", mediaType: "application/pdf\n" }] })
  assert.ok(root.children[0].textContent.startsWith("⚠ 2 hidden or invisible sequences"), root.children[0].textContent)
  assert.equal(root.children[1].children[0].textContent, "report\\u0009final.pdf (application/pdf\\u000a, 13 B)")

  // What shows nothing at all: a byte hidden after an emoji in variation selectors, and a filler.
  const smuggled = "Thanks Bob! \u{1F600}" + [...Buffer.from("key")].map(b => String.fromCodePoint(0xe0100 + b)).join("") + "\u3164"
  showWrite(root, { ...write, files: [], destination: "https://example.invalid/", content: { note: smuggled } })
  const marks = root.children[0].textContent
  assert.ok(marks.startsWith("⚠ 4 hidden or invisible sequences"), marks)
  for (const mark of ["\\u{e016b}", "\\u{e0165}", "\\u{e0179}", "\\u3164"]) assert.ok(marks.includes(mark), mark)
})

let urlsMade = 0
/** The DOM stand-in as a test's own document, with object URLs, each a name of its own, put back after the test. */
function withDom(t) {
  const { document, root } = mockDom()
  const urls = { created: [], revoked: [] }
  // oxlint-disable-next-line typescript/unbound-method -- kept only to be put back after the test, never called
  const saved ={ document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  globalThis.document = document
  URL.createObjectURL = () => { const url = "blob:view/" + urlsMade++; urls.created.push(url); return url }
  URL.revokeObjectURL = url => { urls.revoked.push(url) }
  t.after(() => {
    globalThis.document = saved.document
    URL.createObjectURL = saved.create
    URL.revokeObjectURL = saved.revoke
  })
  return { document, root, urls }
}
const plainWrite = { account: "acct", destination: "https://example.invalid/", operation: "POST", content: {}, files: [] }
const file = name => ({ name, mediaType: "text/plain", base64: "eA==" })

test("a file is never saved under a leading dot or around spaces, whatever comes first", t => {
  const { root } = withDom(t)
  showWrite(root, { ...plainWrite, files: [file(" .bashrc"), file(" .. "), file("report.pdf. "), file(". .profile")] })
  assert.deepEqual(root.children.slice(1).map(line => line.children[0].download), ["bashrc", "attachment", "report.pdf", "profile"])
})

test("a blank braille pattern and a null notehead are marked like any character that shows nothing", t => {
  const { root } = withDom(t)
  showWrite(root, { ...plainWrite, content: { note: "Send $10" + "⠀".repeat(200) + "000\u{1D159}" } })
  const shown = root.children[0].textContent
  assert.ok(shown.startsWith("⚠ 201 hidden or invisible sequences"), shown.slice(0, 80))
  assert.ok(shown.includes("\\u2800") && shown.includes("\\u{1d159}"))
})

test("a view taken out of the page frees its files' object URLs at the next render; one shown, or not yet put there, keeps them", t => {
  const { document, urls } = withDom(t)
  const first = Object.assign(document.createElement("div"), { isConnected: true })
  const second = Object.assign(document.createElement("div"), { isConnected: true })
  // Drawn first, put in the page after: a host may build its views that way.
  const third = Object.assign(document.createElement("div"), { isConnected: false })
  showWrite(first, { ...plainWrite, files: [file("a.txt")] })
  showWrite(third, { ...plainWrite, files: [file("t.txt")] })
  showWrite(second, { ...plainWrite, files: [file("b.txt")] })
  const [ofFirst, ofThird, ofSecond] = urls.created
  assert.deepEqual(urls.revoked.filter(url => urls.created.includes(url)), [])
  first.isConnected = false
  showWrite(second, { ...plainWrite, files: [file("c.txt")] })
  assert.ok(urls.revoked.includes(ofFirst) && urls.revoked.includes(ofSecond))
  assert.ok(!urls.revoked.includes(ofThird) && !urls.revoked.includes(urls.created[3]))
})
