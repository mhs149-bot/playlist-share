/* Song Sampler PWA */
const APP_VERSION = "11";
(() => {
  const $ = (s) => document.querySelector(s);
  const SECONDS = 10;
  const LS_SEL = "sampler.selected", LS_KEY = "sampler.key";
  const LS_AUTO_BPM = "sampler.autoBpm", LS_MORE_PL = "sampler.morePl";
  const PL_FAST = "PLFraQUBf1D6c", PL_SLOW = "PLCYm7t5kgJWU";
  const PRIMARY_IDS = [PL_FAST, PL_SLOW];
  let bpmThreshold = 100;
  let autoBpm = localStorage.getItem(LS_AUTO_BPM) !== "0";   // default ON
  let moreOpen = localStorage.getItem(LS_MORE_PL) === "1";

  // --- access key: ?k=... on first open, then remembered -------------------
  // REMOTE = served from GitHub Pages (combined app): the API lives behind the tunnel,
  // whose URL is published in config.json. Otherwise the page is served by the API itself.
  const REMOTE = !!window.SAMPLER_REMOTE;
  const qs = new URLSearchParams(location.search);
  const hs = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (qs.get("k")) localStorage.setItem(LS_KEY, qs.get("k"));
  if (hs.get("k")) localStorage.setItem(LS_KEY, hs.get("k"));          // setup link: #k=<key>
  if (hs.get("api")) localStorage.setItem("sampler.apiOverride", hs.get("api"));
  if (hs.has("k") || hs.has("api")) history.replaceState(null, "", location.pathname + location.search);
  const KEY = localStorage.getItem(LS_KEY) || "";
  window.SAMPLER_HAS_KEY = !!KEY;
  if (!REMOTE) $("#manifest").href = "/manifest.webmanifest" + (KEY ? "?k=" + encodeURIComponent(KEY) : "");
  if (REMOTE && !KEY) return;            // visitors without the key only get the Share tab

  let apiBaseP;
  const loadBase = async (fresh) => {
    if (!REMOTE) return "";
    const o = localStorage.getItem("sampler.apiOverride");
    if (o) return o.replace(/\/$/, "");
    try {
      const c = await (await fetch("config.json?t=" + Date.now(), { cache: "no-store" })).json();
      if (c.apiBase) { localStorage.setItem("sampler.apiBase", c.apiBase); return c.apiBase.replace(/\/$/, ""); }
    } catch (_) {}
    return (localStorage.getItem("sampler.apiBase") || "").replace(/\/$/, "");   // last known
  };
  apiBaseP = loadBase();
  // client-side diagnostics -> server log (never blocks, never throws)
  function clog(ev, detail) {
    try {
      Promise.resolve(apiBaseP).then((base) => {
        if (REMOTE && !base) return;
        fetch(base + "/api/clientlog", { method: "POST", keepalive: true,
          headers: { "content-type": "application/json", "x-sampler-key": KEY, "x-pinggy-no-screen": "1" },
          body: JSON.stringify({ ev, detail: detail || null, v: APP_VERSION, ua: navigator.userAgent.slice(0, 120) }) }).catch(() => {});
      });
    } catch (_) {}
  }
  window.addEventListener("error", (e) => clog("js-error", String(e.message || e.error)));
  window.addEventListener("unhandledrejection", (e) => clog("js-reject", String((e.reason && e.reason.message) || e.reason)));

  async function api(path, opts = {}) {
    opts.headers = Object.assign({ "x-sampler-key": KEY, "x-pinggy-no-screen": "1" }, opts.headers || {});   // header skips Pinggy (fallback tunnel) warning page
    const base = await apiBaseP;
    if (REMOTE && !base) throw new Error("Server address unknown (config.json missing)");
    let r, b = base;
    for (let attempt = 0; ; attempt++) {
      try { r = await fetch(b + path, opts); break; }
      catch (e) {
        if (attempt >= 3) throw new Error("Can't reach the Song Sampler server – is the box online?");
        await new Promise((res) => setTimeout(res, 2500 * (attempt + 1)));   // tunnel may be reconnecting
        if (REMOTE && !localStorage.getItem("sampler.apiOverride")) { apiBaseP = loadBase(); b = await apiBaseP; }
      }
    }
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((j && (j.detail || j.message)) || r.statusText);
    return j;
  }
  const toast = (msg, ms = 3500) => {
    const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // --- status banner --------------------------------------------------------
  let lastYtmOk = null;
  async function loadStatus() {
    try {
      const s = await api("/api/status");
      if (lastYtmOk !== null && s.ytm.ok !== lastYtmOk) loadPlaylists(true);   // login swapped
      lastYtmOk = s.ytm.ok;
      if (typeof s.bpm_threshold === "number") {
        bpmThreshold = s.bpm_threshold;
        const thr = $("#bpmThr"); if (thr) thr.textContent = String(Math.round(bpmThreshold));
      }
      const msgs = [];
      if (!s.recognizer_ready) msgs.push("Song recognition isn't set up yet (server needs AUDD_API_TOKEN).");
      if (!s.ytm.ok && s.ytm.reapproval_needed) msgs.push("⚠ YouTube Music login needs re-approval (Google access lapsed). Songs are saved as “pending” and added automatically once it's re-approved.");
      else if (!s.ytm.ok) msgs.push("YouTube Music login expired – songs will be saved as “pending” and added once it's refreshed.");
      if (s.ytm.ok && s.ytm.quota_limit && s.ytm.quota_used_today > 0.9 * s.ytm.quota_limit) msgs.push(`YouTube API quota almost used today (${s.ytm.quota_used_today}/${s.ytm.quota_limit}) – adds may wait until tomorrow.`);
      if (s.ytm.dry_run) msgs.push("Test mode: playlists are not really changed.");
      const b = $("#banner");
      b.innerHTML = msgs.map(esc).join("<br>");
      b.classList.toggle("hidden", !msgs.length);
      b.classList.toggle("err", !s.recognizer_ready);
    } catch (e) {
      const b = $("#banner"); b.textContent = "Can't reach server: " + e.message;
      b.classList.remove("hidden"); b.classList.add("err");
    }
  }

  // --- playlists / chips ----------------------------------------------------
  let playlists = [], selected = new Set(JSON.parse(localStorage.getItem(LS_SEL) || "null") || []);
  const titleOf = (id) => (playlists.find((p) => p.id === id) || {}).title || ({ [PL_FAST]: "UberThumbsUp Fast", [PL_SLOW]: "UberThumbsUp Slow" }[id]) || id;
  const shortTitle = (p) => {
    const t = p.title || "";
    if (p.id === PL_FAST || /uberthumbsup\s*fast/i.test(t)) return "UberThumbsUp Fast";
    if (p.id === PL_SLOW || /uberthumbsup\s*slow/i.test(t)) return "UberThumbsUp Slow";
    return t;
  };

  // Auto Fast/Slow by BPM toggle (default ON)
  const autoBpmEl = $("#autoBpm");
  if (autoBpmEl) {
    autoBpmEl.checked = autoBpm;
    autoBpmEl.addEventListener("change", () => {
      autoBpm = autoBpmEl.checked;
      localStorage.setItem(LS_AUTO_BPM, autoBpm ? "1" : "0");
      api("/api/settings", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ auto_bpm_route: autoBpm }) }).catch(() => {});
      renderChips();
    });
  }

  async function loadPlaylists(refresh = false) {
    try {
      const r = await api("/api/playlists" + (refresh ? "?refresh=1" : ""));
      playlists = r.playlists || [];
      if (typeof r.bpm_threshold === "number") {
        bpmThreshold = r.bpm_threshold;
        const thr = $("#bpmThr"); if (thr) thr.textContent = String(Math.round(bpmThreshold));
      }
      if (typeof r.auto_bpm_route === "boolean" && localStorage.getItem(LS_AUTO_BPM) == null) {
        autoBpm = r.auto_bpm_route; if (autoBpmEl) autoBpmEl.checked = autoBpm;
      }
      if (!localStorage.getItem(LS_SEL)) {
        if (r.selected?.length) selected = new Set(r.selected);
        else selected = new Set(PRIMARY_IDS.filter((id) => playlists.some((p) => p.id === id)));
        if (selected.size) saveSel();
      }
      $("#plSource").textContent = r.source === "library" ? "" : "(public playlists)";
      renderChips();
    } catch (e) { $("#chips").innerHTML = `<span class="muted">Couldn't load playlists: ${esc(e.message)}</span>`; }
  }
  function makeChip(p, primary) {
    const b = document.createElement("button");
    b.className = "chip" + (primary ? " primary" : "") + (selected.has(p.id) ? " on" : "");
    b.textContent = shortTitle(p);
    b.onclick = () => {
      selected.has(p.id) ? selected.delete(p.id) : selected.add(p.id);
      saveSel(); renderChips();
    };
    return b;
  }
  function renderChips() {
    const c = $("#chips"); c.innerHTML = "";
    if (!playlists.length) { c.innerHTML = '<span class="muted">No playlists found.</span>'; return; }
    const primary = [];
    const rest = [];
    const seen = new Set();
    for (const id of PRIMARY_IDS) {
      const p = playlists.find((x) => x.id === id);
      if (p) { primary.push(p); seen.add(id); }
    }
    for (const p of playlists) {
      if (!seen.has(p.id)) rest.push(p);
    }
    const row = document.createElement("div");
    row.className = "chips-primary";
    for (const p of primary) row.appendChild(makeChip(p, true));
    c.appendChild(row);
    if (rest.length) {
      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "more-pl" + (moreOpen ? " open" : "");
      moreBtn.textContent = moreOpen ? "More playlists ▴" : "More playlists ▾";
      moreBtn.onclick = () => {
        moreOpen = !moreOpen;
        localStorage.setItem(LS_MORE_PL, moreOpen ? "1" : "0");
        renderChips();
      };
      c.appendChild(moreBtn);
      const more = document.createElement("div");
      more.className = "chips-more" + (moreOpen ? "" : " hidden");
      for (const p of rest) more.appendChild(makeChip(p, false));
      c.appendChild(more);
    }
  }
  function saveSel() {
    const arr = [...selected];
    localStorage.setItem(LS_SEL, JSON.stringify(arr));
    api("/api/settings", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ selected: arr, auto_bpm_route: autoBpm }) }).catch(() => {});
  }

  // --- recording --------------------------------------------------------------
  // Car/Bluetooth note: voice-processing constraints (echo cancellation etc.) or picking the
  // car's hands-free mic flips the Bluetooth link into call (HFP) mode, which pauses music.
  // So: no voice processing, mono, prefer the phone's built-in mic, release the mic ASAP.
  const btn = $("#rec"), label = $("#recLabel"), prog = $("#prog");
  const CIRC = 2 * Math.PI * 54;
  const LS_PHONEMIC = "sampler.phoneMic", LS_MICID = "sampler.micId";
  const IDLE_LABEL = "Tap to<br>listen";
  let rec = null, stream = null, timer = null, busy = false, identifyOnly = false, recStartedAt = 0;

  const phoneMicOn = () => localStorage.getItem(LS_PHONEMIC) !== "0";   // default ON
  const toggle = $("#phoneMic");
  toggle.checked = phoneMicOn();
  toggle.addEventListener("change", () => {
    localStorage.setItem(LS_PHONEMIC, toggle.checked ? "1" : "0");
    if (!toggle.checked) localStorage.removeItem(LS_MICID);
  });

  const BT_RE = /bluetooth|hands-?free|headset|car|tesla|cybertruck|airpods|buds|hfp|sco|a2dp/i;
  const BUILTIN_RE = /iphone|built-?in|internal|phone|bottom|front|back|default/i;

  async function builtinMicId() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
      if (!devs.some((d) => d.label)) return null;                 // labels need prior permission
      const ok = devs.filter((d) => !BT_RE.test(d.label));
      // prefer a real device over the virtual "default"/"communications" ids (which can follow BT)
      const real = ok.filter((d) => d.deviceId !== "default" && d.deviceId !== "communications");
      const best = real.find((d) => BUILTIN_RE.test(d.label)) || real[0] || ok[0];
      return best ? best.deviceId : null;
    } catch (_) { return null; }
  }

  function audioConstraints(deviceId) {
    const a = {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      channelCount: 1,
      voiceIsolation: false,                 // newer Chrome/Safari; ignored where unknown
    };
    if (deviceId) a.deviceId = { exact: deviceId };
    return { audio: a, video: false };
  }

  function setAudioSession(type) {           // Safari 16.4+/iOS Audio Session API
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch (_) {}
  }

  async function openMic() {
    setAudioSession("play-and-record");
    let id = null;
    if (phoneMicOn()) id = localStorage.getItem(LS_MICID) || (await builtinMicId());
    try {
      stream = await navigator.mediaDevices.getUserMedia(audioConstraints(id));
    } catch (e) {
      if (id && (e.name === "OverconstrainedError" || e.name === "NotFoundError")) {
        localStorage.removeItem(LS_MICID);                    // saved device vanished
        stream = await navigator.mediaDevices.getUserMedia(audioConstraints(null));
      } else throw e;
    }
    if (phoneMicOn()) {
      // First run: labels only appear after permission. If we got a BT mic, switch now.
      const cur = stream.getAudioTracks()[0];
      const better = await builtinMicId();
      if (better && cur && BT_RE.test(cur.label || "") && cur.getSettings().deviceId !== better) {
        releaseMic();
        stream = await navigator.mediaDevices.getUserMedia(audioConstraints(better));
      }
      const got = stream.getAudioTracks()[0];
      if (got && !BT_RE.test(got.label || "")) localStorage.setItem(LS_MICID, got.getSettings().deviceId || "");
    }
  }

  function releaseMic() {
    if (stream) { stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} }); stream = null; }
    setAudioSession("auto");
  }
  // Leaving the app (back gesture, home, screen off) cancels a capture cleanly: nothing sent.
  window.addEventListener("pagehide", () => cancel(true));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) return;
    if (rec && recStartedAt && Date.now() - recStartedAt >= 3000) { clog("hidden-finish", Math.round((Date.now() - recStartedAt) / 1000) + "s"); stop(); }
    else if (rec || !overlay.classList.contains("hidden")) { clog("hidden-cancel", null); cancel(true); }
  });
  // Back gesture while listening = Cancel (we push a history entry when capture starts).
  let recHistory = false, ignorePop = false;
  window.addEventListener("popstate", () => {
    if (ignorePop) { ignorePop = false; return; }
    if (rec) { recHistory = false; cancel(); }
  });
  function popRecHistory() {
    if (recHistory) { recHistory = false; ignorePop = true; history.back(); }
  }

  function pickMime() {
    const c = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg;codecs=opus"];
    return c.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }
  function setProgress(f) { prog.style.strokeDashoffset = String(CIRC * (1 - f)); }

  const cancelBtn = $("#cancel");
  const overlay = $("#listenOverlay"), ovLabel = $("#ovLabel"), pulseIcon = $("#pulseIcon");
  let cancelled = false;
  // Big pulsing app icon while listening. The pulse follows the mic level (Web Audio analyser,
  // not connected to the speakers); the CSS animation is the fallback when that isn't available.
  let meter = null;
  function startMeter() {
    stopMeter();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !stream) return;
    try {
      const ctx = new AC();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let lvl = 0, raf = 0;
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        // no AGC on the mic, so car music is quiet: sqrt curve (0.01 -> .22, 0.05 -> .5, 0.2 -> 1)
        lvl = Math.max(Math.min(1, Math.sqrt(rms) * 2.2), lvl * 0.85);   // fast attack, slow decay
        overlay.style.setProperty("--lvl", lvl.toFixed(3));
        raf = requestAnimationFrame(tick);
      };
      overlay.classList.add("metered");
      tick();
      meter = { ctx, stop() { cancelAnimationFrame(raf); try { src.disconnect(); } catch (_) {} ctx.close().catch(() => {}); } };
    } catch (_) { meter = null; }
  }
  function stopMeter() {
    if (meter) { meter.stop(); meter = null; }
    overlay.classList.remove("metered"); overlay.style.setProperty("--lvl", "0");
  }
  function setBadge(on) {                        // app-icon badge while listening, where supported
    try {
      if (on && navigator.setAppBadge) navigator.setAppBadge().catch(() => {});
      else if (!on && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch (_) {}
  }
  function showOverlay(on, text) {
    overlay.classList.toggle("hidden", !on);
    document.body.classList.toggle("listening", on);
    if (text) ovLabel.innerHTML = text;
    setBadge(on);
    if (!on) stopMeter();
  }
  function showCapturing(on) {
    showOverlay(on);
    btn.classList.toggle("recording", on);
    if (on) { ovLabel.innerHTML = `Listening… <b>${SECONDS}s</b>`; startMeter(); }
    if (!on) { setProgress(0); label.innerHTML = IDLE_LABEL; }
  }
  pulseIcon.addEventListener("click", () => { if (rec) stop(); });   // tap the icon = finish early

  async function start(opts = {}) {
    if (busy) return;
    if (rec) { stop(); return; }                         // tap again = stop early & identify
    identifyOnly = false;
    if (!selected.size && !autoBpm) {
      if (opts.auto) return;                             // auto-listen needs a remembered playlist
      if (!confirm("No playlist selected – just identify the song?")) return;
      identifyOnly = true;
    }
    cancelled = false;
    clog("start", { auto: !!opts.auto, playlists: selected.size, autoBpm });
    label.innerHTML = "Starting mic…";
    showOverlay(true, "Starting mic…");
    try { await openMic(); }
    catch (e) {
      releaseMic(); showCapturing(false);
      clog("mic-fail", (e && e.name) + ": " + (e && e.message));
      if (opts.auto) throw e;                            // caller shows the tap fallback
      toast("Microphone blocked: " + e.message); return;
    }
    if (cancelled) { releaseMic(); showCapturing(false); return; }   // cancelled while opening
    const mime = pickMime();
    { const tr = stream && stream.getAudioTracks()[0]; clog("mic-ok", { label: tr && tr.label, mime }); }
    try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { clog("recorder-fail", e.name + ": " + e.message); releaseMic(); showCapturing(false); toast("Recorder failed: " + e.message); return; }
    rec.onerror = (e) => clog("recorder-error", String(e.error || e));
    { const tr = stream.getAudioTracks()[0]; if (tr) tr.onended = () => { clog("track-ended", tr.label); if (rec) stop(); }; }
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      releaseMic();                                      // belt and braces
      const type = (rec && rec.mimeType) || mime || "audio/webm";
      rec = null; clearInterval(timer);
      showCapturing(false); popRecHistory();
      const bytes = chunks.reduce((n, c) => n + c.size, 0);
      clog("rec-stop", { cancelled, bytes, secs: Math.round((Date.now() - recStartedAt) / 1000) });
      recStartedAt = 0;
      if (cancelled) return;                             // discard: no upload, no history
      if (bytes < 1000) { toast("Mic gave no audio – try again (or turn off 'phone mic only')", 6000); return; }
      const ext = type.includes("mp4") || type.includes("aac") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      send(new Blob(chunks, { type }), "clip." + ext);
    };
    rec.start(250); recStartedAt = Date.now();
    showCapturing(true);
    try { history.pushState({ sampling: 1 }, ""); recHistory = true; } catch (_) {}
    const t0 = Date.now();
    timer = setInterval(() => {
      const el = (Date.now() - t0) / 1000;
      setProgress(Math.min(1, el / SECONDS));
      label.innerHTML = `Listening…<br>${Math.max(0, Math.ceil(SECONDS - el))}s`;
      ovLabel.innerHTML = `Listening… <b>${Math.max(0, Math.ceil(SECONDS - el))}s</b>`;
      if (el >= SECONDS) stop();
    }, 200);
  }
  // Stop recording AND release the mic right away, so the car's audio can resume.
  function stop() {
    clearInterval(timer);
    if (rec && rec.state !== "inactive") { try { rec.requestData(); } catch (_) {} rec.stop(); }
    releaseMic();
  }
  // Cancel: stop instantly, release the mic, throw the audio away.
  function cancel(silent = false) {
    const active = !!rec || !overlay.classList.contains("hidden");
    if (!active) { releaseMic(); return; }              // not capturing (idle / identifying)
    cancelled = true;
    clearInterval(timer);
    if (rec && rec.state !== "inactive") rec.stop();    // onstop sees `cancelled` -> discards
    else { rec = null; showCapturing(false); popRecHistory(); }
    releaseMic();
    if (active && !silent) toast("Cancelled – nothing saved");
  }
  cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); cancel(); });

  async function send(blob, name) {
    busy = true; btn.classList.add("busy"); label.innerHTML = "Identifying…";
    const sentSel = identifyOnly ? [] : [...selected];     // snapshot at upload time
    const sentAuto = !identifyOnly && autoBpm;
    try {
      const fd = new FormData();
      fd.append("audio", blob, name);
      fd.append("playlists", JSON.stringify(sentSel));
      fd.append("mode", identifyOnly ? "identify_only" : "add");
      fd.append("auto_route", sentAuto ? "1" : "0");
      const r = await api("/api/identify", { method: "POST", body: fd });
      if (!r.match) { toast(r.message || "No match"); if (navigator.vibrate) navigator.vibrate([60, 60, 60]); return; }
      if (navigator.vibrate) navigator.vibrate(120);
      let entry = r.entry;
      // When auto BPM route is on, ignore multi-select / late chip taps for the add target.
      if (!sentAuto) {
        const have = new Set((entry.adds || []).map((a) => a.playlistId));
        const late = [...selected].filter((id) => !have.has(id) && !sentSel.includes(id));
        if (late.length && entry.ytm && entry.ytm.videoId) {
          entry = await api(`/api/history/${entry.id}/add`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ playlists: late }) });
        }
      }
      showResult(entry);
      const adds = entry.adds || [];
      const ok = adds.filter((a) => a.status === "added" || a.status === "already").length;
      const bad = adds.filter((a) => a.status === "pending" || a.status === "failed");
      const s = entry.song || {};
      let msg = `${s.title} – ${s.artist}`;
      if (s.bpm != null) {
        const route = s.bpm_route === "fast" ? "Fast" : s.bpm_route === "slow" ? "Slow" : "?";
        msg += ` · ${Math.round(s.bpm)} BPM → ${route}`;
      } else if (sentAuto) {
        msg += entry.bpm_note === "bpm_unknown"
          ? " · BPM ? (used selected playlists)"
          : " · BPM ?";
      }
      if (ok) msg += ` → ${ok} playlist${ok > 1 ? "s" : ""}`;
      if (bad.length) msg += ` · ⚠ ${bad.length} not added (${bad[0].status})`;
      if (!adds.length) msg += " · ⚠ not added – no playlist selected";
      toast(msg, bad.length || !adds.length || s.bpm == null ? 7000 : 4000);
      loadHistory();
    } catch (e) { clog("send-fail", e.message); toast(e.message, 6000); }
    finally { busy = false; identifyOnly = false; btn.classList.remove("busy"); label.innerHTML = IDLE_LABEL; }
  }

  btn.addEventListener("click", start);
  $("#file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) send(f, f.name); e.target.value = ""; });
  $("#refresh").addEventListener("click", () => { loadPlaylists(true); loadStatus(); loadHistory(); });

  // --- result + history cards -------------------------------------------------
  function bpmLine(s) {
    if (!s) return "";
    // Old history entries predate BPM — don't stamp "BPM ?" on them.
    if (!("bpm" in s) && s.bpm_source == null && s.bpm_threshold == null) return "";
    if (s.bpm == null || s.bpm === "") {
      return `<div class="bpm unknown">BPM ?</div>`;
    }
    const n = Math.round(Number(s.bpm));
    const route = s.bpm_route === "fast" ? "Fast" : s.bpm_route === "slow" ? "Slow" : "";
    const label = route ? `${n} BPM → ${route}` : `${n} BPM`;
    const src = s.bpm_source ? ` <span class="src">via ${esc(s.bpm_source)}</span>` : "";
    return `<div class="bpm">${esc(label)}${src}</div>`;
  }
  function card(h) {
    const s = h.song || {}, y = h.ytm || {};
    const img = s.thumbnail || y.thumbnail || "icons/icon-192.png";
    const tags = (h.adds || []).map((a) => `<span class="tag ${a.status}" title="${esc(a.error || a.reason || a.status)}">${esc(a.title || titleOf(a.playlistId))}${a.status === "pending" ? " (pending)" : a.status === "failed" ? " (failed)" : a.status === "already" ? " (already there)" : ""}<button data-act="rm" data-pl="${esc(a.playlistId)}" title="Remove from this playlist">×</button></span>`).join("");
    const needsRetry = (h.adds || []).some((a) => a.status === "pending" || a.status === "failed");
    const firstErr = (h.adds || []).find((a) => (a.status === "pending" || a.status === "failed") && a.error);
    const dupe = (h.adds || []).find((a) => a.status === "already" && a.reason);
    const errLine = (firstErr ? `<div class="err">⚠ ${esc(firstErr.status)}: ${esc(firstErr.error)}</div>` : "")
      + (dupe ? `<div class="yt">Skipped ${esc(dupe.title)}: ${esc(dupe.reason)}</div>` : "");
    const missing = [...selected].filter((id) => !(h.adds || []).some((a) => a.playlistId === id));
    const when = new Date(h.created_at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `<div class="card" data-id="${esc(h.id)}">
      <img src="${esc(img)}" alt="" loading="lazy" onerror="this.src='icons/icon-192.png'">
      <div class="meta">
        <div class="t">${esc(s.title)}</div>
        <div class="a">${esc(s.artist)}${s.album ? " · " + esc(s.album) : ""}</div>
        ${bpmLine(s)}
        <div class="yt">${y.videoId ? `YT Music: <a href="${esc(y.url)}" target="_blank" rel="noopener">${esc(y.title)} – ${esc(y.artists)}</a>` : "No YouTube Music match"}</div>
        <div class="tags">${tags || '<span class="tag pending">Not added to any playlist – no playlist was selected</span>'}</div>
        ${errLine}
        <div class="actions">
          ${y.videoId ? '<button data-act="move" class="move-btn">Move to…</button>' : ""}
          ${(h.adds || []).length ? '<button data-act="undo" class="danger">Undo (remove from playlists)</button>' : ""}
          ${needsRetry ? '<button data-act="retry">Retry</button>' : ""}
          ${missing.length && y.videoId ? `<button data-act="addsel">+ Add to ${missing.length === 1 ? esc(titleOf(missing[0])) : "selected (" + missing.length + ")"}</button>` : ""}
          <button data-act="forget">Hide</button>
        </div>
        <div class="move-picker hidden" data-move-for="${esc(h.id)}"></div>
        <div class="when">${esc(when)} · via ${esc(s.provider)}</div>
      </div></div>`;
  }
  function showResult(h) { $("#resultWrap").classList.remove("hidden"); $("#result").innerHTML = card(h); }

  let historyCache = [];
  async function loadHistory() {
    try {
      const r = await api("/api/history");
      historyCache = r.history;
      $("#history").innerHTML = r.history.length ? r.history.map((h) => `<li>${card(h)}</li>`).join("") : '<li class="muted">Nothing yet.</li>';
    } catch (e) { $("#history").innerHTML = `<li class="muted">${esc(e.message)}</li>`; }
  }

  function closeMovePickers(except) {
    document.querySelectorAll(".move-picker").forEach((p) => {
      if (p !== except) { p.classList.add("hidden"); p.innerHTML = ""; }
    });
  }
  function fillMovePicker(picker, entryId) {
    const h = historyCache.find((x) => x.id === entryId) || {};
    const on = new Set((h.adds || []).filter((a) => a.status === "added" || a.status === "already").map((a) => a.playlistId));
    if (!playlists.length) {
      picker.innerHTML = '<div class="move-picker-empty">No playlists loaded.</div>';
      return;
    }
    const ordered = [
      ...PRIMARY_IDS.map((id) => playlists.find((p) => p.id === id)).filter(Boolean),
      ...playlists.filter((p) => !PRIMARY_IDS.includes(p.id)),
    ];
    const rows = ordered.map((p) => {
      const here = on.has(p.id);
      return `<button type="button" data-act="moveto" data-pl="${esc(p.id)}" class="move-opt${here ? " on" : ""}"${here && on.size === 1 ? " disabled" : ""}>${esc(shortTitle(p))}${here ? " · current" : ""}</button>`;
    }).join("");
    picker.innerHTML = `<div class="move-picker-label">Move to playlist</div>${rows}<button type="button" data-act="movecancel" class="move-cancel">Cancel</button>`;
  }

  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button[data-act]"); if (!b) return;
    const cardEl = b.closest(".card"); if (!cardEl) return;
    const id = cardEl.dataset.id, act = b.dataset.act;
    const h = historyCache.find((x) => x.id === id) || {};
    const name = h.song ? `“${h.song.title}”` : "this song";
    if (act === "move") {
      const picker = cardEl.querySelector(".move-picker");
      if (!picker) return;
      const opening = picker.classList.contains("hidden");
      closeMovePickers(opening ? picker : null);
      if (opening) { fillMovePicker(picker, id); picker.classList.remove("hidden"); }
      else { picker.classList.add("hidden"); picker.innerHTML = ""; }
      return;
    }
    if (act === "movecancel") {
      closeMovePickers();
      return;
    }
    b.disabled = true;
    try {
      if (act === "rm") {
        await api(`/api/history/${id}/playlists/${encodeURIComponent(b.dataset.pl)}`, { method: "DELETE" });
        toast("Removed from " + titleOf(b.dataset.pl));
      } else if (act === "moveto") {
        const pl = b.dataset.pl;
        const r = await api(`/api/history/${id}/move`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ playlist: pl }),
        });
        closeMovePickers();
        if (r.already) toast("Already on " + (r.targetTitle || titleOf(pl)));
        else if (r.warning) toast(r.warning, 7000);
        else toast("Moved to " + (r.targetTitle || titleOf(pl)));
      } else if (act === "undo") {
        if (!confirm(`Remove ${name} from every playlist it was added to?`)) return;
        await api(`/api/history/${id}/undo`, { method: "POST" });
        toast("Undone"); $("#resultWrap").classList.add("hidden");
      } else if (act === "retry") {
        await api(`/api/history/${id}/add`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ playlists: (h.adds || []).map((a) => a.playlistId) }) });
      } else if (act === "addsel") {
        await api(`/api/history/${id}/add`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ playlists: [...selected] }) });
      } else if (act === "forget") {
        if (!confirm(`Hide ${name} from history? (Playlists are not changed.)`)) return;
        await api(`/api/history/${id}`, { method: "DELETE" });
        if ($("#result .card")?.dataset.id === id) $("#resultWrap").classList.add("hidden");
      }
      await loadHistory();
      const cur = historyCache.find((x) => x.id === $("#result .card")?.dataset.id);
      if (cur) showResult(cur);
    } catch (e) { toast(e.message, 6000); }
    finally { b.disabled = false; }
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadStatus(); loadPlaylists(); loadHistory(); } });
  setInterval(() => { if (!document.hidden && !busy && !rec) loadStatus(); }, 60000);

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  // --- launching ---------------------------------------------------------------
  // Tapping the home-screen icon just opens the app (start_url has no action).
  // The "Listen now" shortcut (long-press the icon, or drag it to the home screen as its own
  // button) opens ?action=listen, which starts listening right away with the remembered
  // playlist(s). The old ?autolisten=1 start_url (installs from before v6) is treated as a
  // plain open. Optional setting "Start listening when opened" (default OFF) restores the old
  // behaviour for plain launches.
  const LS_AUTO = "sampler.autoListen";
  if (localStorage.getItem("sampler.autoListenV6") !== "1") {   // one-time migration: off
    localStorage.setItem(LS_AUTO, "0"); localStorage.setItem("sampler.autoListenV6", "1");
  }
  const autoToggle = $("#autoListen");
  autoToggle.checked = localStorage.getItem(LS_AUTO) === "1";          // default OFF
  autoToggle.addEventListener("change", () => localStorage.setItem(LS_AUTO, autoToggle.checked ? "1" : "0"));
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const navType = (performance.getEntriesByType("navigation")[0] || {}).type;
  const listenNow = qs.get("action") === "listen";                         // "Listen now" shortcut
  const launchAuto = listenNow || (autoToggle.checked && standalone && navType === "navigate");
  if (qs.has("autolisten") || qs.has("k") || qs.has("action"))
    history.replaceState(null, "", location.pathname);                    // tidy URL, no re-trigger on reload

  async function micState() {
    try { return (await navigator.permissions.query({ name: "microphone" })).state; }
    catch (_) { return "unknown"; }
  }
  async function autoListen(explicit) {
    if (busy || rec) return;
    if (!selected.size && !autoBpm) { $("#hint").textContent = "Pick a playlist below, then use “Listen now” again."; return; }
    const st = await micState();
    // explicit "Listen now" may ask for the mic; a plain launch only starts if already allowed
    if (st === "denied" || (!explicit && st !== "granted")) {
      $("#hint").textContent = "Tap to listen (allow the mic once)."; return;
    }
    try { await start({ auto: true }); }
    catch (e) { $("#hint").textContent = "Couldn't start the mic – tap to listen."; }
  }

  loadStatus(); loadHistory();
  loadPlaylists().then(() => { if (launchAuto) autoListen(listenNow); });
})();
