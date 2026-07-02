// Self-contained ChatGPT UI widget (Apps SDK "app component"). Rendered by
// ChatGPT inside a sandboxed iframe — see registerResource("post-composer-widget", ...)
// in server.ts, and the openPostComposer tool that links a model turn to it.
//
// WHY THIS EXISTS: _meta["openai/fileParams"] (the mechanism resolveImageUrl()
// in server.ts is built around) asks ChatGPT to rewrite a local/generated
// image into a { download_url, file_id } object BEFORE the tool call ever
// reaches this server. In practice that rewrite step is unreliable — see the
// long comment above ImageInputSchema in server.ts — and can fail outright
// with an OpenAI-side error ("File arg rewrite paths are required when
// proxied mounts are present") that no server-side code can catch or work
// around, because the failure happens upstream of the HTTP request.
//
// This widget sidesteps that whole mechanism. Instead of ChatGPT rewriting a
// tool *argument*, the widget itself — running inside ChatGPT's iframe, with
// direct access to window.openai — calls window.openai.selectFiles() /
// window.openai.uploadFile() and window.openai.getFileDownloadUrl() to obtain
// a { download_url, file_id } reference directly. That's the same file-bridge
// primitive ChatGPT uses internally for its own file library, so it doesn't
// depend on the fileParams rewrite step at all. The widget then calls
// publishPost itself via window.openai.callTool(), passing that reference in
// exactly the shape resolveImageUrl() already knows how to handle.
//
// Kept dependency-free (no build step, no external CDN) so it can ship as a
// single inline <script> — Apps SDK CSP defaults block third-party scripts
// unless explicitly allowlisted, and there is no reason to take that on here.

export const POST_COMPOSER_TEMPLATE_URI = "ui://widget/post-composer.html";

