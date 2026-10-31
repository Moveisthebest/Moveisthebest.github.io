/* "Chat with me" floating widget.
   Talks to the chat proxy in /chat-server; the DeepSeek key never reaches the
   browser. Set the proxy URL via data-endpoint on the script tag.
   Past chats are kept in this browser's localStorage, not per IP, so visitors
   sharing a network never see each other's conversations. */
(function () {
  var script = document.currentScript;
  var ENDPOINT = script && script.getAttribute("data-endpoint");
  var QUOTA_URL = ENDPOINT && ENDPOINT.replace(/\/chat$/, "/quota");
  var STORE_KEY = "kwChat.conversations";
  var VISITOR_KEY = "kwChat.visitor";
  var MAX_CONVERSATIONS = 30;
  var MAX_STORED_MESSAGES = 100;
  var MAX_HISTORY = 10; // messages sent to the server per question
  var GREETING =
    "Hi! I'm an AI assistant for Kun Wang's homepage. Ask me anything about his research and publications. 你也可以用中文提问。";
  var SUGGESTIONS = [
    "What are Kun Wang's main research interests?",
    "What problem does NPUGen solve?",
    "Summarize the LATTE paper.",
  ];

  var conversation = newConversation();
  var busy = false;
  var quotaLoaded = false;
  var chips = null;

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

  // ---- visitor ID ------------------------------------------------------------

  // Random per-browser ID; the proxy combines it with the IP to tell visitors apart.
  var fallbackVisitor = null;

  function randomId() {
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  function visitorId() {
    try {
      var id = localStorage.getItem(VISITOR_KEY);
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(id || "")) {
        id = randomId();
        localStorage.setItem(VISITOR_KEY, id);
      }
      return id;
    } catch (e) {
      return fallbackVisitor || (fallbackVisitor = randomId());
    }
  }

  // ---- saved conversations (localStorage) ---------------------------------

  function newConversation() {
    return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: "", messages: [] };
  }

  function loadConversations() {
    try {
      var data = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
      return Array.isArray(data)
        ? data.filter(function (c) { return c && c.id && Array.isArray(c.messages) && c.messages.length; })
        : [];
    } catch (e) {
      return [];
    }
  }

  function storeConversations(list) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch (e) {
      // storage disabled or full: chats just won't be remembered
    }
  }

  function titleFrom(text) {
    text = text.replace(/\s+/g, " ").trim();
    return text.length > 60 ? text.slice(0, 60) + "…" : text;
  }

  function saveConversation() {
    if (!conversation.messages.length) return;
    if (!conversation.title) conversation.title = titleFrom(conversation.messages[0].content);
    var saved = loadConversations().filter(function (c) { return c.id !== conversation.id; });
    saved.unshift({
      id: conversation.id,
      title: conversation.title,
      updated: Date.now(),
      messages: conversation.messages.slice(-MAX_STORED_MESSAGES),
    });
    storeConversations(saved.slice(0, MAX_CONVERSATIONS));
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  // ---- DOM -------------------------------------------------------------------

  var launcher = el("button", "kw-chat-launcher");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Chat with my AI twin");
  launcher.innerHTML =
    '<i class="fas fa-comments" aria-hidden="true"></i>' +
    '<span class="kw-chat-label-full">Chat With my AI Twin</span><span class="kw-chat-label-short">AI</span>';

  var panel = el("div", "kw-chat-panel");
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Chat about my research");

  var header = el("div", "kw-chat-header");
  var title = el("div");
  title.appendChild(el("strong", null, "Chat with me"));
  title.appendChild(el("small", null, "AI assistant · ask about my papers"));
  var expandBtn = el("button", "kw-chat-expand");
  expandBtn.type = "button";
  var closeBtn = el("button", "kw-chat-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close chat");
  var actions = el("div", "kw-chat-actions");
  actions.appendChild(expandBtn);
  actions.appendChild(closeBtn);
  header.appendChild(title);
  header.appendChild(actions);

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

  // Chat History dropdown + New chat.
  var toolbar = el("div", "kw-chat-toolbar");
  var historyBtn = el("button", "kw-chat-history-btn");
  historyBtn.type = "button";
  historyBtn.setAttribute("aria-expanded", "false");
  historyBtn.innerHTML = '<i class="fas fa-history" aria-hidden="true"></i> Chat History';
  var newBtn = el("button", "kw-chat-new-btn");
  newBtn.type = "button";
  newBtn.innerHTML = '<i class="fas fa-plus" aria-hidden="true"></i> New chat';
  var historyList = el("div", "kw-chat-history");
  historyList.hidden = true;
  toolbar.appendChild(historyBtn);
  toolbar.appendChild(newBtn);
  toolbar.appendChild(historyList);

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
  panel.appendChild(toolbar);
  panel.appendChild(list);
  panel.appendChild(form);
  panel.appendChild(note);

  function setExpanded(expanded) {
    panel.classList.toggle("is-expanded", expanded);
    var label = expanded ? "Shrink chat" : "Expand chat";
    expandBtn.innerHTML = '<i class="fas fa-' + (expanded ? "compress" : "expand") + '-alt" aria-hidden="true"></i>';
    expandBtn.setAttribute("aria-label", label);
    expandBtn.title = label;
  }
  setExpanded(false);

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
    fetch(QUOTA_URL, { headers: { "X-Chat-Visitor": visitorId() } })
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

  function showWelcome() {
    var greeting = addMessage("assistant", GREETING);
    chips = el("div", "kw-chat-suggestions");
    SUGGESTIONS.forEach(function (q) {
      var chip = el("button", null, q);
      chip.type = "button";
      chip.addEventListener("click", function () { send(q); });
      chips.appendChild(chip);
    });
    greeting.appendChild(chips);
  }

  // ---- Chat History ------------------------------------------------------------

  function renderHistory() {
    historyList.innerHTML = "";
    var saved = loadConversations();
    if (!saved.length) historyList.appendChild(el("div", "kw-chat-history-empty", "No previous chats yet."));
    saved.forEach(function (c) {
      var item = el("div", "kw-chat-history-item" + (c.id === conversation.id ? " is-current" : ""));
      var openBtn = el("button", "kw-chat-history-open");
      openBtn.type = "button";
      openBtn.appendChild(el("strong", null, c.title || "Untitled chat"));
      var questions = c.messages.filter(function (m) { return m.role === "user"; }).length;
      openBtn.appendChild(el("small", null, formatTime(c.updated) + " · " + questions + (questions === 1 ? " question" : " questions")));
      openBtn.addEventListener("click", function () { openConversation(c); });
      var deleteBtn = el("button", "kw-chat-history-delete", "×");
      deleteBtn.type = "button";
      deleteBtn.title = "Delete";
      deleteBtn.setAttribute("aria-label", "Delete this chat");
      deleteBtn.addEventListener("click", function (e) {
        e.stopPropagation(); // the list is re-rendered; keep the dropdown open
        deleteConversation(c.id);
      });
      item.appendChild(openBtn);
      item.appendChild(deleteBtn);
      historyList.appendChild(item);
    });
    historyList.appendChild(el("div", "kw-chat-history-note", "Chats are saved in this browser only."));
  }

  function toggleHistory(show) {
    if (show === undefined) show = historyList.hidden;
    if (show) renderHistory();
    historyList.hidden = !show;
    historyBtn.setAttribute("aria-expanded", String(show));
  }

  function clearMessages() {
    list.innerHTML = "";
    chips = null;
  }

  function startNewChat() {
    if (busy) return;
    conversation = newConversation();
    clearMessages();
    showWelcome();
    toggleHistory(false);
    input.focus();
  }

  function openConversation(saved) {
    if (busy) return;
    conversation = { id: saved.id, title: saved.title, messages: saved.messages.slice() };
    clearMessages();
    saved.messages.forEach(function (m) { addMessage(m.role, m.content); });
    toggleHistory(false);
    input.focus();
  }

  function deleteConversation(id) {
    storeConversations(loadConversations().filter(function (c) { return c.id !== id; }));
    if (id === conversation.id) {
      conversation = newConversation();
      clearMessages();
      showWelcome();
    }
    renderHistory();
  }

  // ---- asking ------------------------------------------------------------------

  // Follow a streaming answer only until the question reaches the top of the view,
  // so long answers can be read from the start without scrolling back up.
  function follow(questionBubble) {
    list.scrollTop = questionBubble.offsetTop - 12;
  }

  // Grow the input with its content, up to the CSS max-height.
  function autosize() {
    input.style.height = "auto";
    var height = input.scrollHeight + 2; // + borders (box-sizing: border-box)
    input.style.height = Math.min(height, 120) + "px";
    input.style.overflowY = height > 120 ? "auto" : "hidden";
  }

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    historyBtn.disabled = value;
    newBtn.disabled = value;
  }

  async function send(question) {
    question = question.trim();
    if (!question || busy) return;
    if (chips && chips.parentNode) chips.parentNode.removeChild(chips);
    toggleHistory(false);

    conversation.messages.push({ role: "user", content: question });
    var questionBubble = addMessage("user", question);
    var bubble = addMessage("assistant", "");
    bubble.classList.add("is-typing");
    setBusy(true);

    var answer = "";
    var streamError = null;
    try {
      if (!ENDPOINT) throw new Error("Chat is not configured yet.");
      var res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Chat-Visitor": visitorId() },
        body: JSON.stringify({ messages: conversation.messages.slice(-MAX_HISTORY) }),
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
        follow(questionBubble);
      }
      if (!answer) throw new Error(streamError || "No response. Please try again.");
      if (streamError) bubble.innerHTML = render(answer + "\n\n(" + streamError + ")");
      conversation.messages.push({ role: "assistant", content: answer });
      saveConversation();
    } catch (err) {
      conversation.messages.pop(); // drop the unanswered question
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
    toggleHistory(false);
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
    if (trigger) {
      e.preventDefault();
      ask(trigger.getAttribute("data-chat-ask"));
      return;
    }
    if (!historyList.hidden && !toolbar.contains(e.target)) toggleHistory(false);
  });
  window.kwChat = { open: open, ask: ask };

  launcher.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  expandBtn.addEventListener("click", function () {
    setExpanded(!panel.classList.contains("is-expanded"));
  });
  historyBtn.addEventListener("click", function () { toggleHistory(); });
  newBtn.addEventListener("click", startNewChat);
  panel.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!historyList.hidden) toggleHistory(false);
    else close();
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var q = input.value;
    input.value = "";
    autosize();
    send(q);
  });
  input.addEventListener("input", autosize);
  input.addEventListener("keydown", function (e) {
    // Enter sends, Shift+Enter adds a newline; ignore Enter while an IME is composing.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit"));
    }
  });

  showWelcome();
  document.body.appendChild(launcher);
  document.body.appendChild(panel);
})();