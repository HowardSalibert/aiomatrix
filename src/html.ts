import { escapeHtml } from "./util.js";

/**
 * Tags Matrix clients are expected to render (`m.room.message` → `formatted_body`,
 * spec §"m.room.message msgtypes"). Anything outside this list is dropped.
 */
export const MATRIX_ALLOWED_TAGS = new Set([
  "font",
  "del",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "p",
  "a",
  "ul",
  "ol",
  "sup",
  "sub",
  "li",
  "b",
  "i",
  "u",
  "strong",
  "em",
  "s",
  "code",
  "hr",
  "br",
  "div",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "caption",
  "pre",
  "span",
  "img",
  "details",
  "summary",
]);

/** Void elements that must not get a closing tag. */
const VOID_TAGS = new Set(["br", "hr", "img"]);

/** Attributes allowed per tag, mirroring the spec's permitted attributes. */
const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  font: new Set(["data-mx-bg-color", "data-mx-color", "color"]),
  span: new Set([
    "data-mx-bg-color",
    "data-mx-color",
    "data-mx-spoiler",
    "data-mx-maths",
    "data-msc4286-external-payment-details",
  ]),
  a: new Set(["name", "target", "href"]),
  img: new Set(["width", "height", "alt", "title", "src"]),
  ol: new Set(["start"]),
  code: new Set(["class"]),
  div: new Set(["data-mx-maths"]),
};

/** URL schemes permitted in `href`. */
const ALLOWED_HREF_SCHEMES = new Set([
  "http:",
  "https:",
  "ftp:",
  "mailto:",
  "magnet:",
  "matrix:",
]);

export interface SanitizeOptions {
  /** Additional tags to permit. */
  extraTags?: string[];
  /** Drop `img` tags entirely (some hosts do not want remote media loads). */
  allowImages?: boolean;
  /** Maximum nesting depth before the rest is flattened. Default 100. */
  maxDepth?: number;
  /** Truncate the result to this many characters. */
  maxLength?: number;
}

interface Token {
  kind: "text" | "open" | "close";
  raw: string;
  tag?: string;
  attributes?: string;
  selfClosing?: boolean;
}

const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: "text", raw: html.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    const tag = (match[1] ?? "").toLowerCase();
    const attributes = match[2] ?? "";
    if (raw.startsWith("</")) {
      tokens.push({ kind: "close", raw, tag });
    } else {
      tokens.push({
        kind: "open",
        raw,
        tag,
        attributes,
        selfClosing: raw.endsWith("/>") || VOID_TAGS.has(tag),
      });
    }
    lastIndex = TAG_RE.lastIndex;
  }
  if (lastIndex < html.length) {
    tokens.push({ kind: "text", raw: html.slice(lastIndex) });
  }
  return tokens;
}

const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function sanitizeAttributes(tag: string, raw: string, options: SanitizeOptions): string {
  const allowed = ALLOWED_ATTRIBUTES[tag];
  if (!allowed) return "";
  const out: string[] = [];
  ATTRIBUTE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE_RE.exec(raw)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    if (!allowed.has(name)) continue;
    const value = match[3] ?? match[4] ?? match[5] ?? "";
    const decoded = decodeAttributeValue(value);
    if (name === "href" && !isSafeUrl(decoded, ALLOWED_HREF_SCHEMES)) continue;
    if (name === "src") {
      // Only `mxc://` is allowed by the spec, and it is the only scheme that
      // cannot phone home to a third party from a client.
      if (!decoded.toLowerCase().startsWith("mxc://")) continue;
      if (options.allowImages === false) continue;
    }
    if (name === "class" && tag === "code" && !/^language-[\w+-]+$/.test(decoded)) continue;
    out.push(`${name}="${escapeHtml(decoded)}"`);
  }
  return out.length > 0 ? ` ${out.join(" ")}` : "";
}

