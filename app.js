/* Blind rating front-end for one human-evaluation study.
 *
 * All study content is baked into study-data.js at export time; this file only
 * handles navigation, local persistence and delivery. Nothing here knows which
 * system produced which recommendation.
 */
(function () {
  "use strict";

  var STUDY = window.HEVAL_STUDY;
  var CONFIG = window.HEVAL_CONFIG || {};
  var MAX_BATCH = 20;
  var RETRY_MS = 60000;

  var el = {
    raterBadge: document.getElementById("rater-badge"),
    saveStatus: document.getElementById("save-status"),
    progressWrap: document.getElementById("progress-wrap"),
    progressBar: document.getElementById("progress-bar"),
    progressText: document.getElementById("progress-text"),
    viewIntro: document.getElementById("view-intro"),
    viewRate: document.getElementById("view-rate"),
    viewDone: document.getElementById("view-done"),
    raterMissing: document.getElementById("rater-missing"),
    raterInvalid: document.getElementById("rater-invalid"),
    introBody: document.getElementById("intro-body"),
    introCount: document.getElementById("intro-count"),
    institution: document.getElementById("institution"),
    ethicsStatus: document.getElementById("ethics-status"),
    retentionMonths: document.getElementById("retention-months"),
    contactEmail: document.getElementById("contact-email"),
    consent: document.getElementById("consent"),
    consentError: document.getElementById("consent-error"),
    rubricRows: document.getElementById("rubric-rows"),
    btnStart: document.getElementById("btn-start"),
    briefBody: document.getElementById("brief-body"),
    outputBody: document.getElementById("output-body"),
    scales: document.getElementById("scales"),
    comment: document.getElementById("comment"),
    form: document.getElementById("rating-form"),
    formError: document.getElementById("form-error"),
    btnSubmit: document.getElementById("btn-submit"),
    doneSummary: document.getElementById("done-summary"),
    pendingWarn: document.getElementById("pending-warn"),
    btnResend: document.getElementById("btn-resend"),
    btnDownload: document.getElementById("btn-download"),
    contactLine: document.getElementById("contact-line"),
    footerNote: document.getElementById("footer-note")
  };

  var raterId = null;
  var state = null;
  var shownAt = 0;
  var flushing = false;

  /* ------------------------------------------------------------------ util */

  function param(name) {
    var match = new RegExp("[?&]" + name + "=([^&#]*)").exec(window.location.search);
    return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : null;
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) { return window.crypto.randomUUID(); }
    return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function storageKey() {
    return "heval:" + STUDY.study_id + ":" + raterId;
  }

  function loadState() {
    var fallback = {
      version: 1,
      rater_id: raterId,
      done: {},
      sent: {},
      remote: {},
      consent_at: null,
      started_at: new Date().toISOString()
    };
    try {
      var raw = window.localStorage.getItem(storageKey());
      if (!raw) { return fallback; }
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") { return fallback; }
      parsed.done = parsed.done || {};
      parsed.sent = parsed.sent || {};
      parsed.remote = parsed.remote || {};
      parsed.consent_at = parsed.consent_at || null;
      parsed.rater_id = raterId;
      return parsed;
    } catch (err) {
      return fallback;
    }
  }

  function saveState() {
    try {
      window.localStorage.setItem(storageKey(), JSON.stringify(state));
      return true;
    } catch (err) {
      setStatus("Could not save locally - keep this tab open and download the backup at the end.", "warn");
      return false;
    }
  }

  function setStatus(text, kind) {
    el.saveStatus.textContent = text;
    el.saveStatus.className = "status" + (kind ? " " + kind : "");
  }

  function units() {
    return (STUDY.raters[raterId] || {}).units || [];
  }

  function isRated(token) {
    return Boolean(state.done[token] || state.remote[token]);
  }

  function doneCount() {
    var all = units();
    var count = 0;
    for (var i = 0; i < all.length; i++) {
      if (isRated(all[i])) { count++; }
    }
    return count;
  }

  function pendingRatings() {
    var out = [];
    var all = units();
    for (var i = 0; i < all.length; i++) {
      var rating = state.done[all[i]];
      if (rating && !state.sent[rating.rating_id]) { out.push(rating); }
    }
    return out;
  }

  function allRatings() {
    var out = [];
    var all = units();
    for (var i = 0; i < all.length; i++) {
      if (state.done[all[i]]) { out.push(state.done[all[i]]); }
    }
    return out;
  }

  /* --------------------------------------------------------------- delivery */

  function payloadFor(ratings) {
    return {
      study_id: STUDY.study_id,
      export_id: STUDY.export_id,
      rater_id: raterId,
      app_version: STUDY.app_version,
      consent_at: state.consent_at,
      client_sent_at: new Date().toISOString(),
      ratings: ratings
    };
  }

  function postBatch(payload) {
    var url = CONFIG.endpoint;
    if (!url) { return Promise.resolve({ ok: false, reason: "no-endpoint" }); }
    var body = JSON.stringify(payload);
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: body,
      redirect: "follow"
    }).then(function (response) {
      if (!response.ok) { return { ok: false, reason: "http-" + response.status }; }
      return { ok: true, verified: true };
    }).catch(function () {
      // A cross-origin rejection still delivers the request when the collector
      // accepts simple POSTs, so retry opaquely instead of losing the batch.
      return fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: body
      }).then(function () {
        return { ok: true, verified: false };
      }).catch(function (error) {
        return { ok: false, reason: String(error) };
      });
    });
  }

  function flush() {
    if (flushing) { return Promise.resolve(null); }
    var queue = pendingRatings();
    if (!queue.length) {
      setStatus(CONFIG.endpoint ? "All ratings sent" : "Saved in this browser", "ok");
      return Promise.resolve(null);
    }
    if (!CONFIG.endpoint) {
      setStatus("Saved in this browser (" + queue.length + " to hand in at the end)", "warn");
      return Promise.resolve(null);
    }
    flushing = true;
    setStatus("Sending " + queue.length + " rating(s)...");
    var batch = queue.slice(0, MAX_BATCH);
    return postBatch(payloadFor(batch)).then(function (result) {
      flushing = false;
      if (result.ok) {
        for (var i = 0; i < batch.length; i++) {
          state.sent[batch[i].rating_id] = result.verified ? "confirmed" : "unconfirmed";
        }
        saveState();
        if (pendingRatings().length) { return flush(); }
        setStatus(result.verified ? "All ratings sent" : "Ratings sent (not confirmed by server)",
          result.verified ? "ok" : "warn");
        // The done screen may already be open while the last batch is in
        // flight, so refresh its warning once delivery is settled.
        if (!el.viewDone.classList.contains("hidden")) { updateDoneWarning(); }
        return null;
      }
      setStatus("Offline - " + queue.length + " rating(s) stored locally, retrying", "warn");
      return null;
    }).catch(function () {
      flushing = false;
      setStatus("Offline - ratings stored locally, retrying", "warn");
      return null;
    });
  }

  function syncFromServer() {
    if (!CONFIG.endpoint) { return Promise.resolve(null); }
    var separator = CONFIG.endpoint.indexOf("?") >= 0 ? "&" : "?";
    var url = CONFIG.endpoint + separator + "rater_id=" + encodeURIComponent(raterId);
    return fetch(url, { method: "GET", redirect: "follow" }).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (data) {
      if (!data || !data.units) { return null; }
      var added = 0;
      for (var i = 0; i < data.units.length; i++) {
        var token = data.units[i];
        if (!state.done[token] && !state.remote[token]) {
          state.remote[token] = true;
          added++;
        }
      }
      if (added) { saveState(); }
      return data.units.length;
    }).catch(function () {
      // Recovering earlier progress is a convenience, never a precondition.
      return null;
    });
  }

  /* ------------------------------------------------------------------ views */

  function show(view) {
    el.viewIntro.classList.add("hidden");
    el.viewRate.classList.add("hidden");
    el.viewDone.classList.add("hidden");
    view.classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  function updateProgress() {
    var total = units().length;
    var done = doneCount();
    var percent = total ? Math.round((done / total) * 100) : 100;
    el.progressWrap.classList.remove("hidden");
    el.progressBar.style.width = percent + "%";
    el.progressText.textContent = done + " / " + total + " rated";
  }

  function buildRubricTable() {
    var html = "";
    for (var i = 0; i < STUDY.rubric.length; i++) {
      var dim = STUDY.rubric[i];
      html += "<tr><td><strong>" + dim.label + "</strong></td><td>" + dim.description + "</td>" +
        "<td>" + dim.anchors["1"] + "</td><td>" + dim.anchors["3"] + "</td><td>" + dim.anchors["5"] + "</td></tr>";
    }
    el.rubricRows.innerHTML = html;
  }

  function buildScales() {
    var html = "";
    for (var i = 0; i < STUDY.rubric.length; i++) {
      var dim = STUDY.rubric[i];
      html += "<fieldset class='scale' data-key='" + dim.key + "'>";
      html += "<div class='scale-head'><legend class='scale-label'>" + dim.label + "</legend>" +
        "<span class='scale-desc'>" + dim.description + "</span></div>";
      html += "<div class='scale-anchors'>1: " + dim.anchors["1"] + " &nbsp;&bull;&nbsp; 3: " +
        dim.anchors["3"] + " &nbsp;&bull;&nbsp; 5: " + dim.anchors["5"] + "</div>";
      html += "<div class='options'>";
      for (var value = STUDY.likert.min; value <= STUDY.likert.max; value++) {
        html += "<label><input type='radio' name='" + dim.key + "' value='" + value +
          "'><span>" + value + "</span></label>";
      }
      html += "</div></fieldset>";
    }
    el.scales.innerHTML = html;

    el.scales.addEventListener("change", function (event) {
      var input = event.target;
      if (!input || input.type !== "radio") { return; }
      var group = input.parentNode.parentNode.parentNode;
      group.classList.remove("missing");
      var labels = group.querySelectorAll("label");
      for (var i = 0; i < labels.length; i++) { labels[i].classList.remove("selected"); }
      input.parentNode.classList.add("selected");
    });
  }

  function resetForm() {
    var inputs = el.scales.querySelectorAll("input[type=radio]");
    for (var i = 0; i < inputs.length; i++) { inputs[i].checked = false; }
    var labels = el.scales.querySelectorAll("label");
    for (var j = 0; j < labels.length; j++) { labels[j].classList.remove("selected"); }
    var groups = el.scales.querySelectorAll(".scale");
    for (var k = 0; k < groups.length; k++) { groups[k].classList.remove("missing"); }
    el.comment.value = "";
    el.formError.classList.add("hidden");
    el.formError.textContent = "";
  }

  function nextUnit() {
    var all = units();
    for (var i = 0; i < all.length; i++) {
      if (!isRated(all[i])) { return { token: all[i], position: i + 1 }; }
    }
    return null;
  }

  function renderUnit(entry) {
    var unit = STUDY.units[entry.token];
    var item = STUDY.items[unit.item];
    el.briefBody.innerHTML = item.brief_html;
    el.outputBody.innerHTML = unit.output_html;
    resetForm();
    shownAt = Date.now();
    updateProgress();
    show(el.viewRate);
  }

  function advance() {
    var entry = nextUnit();
    if (!entry) { renderDone(); return; }
    renderUnit(entry);
  }

  function updateDoneWarning() {
    var unconfirmed = 0;
    var ratings = allRatings();
    for (var i = 0; i < ratings.length; i++) {
      if (state.sent[ratings[i].rating_id] !== "confirmed") { unconfirmed++; }
    }
    if (unconfirmed > 0) { el.pendingWarn.classList.remove("hidden"); }
    else { el.pendingWarn.classList.add("hidden"); }
  }

  function renderDone() {
    updateProgress();
    el.doneSummary.textContent = "You rated all " + units().length +
      " recommendations. Nothing else is needed from you.";
    updateDoneWarning();
    if (CONFIG.contact_email) {
      el.contactLine.textContent = "Questions or problems: " + CONFIG.contact_email;
    }
    show(el.viewDone);
  }

  function collectScores() {
    var scores = {};
    var missing = [];
    for (var i = 0; i < STUDY.rubric.length; i++) {
      var key = STUDY.rubric[i].key;
      var checked = el.scales.querySelector("input[name='" + key + "']:checked");
      if (!checked) {
        missing.push(STUDY.rubric[i].label);
        el.scales.querySelector(".scale[data-key='" + key + "']").classList.add("missing");
      } else {
        scores[key] = parseInt(checked.value, 10);
      }
    }
    return { scores: scores, missing: missing };
  }

  function onSubmit(event) {
    event.preventDefault();
    var entry = nextUnit();
    if (!entry) { renderDone(); return; }
    var collected = collectScores();
    if (collected.missing.length) {
      el.formError.textContent = "Please rate every scale. Missing: " + collected.missing.join(", ") + ".";
      el.formError.classList.remove("hidden");
      el.formError.scrollIntoView({ block: "center" });
      return;
    }
    state.done[entry.token] = {
      rating_id: uuid(),
      unit_token: entry.token,
      position: entry.position,
      scores: collected.scores,
      comment: el.comment.value.trim(),
      client_timestamp: new Date().toISOString(),
      duration_ms: Math.max(0, Date.now() - shownAt)
    };
    saveState();
    flush();
    advance();
  }

  function download() {
    var payload = payloadFor(allRatings());
    payload.exported_at = new Date().toISOString();
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "ratings_" + raterId + "_" + STUDY.export_id + ".json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ------------------------------------------------------------------- boot */

  function startRating() {
    if (!state.consent_at) {
      if (!el.consent.checked) {
        el.consentError.classList.remove("hidden");
        el.consent.focus();
        return;
      }
      state.consent_at = new Date().toISOString();
      saveState();
    }
    el.consentError.classList.add("hidden");
    el.raterBadge.textContent = raterId;
    el.raterBadge.classList.remove("hidden");
    advance();
    flush();
  }

  function bindKeyboard() {
    document.addEventListener("keydown", function (event) {
      if (el.viewRate.classList.contains("hidden")) { return; }
      var tag = (event.target && event.target.tagName) || "";
      if (tag === "TEXTAREA" || tag === "INPUT" || event.ctrlKey || event.metaKey || event.altKey) { return; }
      var digit = parseInt(event.key, 10);
      if (!digit || digit < STUDY.likert.min || digit > STUDY.likert.max) { return; }
      for (var i = 0; i < STUDY.rubric.length; i++) {
        var key = STUDY.rubric[i].key;
        if (!el.scales.querySelector("input[name='" + key + "']:checked")) {
          var input = el.scales.querySelector("input[name='" + key + "'][value='" + digit + "']");
          if (input) {
            input.checked = true;
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
          event.preventDefault();
          return;
        }
      }
    });
  }

  function init() {
    if (!STUDY || !STUDY.raters) {
      document.body.innerHTML =
        "<p style='padding:24px'>Study data failed to load. Please contact the study owner.</p>";
      return;
    }
    buildRubricTable();
    buildScales();
    el.form.addEventListener("submit", onSubmit);
    el.btnStart.addEventListener("click", startRating);
    el.btnResend.addEventListener("click", function () { flush(); });
    el.btnDownload.addEventListener("click", download);
    bindKeyboard();

    var requested = param("r");
    var token = param("t");
    if (!requested || !STUDY.raters[requested]) {
      el.raterMissing.classList.remove("hidden");
      return;
    }
    if (STUDY.raters[requested].token !== token) {
      el.raterInvalid.classList.remove("hidden");
      return;
    }

    raterId = requested;
    state = loadState();
    saveState();
    el.raterBadge.textContent = raterId;
    el.raterBadge.classList.remove("hidden");
    el.introCount.textContent = String(units().length);
    el.institution.textContent = CONFIG.institution || "the research institution";
    el.ethicsStatus.textContent = CONFIG.ethics_status || "approved for use in this thesis";
    el.retentionMonths.textContent = String(CONFIG.retention_months || 12);
    el.contactEmail.textContent = CONFIG.contact_email || "the study owner";
    el.introBody.classList.remove("hidden");
    el.footerNote.textContent =
      "Progress is saved automatically in this browser. Keyboard: press 1-5 to fill the next scale.";

    if (CONFIG.endpoint) { setStatus("Checking your progress..."); }
    syncFromServer().then(function () {
      updateProgress();
      if (doneCount() > 0) {
        el.btnStart.textContent = "Continue rating";
      }
      flush();
    });
    window.setInterval(function () { if (pendingRatings().length) { flush(); } }, RETRY_MS);
    window.addEventListener("online", flush);
  }

  init();
})();
