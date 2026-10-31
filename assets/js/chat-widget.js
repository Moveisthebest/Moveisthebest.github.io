/* "Chat with me" floating widget.
   Talks to the chat proxy in /chat-server; the DeepSeek key never reaches the
   browser. Set the proxy URL via data-endpoint on the script tag. */
(function () {
  var script = document.currentScript;
  var ENDPOINT = script && script.getAttribute("data-endpoint");
  var QUOTA_URL = ENDPOINT && ENDPOINT.replace(/\/chat$/, "/quota");
  var MAX_HISTORY = 10;
  var SUGGESTIONS = [
    "What are Kun Wang's main research interests?",
    "What problem does NPUGen solve?",
    "Summarize the LATTE paper.",
  ];

  var history = [];
  var busy = false;
  var quotaLoaded = false;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Minimal, safe markdown: escape first, then **bold**, `code`, links, line breaks.
  function render(text) {
    return escapeHtml(text)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\n/g, "<br>");
  }

  var launcher = el("button", "kw-chat-launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Chat with me");
  launcher.innerHTML = '<i class="fas fa-comments" aria-hidden="true"></i><span>Chat with me</span>';

  var panel = el("div", "kw-chat-panel");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Chat about my research");

  var header = el("div", "kw-chat-header");
  var title = el("div");
  title.appendChild(el("strong", null, "Chat with me"));
  title.appendChild(el("small", null, "AI assistant · ask about my papers"));
  var closeBtn = el("button", "kw-chat-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close chat");
  header.appendChild(title);
  header.appendChild(closeBtn);

  // Remaining daily quota for this visitor, as reported by the proxy.
  var quota = el("div", "kw-chat-quota");
  quota.hidden = true;
  var quotaBar = el("div", "kw-chat-quota-bar");
  var quotaFill = el("span");
  quotaBar.appendChild(quotaFill);
  var quotaText = el("span", "kw-chat-quota-text");
  quota.appendChild(el("span", null, "Today's quota"));
  quota.appendChild(quotaBar);
  quota.appendChild(quotaText);

  var list = el("div", "kw-chat-messages");
  list.setAttribute("aria-live", "polite");

  var form = el("form", "kw-chat-form");
  var input = el("textarea");
  input.placeholder = "Ask about my research…";
  input.maxLength = 1000;
  input.rows = 1;
  var sendBtn = el("button", null, "Send");
  sendBtn.type = "submit";
  form.appendChild(input);
  form.appendChild(sendBtn);

  var note = el("div", "kw-chat-note", "AI-generated answers may be inaccurate. Please refer to the papers.");

  panel.appendChild(header);
  panel.appendChild(quota);
  panel.appendChild(list);
  panel.appendChild(form);
  panel.appendChild(note);

  function setQuota(percent) {
    if (typeof percent !== "number") return;
    percent = Math.max(0, Math.min(100, Math.round(percent)));
    quota.hidden = false;
    quotaFill.style.width = percent + "%";
    quotaText.textContent = percent + "% left";
    quota.classList.toggle("is-low", percent <= 20);
  }

  function loadQuota() {
    if (quotaLoaded || !QUOTA_URL) return;
    quotaLoaded = true;
    fetch(QUOTA_URL)
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { if (data) setQuota(data.quota); })
      .catch(function () { quotaLoaded = false; });
  }

  function addMessage(role, text) {
    var bubble = el("div", "kw-chat-msg is-" + role);
    bubble.innerHTML = render(text);
    list.appendChild(bubble);
    list.scrollTop = list.scrollHeight;
    return bubble;
  }

  var greeting = addMessage(
    "assistant",
    "Hi! I'm an AI assistant for Kun Wang's homepage. Ask me anything about his research and publications. 你也可以用中文提问。"
  );
  var chips = el("div", "kw-chat-suggestions");
  SUGGESTIONS.forEach(function (q) {
    var chip = el("button", null, q);
    chip.type = "button";
    chip.addEventListener("click", function () { send(q); });
    chips.appendChild(chip);
  });
  greeting.appendChild(chips);

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
  }

  async function send(question) {
    question = question.trim();
    if (!question || busy) return;
    if (chips.parentNode) chips.parentNode.removeChild(chips);

    history.push({ role: "user", content: question });
    addMessage("user", question);
    var bubble = addMessage("assistant", "");
    bubble.classList.add("is-typing");
    setBusy(true);

    var answer = "";
    var streamError = null;
    try {
      if (!ENDPOINT) throw new Error("Chat is not configured yet.");
      var res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-MAX_HISTORY) }),
      });
      if (!res.ok) {
        var data = null;
        try { data = await res.json(); } catch (e) { /* not JSON */ }
        if (data) setQuota(data.quota);
        throw new Error((data && data.message) || "Request failed (" + res.status + ").");
      }

      // Events: {choices:[{delta:{content}}]} text, {status} progress, {quota} %, {error}.
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop();
        lines.forEach(function (line) {
          line = line.trim();
          if (line.indexOf("data:") !== 0) return;
          var payload = line.slice(5).trim();
          if (payload === "[DONE]") return;
          var event;
          try { event = JSON.parse(payload); } catch (e) { return; }
          if (event.quota !== undefined) setQuota(event.quota);
          else if (event.error) streamError = event.error;
          else if (event.status) {
            if (!answer) bubble.innerHTML = "<em>" + escapeHtml(event.status) + "</em>";
          } else {
            var delta = event.choices && event.choices[0] && event.choices[0].delta;
            if (delta && delta.content) answer += delta.content;
          }
        });
        if (answer) bubble.innerHTML = render(answer);
        list.scrollTop = list.scrollHeight;
      }
      if (!answer) throw new Error(streamError || "No response. Please try again.");
      if (streamError) bubble.innerHTML = render(answer + "\n\n(" + streamError + ")");
      history.push({ role: "assistant", content: answer });
    } catch (err) {
      history.pop(); // drop the unanswered question
      bubble.classList.add("is-error");
      bubble.textContent = err.message || "Something went wrong.";
    } finally {
      bubble.classList.remove("is-typing");
      setBusy(false);
      input.focus();
    }
  }

  function open() {
    panel.hidden = false;
    launcher.classList.add("is-hidden");
    loadQuota();
    input.focus();
  }

  function close() {
    panel.hidden = true;
    launcher.classList.remove("is-hidden");
    launcher.focus();
  }

  function ask(question) {
    open();
    if (busy) input.value = question;
    else send(question);
  }

  // Any element with data-chat-ask (e.g. the research map) opens the chat with that question.
  document.addEventListener("click", function (e) {
    var trigger = e.target.closest && e.target.closest("[data-chat-ask]");
    if (!trigger) return;
    e.preventDefault();
    ask(trigger.getAttribute("data-chat-ask"));
  });
  window.kwChat = { open: open, ask: ask };

  launcher.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  panel.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value;
    input.value = "";
    send(q);
  });
  input.addEventListener("keydown", function (e) {
    // Enter sends, Shift+Enter adds a newline; ignore Enter while an IME is composing.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit"));
    }
  });

  document.body.appendChild(launcher);
  document.body.appendChild(panel);
})();