function decodeAttributeValue(value: string): string {
  return value
    .replace(/&#(\d+);?/g, (_, code: string) => codePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);?/g, (_, code: string) => codePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .trim();
}

function codePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function isSafeUrl(url: string, schemes: Set<string>): boolean {
  const trimmed = url.trim().replace(/[\u0000-\u0020]/g, "");
  if (!trimmed) return false;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return true;
  try {
    return schemes.has(new URL(trimmed).protocol.toLowerCase());
  } catch {
    // Relative URLs without a scheme are fine; anything with a colon is not.
    return !trimmed.includes(":");
  }
}

/**
 * Sanitize HTML for a Matrix `formatted_body`.
 *
 * This library never renders HTML itself, but Matrix clients do — so any markup
 * built from untrusted input (user names, external APIs, mini app payloads) must
 * pass through here. Unknown tags are dropped, their text content is kept, and
 * `javascript:`/`data:` URLs and event handlers never survive.
 */
export function sanitizeMatrixHtml(html: string, options: SanitizeOptions = {}): string {
  const allowed = new Set(MATRIX_ALLOWED_TAGS);
  for (const tag of options.extraTags ?? []) allowed.add(tag.toLowerCase());
  if (options.allowImages === false) allowed.delete("img");

  const maxDepth = options.maxDepth ?? 100;
  const out: string[] = [];
  const open: string[] = [];
  // Content inside these is discarded outright, not just unwrapped.
  let suppressDepth = 0;
  let suppressTag = "";

  for (const token of tokenize(html)) {
    if (suppressDepth > 0) {
      if (token.kind === "open" && token.tag === suppressTag && !token.selfClosing) {
        suppressDepth += 1;
      } else if (token.kind === "close" && token.tag === suppressTag) {
        suppressDepth -= 1;
        if (suppressDepth === 0) suppressTag = "";
      }
      continue;
    }

    if (token.kind === "text") {
      out.push(escapeText(token.raw));
      continue;
    }

    const tag = token.tag ?? "";
    if (token.kind === "open") {
      if (tag === "script" || tag === "style" || tag === "iframe" || tag === "object") {
        if (!token.selfClosing) {
          suppressDepth = 1;
          suppressTag = tag;
        }
        continue;
      }
      if (!allowed.has(tag)) continue;
      if (open.length >= maxDepth) continue;
      const attributes = sanitizeAttributes(tag, token.attributes ?? "", options);
      if (token.selfClosing || VOID_TAGS.has(tag)) {
        out.push(`<${tag}${attributes}>`);
      } else {
        out.push(`<${tag}${attributes}>`);
        open.push(tag);
      }
      continue;
    }

    // close
    if (!allowed.has(tag) || VOID_TAGS.has(tag)) continue;
    const index = open.lastIndexOf(tag);
    if (index === -1) continue;
    // Close everything opened after the matched tag so the output stays balanced.
    for (let i = open.length - 1; i >= index; i -= 1) {
      out.push(`</${open[i]}>`);
    }
    open.length = index;
  }

  for (let i = open.length - 1; i >= 0; i -= 1) out.push(`</${open[i]}>`);

  const result = out.join("");
  if (options.maxLength !== undefined && result.length > options.maxLength) {
    return result.slice(0, options.maxLength);
  }
  return result;
}

/** Escape a text run while keeping already-valid character references intact. */
function escapeText(text: string): string {
  return text
    .replace(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Small tagged-template helper that escapes every interpolated value. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    out += escapeHtml(String(values[i] ?? "")) + (strings[i + 1] ?? "");
  }
  return out;
}

/**
 * Lightweight Markdown → Matrix HTML for `answer` / `reply` with
 * `parseMode: "markdown"`.
 *
 * Supports `**bold**`, `*italic*` / `_italic_`, `` `code` ``, fenced code
 * blocks, and `[label](https://…)` links. Not a full CommonMark parser —
 * enough for bot copy without dragging a dependency.
 */
export function markdownToHtml(text: string): string {
  if (!text) return "";
  const fences: string[] = [];
  const inlines: string[] = [];
  let work = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const i = fences.length;
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    fences.push(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000F${i}\u0000`;
  });
  work = work.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    const i = inlines.length;
    inlines.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000C${i}\u0000`;
  });
  work = escapeHtml(work);
  work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
    isSafeUrl(url, ALLOWED_HREF_SCHEMES)
      ? `<a href="${escapeHtml(url)}">${label}</a>`
      : label,
  );
  work = work.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Avoid lookbehind for broader TS targets: skip asterisks that are part of **.
  work = work.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, "$1<em>$2</em>$3");
  work = work.replace(/(^|[^_])_([^_\n]+)_([^_]|$)/g, "$1<em>$2</em>$3");
  work = work.replace(/\u0000C(\d+)\u0000/g, (_m, i) => inlines[Number(i)] ?? "");
  work = work.replace(/\u0000F(\d+)\u0000/g, (_m, i) => fences[Number(i)] ?? "");
  const blocks = work.split(/\n{2,}/).map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("<pre>")) return trimmed;
    return `<p>${trimmed.replace(/\n/g, "<br/>")}</p>`;
  });
  return blocks.filter(Boolean).join("");
}

/** Formatting helpers for building `formatted_body` safely. */
export const fmt = {
  bold: (text: string): string => `<strong>${escapeHtml(text)}</strong>`,
  italic: (text: string): string => `<em>${escapeHtml(text)}</em>`,
  strike: (text: string): string => `<del>${escapeHtml(text)}</del>`,
  underline: (text: string): string => `<u>${escapeHtml(text)}</u>`,
  code: (text: string): string => `<code>${escapeHtml(text)}</code>`,
  codeBlock: (text: string, language?: string): string =>
    language
      ? `<pre><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre>`
      : `<pre><code>${escapeHtml(text)}</code></pre>`,
  spoiler: (text: string, reason?: string): string =>
    reason
      ? `<span data-mx-spoiler="${escapeHtml(reason)}">${escapeHtml(text)}</span>`
      : `<span data-mx-spoiler>${escapeHtml(text)}</span>`,
  quote: (text: string): string => `<blockquote>${escapeHtml(text)}</blockquote>`,
  link: (label: string, url: string): string =>
    isSafeUrl(url, ALLOWED_HREF_SCHEMES)
      ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`
      : escapeHtml(label),
  /** matrix.to pill for a user. */
  userPill: (userId: string, displayName?: string): string =>
    `<a href="https://matrix.to/#/${encodeURIComponent(userId)}">${escapeHtml(displayName ?? userId)}</a>`,
  /** matrix.to pill for a room id or alias. */
  roomPill: (roomIdOrAlias: string, label?: string): string =>
    `<a href="https://matrix.to/#/${encodeURIComponent(roomIdOrAlias)}">${escapeHtml(label ?? roomIdOrAlias)}</a>`,
  list: (items: string[], ordered = false): string => {
    const tag = ordered ? "ol" : "ul";
    return `<${tag}>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</${tag}>`;
  },
  escape: escapeHtml,
};