export const POST_COMPOSER_HTML = `
<div id="composer-root" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; color: #1a1a1a;">
  <style>
    #composer-root * { box-sizing: border-box; }
    #composer-root label { display: block; font-size: 12px; font-weight: 600; color: #555; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: 0.02em; }
    #composer-root select, #composer-root textarea, #composer-root input[type="text"] {
      width: 100%; padding: 8px 10px; border: 1px solid #d8d8d8; border-radius: 8px; font-size: 14px; font-family: inherit; resize: vertical;
    }
    #composer-root textarea { min-height: 70px; }
    #composer-root .platforms { display: flex; flex-wrap: wrap; gap: 8px; }
    #composer-root .platform-chip { display: flex; align-items: center; gap: 6px; border: 1px solid #d8d8d8; border-radius: 999px; padding: 5px 12px; font-size: 13px; cursor: pointer; user-select: none; }
    #composer-root .platform-chip.selected { background: #111; color: #fff; border-color: #111; }
    #composer-root .platform-chip input { display: none; }
    #composer-root .image-row { display: flex; align-items: center; gap: 12px; margin-top: 4px; }
    #composer-root .image-preview { width: 64px; height: 64px; border-radius: 8px; object-fit: cover; border: 1px solid #d8d8d8; background: #f4f4f4; }
    #composer-root .btn { border: none; border-radius: 8px; padding: 9px 16px; font-size: 14px; font-weight: 600; cursor: pointer; }
    #composer-root .btn-secondary { background: #f0f0f0; color: #111; }
    #composer-root .btn-primary { background: #111; color: #fff; margin-top: 16px; width: 100%; padding: 11px 16px; font-size: 15px; }
    #composer-root .btn:disabled { opacity: 0.5; cursor: default; }
    #composer-root .status { margin-top: 12px; font-size: 13px; padding: 10px 12px; border-radius: 8px; white-space: pre-wrap; }
    #composer-root .status.error { background: #fdecea; color: #a1260d; }
    #composer-root .status.success { background: #eaf7ec; color: #1e6b30; }
    #composer-root .status.pending { background: #f0f0f0; color: #555; }
    #composer-root .file-name { font-size: 12px; color: #666; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
    #composer-root .hint { font-size: 11px; color: #888; margin-top: 4px; }
  </style>

  <label for="c-brand">Brand</label>
  <select id="c-brand"></select>

  <label for="c-caption">Caption</label>
  <textarea id="c-caption" placeholder="Write the post caption..."></textarea>

  <label for="c-hashtags">Hashtags (comma-separated, optional)</label>
  <input id="c-hashtags" type="text" placeholder="#Paris, #WeekendGetaway" />

  <label>Image</label>
  <div class="image-row">
    <img id="c-preview" class="image-preview" style="display:none;" />
    <button id="c-pick-library" class="btn btn-secondary" type="button">Choose from ChatGPT</button>
    <button id="c-pick-upload" class="btn btn-secondary" type="button">Upload a file</button>
    <span id="c-filename" class="file-name"></span>
  </div>
  <input id="c-file-input" type="file" accept="image/*" style="display:none;" />
  <div class="hint">"Choose from ChatGPT" picks an image already in this conversation or your file library (works for images the model just generated, once saved). "Upload a file" opens your device's file picker.</div>

  <label>Platforms</label>
  <div id="c-platforms" class="platforms"></div>

  <button id="c-publish" class="btn btn-primary" type="button">Publish now</button>

  <div id="c-status"></div>
</div>

<script>
(function () {
  var state = {
    brands: [],
    brand: (window.openai && window.openai.toolInput && window.openai.toolInput.brand) || null,
    image: null,
    platforms: {},
    status: "idle",
    statusMessage: ""
  };

  var el = {
    brand: document.getElementById("c-brand"),
    caption: document.getElementById("c-caption"),
    hashtags: document.getElementById("c-hashtags"),
    preview: document.getElementById("c-preview"),
    pickLibrary: document.getElementById("c-pick-library"),
    pickUpload: document.getElementById("c-pick-upload"),
    fileInput: document.getElementById("c-file-input"),
    fileName: document.getElementById("c-filename"),
    platforms: document.getElementById("c-platforms"),
    publish: document.getElementById("c-publish"),
    status: document.getElementById("c-status")
  };

  function parseToolResult(res) {
    if (res && res.structuredContent) return res.structuredContent;
    try {
      return JSON.parse(res && res.content && res.content[0] && res.content[0].text || "null");
    } catch (e) {
      return null;
    }
  }

  function renderBrandOptions() {
    el.brand.innerHTML = "";
    state.brands.forEach(function (b) {
      var opt = document.createElement("option");
      opt.value = b.key;
      opt.textContent = b.displayName;
      if (b.key === state.brand) opt.selected = true;
      el.brand.appendChild(opt);
    });
  }

  function currentBrandPlatforms() {
    var b = state.brands.find(function (x) { return x.key === state.brand; });
    if (!b) return [];
    // TikTok needs 7 additional required fields (privacyLevel, disabledComments,
    // etc.) this lightweight widget doesn't collect — leave that flow in chat.
    return (b.platforms || []).filter(function (p) { return p !== "tiktok"; });
  }

  function renderPlatformChips() {
    el.platforms.innerHTML = "";
    var platforms = currentBrandPlatforms();
    platforms.forEach(function (p) {
      var chip = document.createElement("label");
      chip.className = "platform-chip" + (state.platforms[p] ? " selected" : "");
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!state.platforms[p];
      input.addEventListener("change", function () {
        state.platforms[p] = input.checked;
        renderPlatformChips();
      });
      var label = document.createElement("span");
      label.textContent = p.charAt(0).toUpperCase() + p.slice(1);
      chip.appendChild(input);
      chip.appendChild(label);
      chip.addEventListener("click", function (evt) {
        if (evt.target === input) return;
        input.checked = !input.checked;
        input.dispatchEvent(new Event("change"));
      });
      el.platforms.appendChild(chip);
    });
    if (!platforms.length) {
      var none = document.createElement("span");
      none.className = "hint";
      none.textContent = "No connected platforms configured for this brand yet.";
      el.platforms.appendChild(none);
    }
  }

  function setStatus(kind, message) {
    state.status = kind;
    state.statusMessage = message || "";
    el.status.className = "status" + (kind !== "idle" ? " " + kind : "");
    el.status.textContent = state.statusMessage;
  }

  async function loadBrands() {
    if (!window.openai || !window.openai.callTool) {
      setStatus("error", "This widget needs to run inside ChatGPT (window.openai is unavailable).");
      return;
    }
    try {
      var res = await window.openai.callTool("listBrands", {});
      var data = parseToolResult(res) || [];
      state.brands = data.filter(function (b) { return b.enabled; });
      if (!state.brand || !state.brands.some(function (b) { return b.key === state.brand; })) {
        state.brand = state.brands.length ? state.brands[0].key : null;
      }
      renderBrandOptions();
      renderPlatformChips();
    } catch (err) {
      setStatus("error", "Couldn't load brands: " + (err && err.message ? err.message : String(err)));
    }
  }

  async function resolveAndSetImage(fileId, fileName, mimeType) {
    try {
      var dl = await window.openai.getFileDownloadUrl({ fileId: fileId });
      var downloadUrl = dl && (dl.downloadUrl || dl.download_url);
      state.image = {
        download_url: downloadUrl,
        file_id: fileId,
        file_name: fileName || undefined,
        mime_type: mimeType || undefined
      };
      el.fileName.textContent = fileName || fileId;
      el.preview.src = downloadUrl;
      el.preview.style.display = "block";
      el.preview.onerror = function () {
        // CSP or a very short-lived URL may block the inline preview —
        // that's fine, the reference itself is still valid for publishing.
        el.preview.style.display = "none";
      };
      setStatus("idle", "");
    } catch (err) {
      setStatus("error", "Couldn't resolve that file: " + (err && err.message ? err.message : String(err)));
    }
  }

  async function pickFromLibrary() {
    if (!window.openai || !window.openai.selectFiles) {
      setStatus("error", "File library isn't available here — use \\"Upload a file\\" instead.");
      return;
    }
    try {
      var files = await window.openai.selectFiles();
      if (files && files[0]) {
        await resolveAndSetImage(files[0].fileId, files[0].fileName, files[0].mimeType);
      }
    } catch (err) {
      setStatus("error", "Couldn't open the file picker: " + (err && err.message ? err.message : String(err)));
    }
  }

  function pickFromUpload() {
    el.fileInput.click();
  }

  async function onFileInputChange(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) return;
    if (!window.openai || !window.openai.uploadFile) {
      setStatus("error", "Upload isn't available in this environment.");
      return;
    }
    try {
      setStatus("pending", "Uploading " + file.name + "...");
      var uploaded = await window.openai.uploadFile(file, { library: true });
      await resolveAndSetImage(uploaded.fileId, file.name, file.type);
    } catch (err) {
      setStatus("error", "Upload failed: " + (err && err.message ? err.message : String(err)));
    }
  }

  async function publish() {
    var platforms = Object.keys(state.platforms).filter(function (p) { return state.platforms[p]; });
    if (!state.brand) {
      setStatus("error", "Pick a brand first.");
      return;
    }
    if (!el.caption.value.trim()) {
      setStatus("error", "Write a caption first.");
      return;
    }
    if (!platforms.length) {
      setStatus("error", "Select at least one platform.");
      return;
    }
    el.publish.disabled = true;
    setStatus("pending", "Publishing...");
    try {
      var hashtags = el.hashtags.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      var args = {
        brand: state.brand,
        caption: el.caption.value.trim(),
        hashtags: hashtags,
        platforms: platforms
      };
      if (state.image) args.image = state.image;
      var res = await window.openai.callTool("publishPost", args);
      var data = parseToolResult(res);
      if (data && data.results) {
        var lines = data.results.map(function (r) {
          return r.platform + ": " + (r.submissionId ? "published (id " + r.submissionId + ")" : JSON.stringify(r));
        });
        setStatus("success", "Published!\\n" + lines.join("\\n"));
      } else {
        setStatus("success", "Published. " + JSON.stringify(data));
      }
    } catch (err) {
      setStatus("error", "Publish failed: " + (err && err.message ? err.message : String(err)));
    } finally {
      el.publish.disabled = false;
    }
  }

  el.brand.addEventListener("change", function () {
    state.brand = el.brand.value;
    renderPlatformChips();
  });
  el.pickLibrary.addEventListener("click", pickFromLibrary);
  el.pickUpload.addEventListener("click", pickFromUpload);
  el.fileInput.addEventListener("change", onFileInputChange);
  el.publish.addEventListener("click", publish);

  loadBrands();
})();
</script>
`.trim();
