import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fmt, html, sanitizeMatrixHtml } from "../dist/index.js";

describe("sanitizeMatrixHtml", () => {
  it("keeps spec-allowed markup", () => {
    const out = sanitizeMatrixHtml("<p><strong>hi</strong> <em>there</em></p>");
    assert.equal(out, "<p><strong>hi</strong> <em>there</em></p>");
  });

  it("drops script tags and their contents", () => {
    const out = sanitizeMatrixHtml('<p>ok</p><script>alert("x")</script>');
    assert.equal(out, "<p>ok</p>");
  });

  it("drops style and iframe contents", () => {
    assert.equal(sanitizeMatrixHtml("<style>body{}</style>hi"), "hi");
    assert.equal(sanitizeMatrixHtml('<iframe src="https://evil"></iframe>hi'), "hi");
  });

  it("strips event handler attributes", () => {
    const out = sanitizeMatrixHtml('<p onclick="steal()">text</p>');
    assert.equal(out, "<p>text</p>");
  });

  it("removes javascript: and data: hrefs but keeps https", () => {
    assert.equal(sanitizeMatrixHtml('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");
    assert.equal(sanitizeMatrixHtml('<a href="data:text/html,<b>">x</a>'), "<a>x</a>");
    assert.equal(
      sanitizeMatrixHtml('<a href="https://example.org/">x</a>'),
      '<a href="https://example.org/">x</a>',
    );
    assert.equal(
      sanitizeMatrixHtml('<a href="matrix:u/alice:example.org">x</a>'),
      '<a href="matrix:u/alice:example.org">x</a>',
    );
  });

  it("defeats entity-encoded javascript URLs", () => {
    const out = sanitizeMatrixHtml('<a href="&#106;avascript:alert(1)">x</a>');
    assert.equal(out, "<a>x</a>");
  });

  it("only allows mxc: image sources", () => {
    assert.equal(
      sanitizeMatrixHtml('<img src="mxc://example.org/abc" alt="pic">'),
      '<img src="mxc://example.org/abc" alt="pic">',
    );
    assert.equal(sanitizeMatrixHtml('<img src="https://tracker.example/x.gif">'), "<img>");
  });

  it("unwraps unknown tags but keeps their text", () => {
    assert.equal(sanitizeMatrixHtml("<marquee>hello</marquee>"), "hello");
  });

  it("balances unclosed and mismatched tags", () => {
    assert.equal(sanitizeMatrixHtml("<p><em>oops"), "<p><em>oops</em></p>");
    assert.equal(sanitizeMatrixHtml("<b><i>x</b></i>"), "<b><i>x</i></b>");
  });

  it("escapes stray angle brackets and ampersands", () => {
    assert.equal(sanitizeMatrixHtml("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
    // Valid character references survive untouched.
    assert.equal(sanitizeMatrixHtml("&amp; &#65;"), "&amp; &#65;");
  });

  it("does not emit closing tags for void elements", () => {
    assert.equal(sanitizeMatrixHtml("line<br>next<hr/>"), "line<br>next<hr>");
  });

  it("honours allowImages: false and maxLength", () => {
    assert.equal(sanitizeMatrixHtml('<img src="mxc://a/b">x', { allowImages: false }), "x");
    assert.equal(sanitizeMatrixHtml("<p>abcdef</p>", { maxLength: 5 }), "<p>ab");
  });

  it("only allows language-* classes on code", () => {
    assert.equal(
      sanitizeMatrixHtml('<code class="language-ts">x</code>'),
      '<code class="language-ts">x</code>',
    );
    assert.equal(sanitizeMatrixHtml('<code class="evil">x</code>'), "<code>x</code>");
  });
});

describe("fmt and html helpers", () => {
  it("escapes interpolated values", () => {
    const name = '<img src=x onerror="alert(1)">';
    assert.equal(html`<p>${name}</p>`, "<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
  });

  it("builds safe rich text", () => {
    assert.equal(fmt.bold("a<b"), "<strong>a&lt;b</strong>");
    assert.equal(fmt.codeBlock("x", "python"), '<pre><code class="language-python">x</code></pre>');
    assert.equal(fmt.link("click", "javascript:alert(1)"), "click");
    assert.equal(
      fmt.userPill("@alice:example.org", "Alice"),
      '<a href="https://matrix.to/#/%40alice%3Aexample.org">Alice</a>',
    );
  });
});
