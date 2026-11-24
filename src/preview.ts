import type { ApprovalState, RunStatus, Write } from './store.js';

// What a reviewer could not see: controls, format characters (bidi, zero-width, tag), private-use, unassigned and
// surrogate code points, separators, what Unicode says shows nothing at all (variation selectors, which can carry a
// byte each after any character, and fillers), and the symbols drawn blank: the empty braille cell and the null notehead.
const INVISIBLE = '[\\p{C}\\p{Z}\\p{Default_Ignorable_Code_Point}\\u2800\\u{1D159}]';
const invisibleBut = (shown: string) => new RegExp(`(?![${shown}])${INVISIBLE}`, 'gu');
// In the packet's content, laid out in lines, the plain space, tab, newline and carriage return show; in a file's name
// or media type, on one line, only the plain space does.
const HIDDEN = invisibleBut('\\t\\n\\r ');
const HIDDEN_IN_NAME = invisibleBut(' ');
// A long run of spaces after text can push the rest of a line out of view.
const LONG_SPACES = /(?<=\S) {16,}/g;
// Base64's characters, with its padding at the end only. Its length, a multiple of 4, is checked apart: a pattern that
// counted in fours would run out of stack on a large file.
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Each view's files' object URLs, and whether the view has been seen in the page: they are freed when it shows
// something else, or once it has been in the page and left it. One drawn before it is put in the page keeps them.
const views = new Map<HTMLElement, { urls: string[]; seen: boolean }>();

function escapeChar(ch: string): string {
  const code = ch.codePointAt(0)!;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : '\\u' + code.toString(16).padStart(4, '0');
}

/** Text with nothing left to hide: what `hidden` finds escaped, and long space runs counted out. */
function reveal(text: string, hidden = HIDDEN) {
  let marked = 0;
  const shown = text
    .replace(hidden, (ch) => (marked++, escapeChar(ch)))
    .replace(LONG_SPACES, (run) => (marked++, `⟨${run.length} spaces⟩`));
  return { shown, marked };
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // Its spaces and dots trimmed at the start, cut to a name's length, then trimmed at the end: each in one pass, however
  // long a run of them is.
  const cleaned = base
    .replace(HIDDEN_IN_NAME, '_')
    .replace(/^[ .]+/, '')
    .slice(0, 255)
    .replace(/[ .]+$/, '');
  return cleaned || 'attachment';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (value.length % 4 !== 0 || !BASE64.test(value)) throw new Error('Invalid base64 attachment payload');
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function revokeUrls(element: HTMLElement) {
  for (const url of views.get(element)?.urls ?? []) URL.revokeObjectURL(url);
  views.delete(element);
}

export function showWrite(element: HTMLElement, write: Write) {
  revokeUrls(element);
  for (const [view, shown] of views) {
    if (view.isConnected) shown.seen = true;
    else if (shown.seen) revokeUrls(view);
  }
  const { files, ...details } = write;
  // Each file as it is sent: its name and media type as they are, with what can't be seen marked too.
  const attachments = files.map((file) => ({
    file,
    name: reveal(file.name, HIDDEN_IN_NAME),
    mediaType: reveal(file.mediaType, HIDDEN_IN_NAME),
  }));
  const { shown, marked: inContent } = reveal(JSON.stringify(details, null, 2));
  const marked = attachments.reduce((sum, a) => sum + a.name.marked + a.mediaType.marked, inContent);
  const text = document.createElement('pre');
  // Wrap instead of scrolling, so no part of a line sits out of view.
  text.style.whiteSpace = 'pre-wrap';
  text.style.overflowWrap = 'anywhere';
  text.textContent = marked
    ? `⚠ ${marked} hidden or invisible sequence${marked === 1 ? '' : 's'} marked below.\n\n${shown}`
    : shown;
  element.replaceChildren(text);

  const createdUrls: string[] = [];
  for (const { file, name, mediaType } of attachments) {
    const bytes = decodeBase64(file.base64);
    const link = document.createElement('a');
    link.textContent = `${name.shown} (${mediaType.shown}, ${formatBytes(bytes.byteLength)})`;
    // Saved on this computer under a plain name of its own: no folder, nothing hidden, no leading dot.
    link.download = sanitizeFilename(file.name);
    link.rel = 'noopener noreferrer';
    // octet-stream, not the packet's own media type: a blob of HTML would run in this page's origin.
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      createdUrls.push(url);
      link.href = url;
    } else {
      link.href = 'data:application/octet-stream;base64,' + file.base64;
    }
    const line = document.createElement('p');
    line.append(link);
    element.append(line);
  }
  if (createdUrls.length) views.set(element, { urls: createdUrls, seen: element.isConnected });
}

export function showApproval(
  element: HTMLElement,
  item: { id: string; state: ApprovalState; tool?: string; runStatus?: RunStatus; write: Write },
  decide: (id: string, decision: 'approve' | 'decline') => Promise<void>,
) {
  showWrite(element, item.write);
  const status = document.createElement('p');
  const parts = [item.tool ? `tool: ${reveal(item.tool).shown}` : '', `state: ${item.state}`];
  if (item.runStatus && item.runStatus !== 'running') parts.push(`run: ${item.runStatus}`);
  status.textContent = parts.filter(Boolean).join(' | ');
  element.append(status);

  if (item.state !== 'pending') return;
  // A cancelled run's can't be sent, but it can be declined: it then leaves the inbox.
  const choices = item.runStatus === 'cancelled' ? (['decline'] as const) : (['approve', 'decline'] as const);
  const controls = document.createElement('fieldset');
  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = choice;
    button.onclick = async () => {
      controls.disabled = true;
      try {
        await decide(item.id, choice);
        status.textContent = choice === 'approve' ? 'Submitted' : 'Declined';
      } catch {
        // approve() can fail after the send was recorded, so never claim it failed.
        status.textContent = 'Refresh to check the recorded decision.';
      }
    };
    controls.append(button);
  }
  element.append(controls);
}
