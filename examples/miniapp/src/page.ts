/**
 * The mini app page, inlined so the example stays a single dependency-free
 * process. In a real project this is your normal front-end build output.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Order form</title>
<script src="/matrix-miniapp.js"></script>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 20px 18px 96px;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg, Canvas); color: var(--fg, CanvasText);
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .who { color: color-mix(in srgb, CanvasText 55%, Canvas); margin: 0 0 20px; font-size: 13px; }
  fieldset { border: 0; padding: 0; margin: 0 0 18px; }
  label {
    display: flex; align-items: center; gap: 10px;
    padding: 11px 12px; margin-bottom: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 15%, Canvas);
    border-radius: 10px; cursor: pointer;
  }
  label:has(:checked) { border-color: currentColor; }
  input[type="text"] {
    width: 100%; box-sizing: border-box; padding: 11px 12px;
    border: 1px solid color-mix(in srgb, CanvasText 15%, Canvas);
    border-radius: 10px; font: inherit; background: transparent; color: inherit;
  }
  button {
    position: fixed; inset: auto 18px 18px; padding: 14px;
    font: 600 15px/1 inherit; border: 0; border-radius: 12px;
    background: CanvasText; color: Canvas; cursor: pointer;
  }
  button[disabled] { opacity: .5; cursor: default; }
  #status { margin-top: 16px; font-size: 13px; min-height: 1.5em; }
</style>
</head>
<body>
<h1>Order form</h1>
<p class="who" id="who">Checking your launch…</p>

<fieldset id="items">
  <label><input type="checkbox" value="coffee" /> Coffee</label>
  <label><input type="checkbox" value="tea" /> Tea</label>
  <label><input type="checkbox" value="cake" /> Cake</label>
</fieldset>

<input type="text" id="note" placeholder="Anything else?" />
<p id="status"></p>
<button id="submit" disabled>Submit</button>

<script>
(function () {
  var app = window.MatrixMiniApp;
  var who = document.getElementById("who");
  var status = document.getElementById("status");
  var submit = document.getElementById("submit");
  var token = null;

  if (!app) {
    who.textContent = "Open this from a Matrix client — the bridge is missing.";
    return;
  }

  app.ready();
  app.expand();

  // initDataUnsafe is fine for painting a name, never for authorization.
  var guess = app.initDataUnsafe && app.initDataUnsafe.user;
  if (guess) who.textContent = "Hi " + (guess.username || guess.id) + ", verifying…";

  // The backend is the only thing that can validate the signature.
  fetch("/api/miniapp/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: app.initData })
  })
    .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
    .then(function (out) {
      if (!out.ok || !out.body.token) {
        who.textContent = "Launch could not be verified: " + (out.body.error || "unknown");
        return;
      }
      token = out.body.token;
      var user = out.body.user || {};
      var room = out.body.room;
      who.textContent = "Verified " + (user.username || user.id) +
        (room && room.title ? " in " + room.title : "");
      submit.disabled = false;
    })
    .catch(function (err) {
      who.textContent = "Could not reach the backend: " + err.message;
    });

  submit.addEventListener("click", function () {
    if (!token) return;
    var items = [].slice
      .call(document.querySelectorAll("#items input:checked"))
      .map(function (input) { return input.value; });
    var payload = {
      action: "submit",
      items: items,
      note: document.getElementById("note").value.trim()
    };

    submit.disabled = true;
    status.textContent = "Sending…";

    fetch("/api/miniapp/data", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify({ data: JSON.stringify(payload) })
    })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body.ok) throw new Error(body.error || "rejected");
        status.textContent = "Sent. Check the room.";
        app.HapticFeedback.notificationOccurred("success");
        setTimeout(function () { app.close(); }, 900);
      })
      .catch(function (err) {
        status.textContent = "Failed: " + err.message;
        submit.disabled = false;
      });

    // Hosts that implement the postMessage bridge get the payload directly,
    // which skips the HTTP round trip entirely.
    app.sendData(payload);
  });
})();
</script>
</body>
</html>
`;
