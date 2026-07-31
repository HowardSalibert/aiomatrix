import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MEDIA_LIMIT_BYTES,
  MatrixHttp,
  MediaTooLargeError,
  buildEncryptedFileBlock,
  buildMediaInfo,
  createDefaultLogger,
  downloadMedia,
  downloadThumbnail,
  guessMimeType,
  msgtypeForMime,
  parseMxcUri,
  readAttachmentFromContent,
  splitEncryptedFileBlock,
  uploadMedia,
} from "../dist/index.js";

function httpFor(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(String(url));
    calls.push({ path: parsed.pathname, query: parsed.searchParams, init });
    const spec = (await handler(parsed, init, calls)) ?? { body: {} };
    return new Response(
      spec.bytes ?? (typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? {})),
      { status: spec.status ?? 200, headers: { "content-type": "application/json" } },
    );
  };
  return {
    calls,
    http: new MatrixHttp("https://hs.example.org", {
      accessToken: "tok",
      fetchImpl,
      retryBaseMs: 1,
      maxRetryDelayMs: 2,
      logger: createDefaultLogger("silent"),
    }),
  };
}

describe("parseMxcUri", () => {
  it("splits server and media id", () => {
    assert.deepEqual(parseMxcUri("mxc://example.org/abc123"), {
      serverName: "example.org",
      mediaId: "abc123",
    });
  });

  it("tolerates surrounding whitespace", () => {
    assert.ok(parseMxcUri("  mxc://example.org/abc  "));
  });

  it("rejects anything that is not a bare mxc URI", () => {
    assert.equal(parseMxcUri("https://example.org/abc"), null);
    assert.equal(parseMxcUri("mxc://example.org"), null);
    assert.equal(parseMxcUri("mxc:///abc"), null);
    assert.equal(parseMxcUri("mxc://example.org/abc/extra"), null);
    assert.equal(parseMxcUri("mxc://example.org/abc?x=1"), null);
  });
});

describe("mime helpers", () => {
  it("guesses from the extension, case-insensitively", () => {
    assert.equal(guessMimeType("photo.PNG"), "image/png");
    assert.equal(guessMimeType("clip.mp4"), "video/mp4");
    assert.equal(guessMimeType("report.docx").includes("wordprocessing"), true);
  });

  it("falls back for unknown or missing extensions", () => {
    assert.equal(guessMimeType("noext"), "application/octet-stream");
    assert.equal(guessMimeType("weird.qqq"), "application/octet-stream");
    assert.equal(guessMimeType("weird.qqq", "text/plain"), "text/plain");
  });

  it("maps mime to msgtype", () => {
    assert.equal(msgtypeForMime("image/png"), "m.image");
    assert.equal(msgtypeForMime("audio/ogg"), "m.audio");
    assert.equal(msgtypeForMime("video/mp4"), "m.video");
    assert.equal(msgtypeForMime("application/pdf"), "m.file");
  });
});

describe("uploadMedia", () => {
  it("posts raw bytes and returns the mxc URI", async () => {
    const { http, calls } = httpFor(() => ({ body: { content_uri: "mxc://hs/abc" } }));
    const result = await uploadMedia(http, new Uint8Array([1, 2, 3]), {
      filename: "a.png",
    });
    assert.equal(result.contentUri, "mxc://hs/abc");
    assert.equal(result.contentType, "image/png");
    assert.equal(result.sizeBytes, 3);
    assert.equal(calls[0].path, "/_matrix/media/v3/upload");
    assert.equal(calls[0].query.get("filename"), "a.png");
    assert.equal(calls[0].init.headers["Content-Type"], "image/png");
  });

  it("honours an explicit content type", async () => {
    const { http, calls } = httpFor(() => ({ body: { content_uri: "mxc://hs/abc" } }));
    await uploadMedia(http, new Uint8Array([1]), { contentType: "application/x-custom" });
    assert.equal(calls[0].init.headers["Content-Type"], "application/x-custom");
  });

  it("refuses payloads above the limit before hitting the network", async () => {
    const { http, calls } = httpFor(() => ({ body: { content_uri: "mxc://hs/abc" } }));
    await assert.rejects(
      uploadMedia(http, new Uint8Array(11), { maxBytes: 10 }),
      (err) => err instanceof MediaTooLargeError,
    );
    assert.equal(calls.length, 0);
  });

  it("fails loudly when the server omits content_uri", async () => {
    const { http } = httpFor(() => ({ body: {} }));
    await assert.rejects(uploadMedia(http, new Uint8Array([1])), /content_uri/);
  });

  it("defaults to a 100 MiB guard", () => {
    assert.equal(DEFAULT_MEDIA_LIMIT_BYTES, 100 * 1024 * 1024);
  });
});

describe("downloadMedia", () => {
  it("prefers the authenticated endpoint", async () => {
    const { http, calls } = httpFor(() => ({ bytes: "payload" }));
    const bytes = await downloadMedia(http, "mxc://example.org/abc");
    assert.equal(Buffer.from(bytes).toString(), "payload");
    assert.equal(calls[0].path, "/_matrix/client/v1/media/download/example.org/abc");
  });

  it("falls back to the legacy route on older homeservers", async () => {
    const { http, calls } = httpFor((url) =>
      url.pathname.startsWith("/_matrix/client/v1/media")
        ? { status: 404, body: { errcode: "M_UNRECOGNIZED" } }
        : { bytes: "legacy" },
    );
    const bytes = await downloadMedia(http, "mxc://example.org/abc");
    assert.equal(Buffer.from(bytes).toString(), "legacy");
    assert.equal(calls.at(-1).path, "/_matrix/media/v3/download/example.org/abc");
  });

  it("does not fall back when told not to", async () => {
    const { http } = httpFor(() => ({ status: 404, body: { errcode: "M_NOT_FOUND" } }));
    await assert.rejects(
      downloadMedia(http, "mxc://example.org/abc", { allowLegacyEndpoint: false }),
    );
  });

  it("does not fall back for unrelated errors", async () => {
    const { http, calls } = httpFor(() => ({ status: 403, body: { errcode: "M_FORBIDDEN" } }));
    await assert.rejects(downloadMedia(http, "mxc://example.org/abc"));
    assert.equal(calls.length, 1);
  });

  it("rejects a non-mxc URI without any request", async () => {
    const { http, calls } = httpFor(() => ({ bytes: "x" }));
    await assert.rejects(downloadMedia(http, "https://evil.example/x.png"), /mxc/);
    assert.equal(calls.length, 0);
  });

  it("enforces the size limit on the response", async () => {
    const { http } = httpFor(() => ({ bytes: "0123456789" }));
    await assert.rejects(
      downloadMedia(http, "mxc://example.org/abc", { maxBytes: 5 }),
      MediaTooLargeError,
    );
  });

  it("url-encodes hostile media ids", async () => {
    const { http, calls } = httpFor(() => ({ bytes: "x" }));
    await downloadMedia(http, "mxc://example.org/a b");
    assert.ok(!calls[0].path.includes(" "));
  });
});

describe("downloadThumbnail", () => {
  it("passes the requested geometry", async () => {
    const { http, calls } = httpFor(() => ({ bytes: "thumb" }));
    await downloadThumbnail(http, "mxc://example.org/abc", { width: 64, height: 48 });
    assert.equal(calls[0].path, "/_matrix/client/v1/media/thumbnail/example.org/abc");
    assert.equal(calls[0].query.get("width"), "64");
    assert.equal(calls[0].query.get("height"), "48");
    assert.equal(calls[0].query.get("method"), "scale");
  });

  it("supports crop and the legacy fallback", async () => {
    const { http, calls } = httpFor((url) =>
      url.pathname.startsWith("/_matrix/client/v1/media")
        ? { status: 404, body: { errcode: "M_UNRECOGNIZED" } }
        : { bytes: "legacy-thumb" },
    );
    const bytes = await downloadThumbnail(http, "mxc://example.org/abc", {
      width: 32,
      height: 32,
      method: "crop",
    });
    assert.equal(Buffer.from(bytes).toString(), "legacy-thumb");
    assert.equal(calls.at(-1).query.get("method"), "crop");
    assert.equal(calls.at(-1).query.get("allow_redirect"), "true");
  });
});

describe("encrypted attachments", () => {
  it("round-trips the EncryptedFile block", () => {
    const info = { key: { k: "secret" }, iv: "iv", hashes: { sha256: "h" }, v: "v2" };
    const block = buildEncryptedFileBlock(info, "mxc://hs/cipher");
    assert.equal(block.url, "mxc://hs/cipher");
    assert.deepEqual(splitEncryptedFileBlock(block), {
      url: "mxc://hs/cipher",
      encryptionInfo: info,
    });
  });

  it("returns null when the block has no url", () => {
    assert.equal(splitEncryptedFileBlock({ iv: "iv" }), null);
  });

  it("does not mutate the caller's info object", () => {
    const info = { iv: "iv" };
    const block = buildEncryptedFileBlock(info, "mxc://hs/c");
    splitEncryptedFileBlock(block);
    assert.equal(info.url, undefined);
  });
});

describe("buildMediaInfo", () => {
  it("includes only the dimensions it was given", () => {
    assert.deepEqual(buildMediaInfo({ mimetype: "image/png", sizeBytes: 10 }), {
      mimetype: "image/png",
      size: 10,
    });
    assert.deepEqual(
      buildMediaInfo({ mimetype: "video/mp4", sizeBytes: 20, width: 2, height: 3, durationMs: 4 }),
      { mimetype: "video/mp4", size: 20, w: 2, h: 3, duration: 4 },
    );
  });
});

describe("readAttachmentFromContent", () => {
  it("reads a plain image", () => {
    const attachment = readAttachmentFromContent({
      msgtype: "m.image",
      body: "cat.png",
      url: "mxc://hs/abc",
      info: { mimetype: "image/png", size: 100, w: 10, h: 20 },
    });
    assert.equal(attachment.url, "mxc://hs/abc");
    assert.equal(attachment.file, null);
    assert.equal(attachment.mimetype, "image/png");
    assert.equal(attachment.width, 10);
    assert.equal(attachment.height, 20);
    assert.equal(attachment.sizeBytes, 100);
  });

  it("reads an encrypted attachment", () => {
    const attachment = readAttachmentFromContent({
      msgtype: "m.file",
      body: "doc.pdf",
      file: { url: "mxc://hs/cipher", iv: "iv" },
      info: { mimetype: "application/pdf", size: 5 },
    });
    assert.equal(attachment.url, null);
    assert.equal(attachment.file.url, "mxc://hs/cipher");
  });

  it("ignores non-attachment messages", () => {
    assert.equal(readAttachmentFromContent({ msgtype: "m.text", body: "hi" }), null);
    assert.equal(readAttachmentFromContent({ body: "hi" }), null);
    assert.equal(readAttachmentFromContent(null), null);
  });

  it("survives a missing info block", () => {
    const attachment = readAttachmentFromContent({ msgtype: "m.audio", url: "mxc://hs/a" });
    assert.equal(attachment.body, "");
    assert.equal(attachment.mimetype, null);
    assert.equal(attachment.durationMs, null);
  });
});
