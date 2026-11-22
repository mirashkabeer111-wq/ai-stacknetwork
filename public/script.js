const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  messages: [],
  chatId: null,
  files: [],
  busy: false,
  authMode: "login"
};

/* -------------------- API -------------------- */

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }

  return data;
}

/* -------------------- AUTH -------------------- */

function showAuth(show = true) {
  $("authModal").classList.toggle("show", show);
}

function setAuthMode(mode) {
  state.authMode = mode;

  const registering = mode === "register";

  $("authTitle").textContent = registering
    ? "Create your account"
    : "Welcome to StackNetwork";

  $("authDescription").textContent = registering
    ? "Create an account to save your conversations."
    : "Sign in to continue chatting.";

  $("registerFields").classList.toggle("hidden", !registering);

  $("authSubmit").textContent = registering
    ? "Create account"
    : "Sign in";

  $("authSwitch").innerHTML = registering
    ? 'Already have an account? <a href="#" id="switchAuth">Sign in</a>'
    : 'Don\'t have an account? <a href="#" id="switchAuth">Create account</a>';

  $("switchAuth").addEventListener("click", (event) => {
    event.preventDefault();
    setAuthMode(registering ? "login" : "register");
  });

  $("authError").textContent = "";
}

async function checkLogin() {
  try {
    const data = await api("/api/me");

    if (data.user) {
      setUser(data.user);
      await loadHistory();
    } else {
      setAuthMode("login");
      showAuth(true);
    }
  } catch (error) {
    setAuthMode("login");
    showAuth(true);
    console.error(error);
  }
}

function setUser(user) {
  state.user = user;

  $("usernameDisplay").textContent = user.username;
  $("userAvatar").textContent =
    user.username.charAt(0).toUpperCase();

  showAuth(false);
}

$("authSubmit").addEventListener("click", async () => {
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;

  const username = $("authUsername").value.trim();

  if (!email || !password) {
    $("authError").textContent = "Enter your email and password.";
    return;
  }

  if (state.authMode === "register" && !username) {
    $("authError").textContent = "Enter a username.";
    return;
  }

  $("authSubmit").disabled = true;
  $("authError").textContent = "Please wait...";

  try {
    const endpoint = state.authMode === "register"
      ? "/api/auth/register"
      : "/api/auth/login";

    const body = {
      email,
      password,
      username
    };

    const data = await api(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    setUser(data.user);
    await loadHistory();
  } catch (error) {
    $("authError").textContent = error.message;
  } finally {
    $("authSubmit").disabled = false;
  }
});

$("guestBtn").addEventListener("click", async () => {
  try {
    const data = await api("/api/guest", {
      method: "POST"
    });

    setUser(data.user);
    state.messages = [];
    state.chatId = null;
    renderMessages();
  } catch (error) {
    $("authError").textContent = error.message;
  }
});

$("closeAuth").addEventListener("click", () => {
  if (state.user) showAuth(false);
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", {
      method: "POST"
    });

    state.user = null;
    state.messages = [];
    state.chatId = null;
    state.files = [];

    renderMessages();
    renderFiles();
    $("chatHistory").innerHTML = "";

    setAuthMode("login");
    showAuth(true);
  } catch (error) {
    alert(error.message);
  }
});

/* -------------------- CHAT -------------------- */

function newChat() {
  state.messages = [];
  state.chatId = null;
  state.files = [];

  renderMessages();
  renderFiles();

  $("messageInput").value = "";
  $("welcome").style.display = "block";
}

$("newChatBtn").addEventListener("click", newChat);

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };

    return replacements[character];
  });
}

function formatMessage(text) {
  let output = escapeHTML(text);

  // Code blocks
  output = output.replace(
    /```([\w-]*)\n?([\s\S]*?)```/g,
    (_, language, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    }
  );

  // Inline code
  output = output.replace(
    /`([^`]+)`/g,
    "<code>$1</code>"
  );

  // Bold
  output = output.replace(
    /\*\*(.*?)\*\*/g,
    "<strong>$1</strong>"
  );

  // Italic
  output = output.replace(
    /\*(.*?)\*/g,
    "<em>$1</em>"
  );

  // New lines
  output = output.replace(/\n/g, "<br>");

  return output;
}

function renderMessages() {
  const container = $("messages");
  container.innerHTML = "";

  $("welcome").style.display =
    state.messages.length ? "none" : "block";

  for (const message of state.messages) {
    const item = document.createElement("div");

    item.className = "message " + message.role;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent =
      message.role === "user" ? "U" : "S";

    const content = document.createElement("div");
    content.className = "message-content";

    content.innerHTML = formatMessage(message.content || "");

    item.appendChild(avatar);
    item.appendChild(content);

    container.appendChild(item);
  }

  const area = $("chatArea");
  area.scrollTop = area.scrollHeight;
}

function showThinking() {
  const item = document.createElement("div");

  item.className = "message assistant";
  item.id = "thinkingMessage";

  item.innerHTML = `
    <div class="message-avatar">S</div>
    <div class="message-content">Thinking...</div>
  `;

  $("messages").appendChild(item);
  $("chatArea").scrollTop = $("chatArea").scrollHeight;
}

async function sendMessage() {
  if (state.busy) return;

  if (!state.user) {
    showAuth(true);
    return;
  }

  const message = $("messageInput").value.trim();

  if (!message && state.files.length === 0) {
    return;
  }

  const outgoing = message || "Please analyze my attached file.";

  state.busy = true;

  $("sendBtn").disabled = true;
  $("sendBtn").textContent = "…";

  const form = new FormData();

  // IMPORTANT: The server expects "message".
  form.append("message", message);

  form.append("chatId", state.chatId || "");
  form.append("mode", $("modeSelect").value);

  // The server expects the file field to be named "files".
  state.files.forEach((file) => {
    form.append("files", file);
  });

  $("messageInput").value = "";
  $("messageInput").style.height = "auto";

  const filesBeforeSend = [...state.files];

  state.files = [];
  renderFiles();

  showThinking();

  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: form
    });

    $("thinkingMessage")?.remove();

    state.chatId = data.chatId;

    state.messages.push({
      role: "user",
      content: outgoing
    });

    state.messages.push({
      role: "assistant",
      content: data.reply || data.answer || "No response received."
    });

    renderMessages();

    await loadHistory();

  } catch (error) {
    $("thinkingMessage")?.remove();

    state.files = filesBeforeSend;
    renderFiles();

    state.messages.push({
      role: "assistant",
      content: "⚠️ " + error.message
    });

    renderMessages();

  } finally {
    state.busy = false;
    $("sendBtn").disabled = false;
    $("sendBtn").textContent = "↑";
    $("messageInput").focus();
  }
}

$("sendBtn").addEventListener("click", sendMessage);

$("messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

$("messageInput").addEventListener("input", () => {
  const input = $("messageInput");

  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

/* -------------------- FILE UPLOAD -------------------- */

$("attachBtn").addEventListener("click", () => {
  $("fileInput").click();
});

$("fileInput").addEventListener("change", (event) => {
  const newFiles = Array.from(event.target.files);

  const allowedTypes = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "text/javascript",
    "text/html",
    "text/css",
    "application/xml"
  ];

  for (const file of newFiles) {
    if (file.size > 10 * 1024 * 1024) {
      alert(file.name + " is larger than 10 MB.");
      continue;
    }

    if (
      !allowedTypes.includes(file.type) &&
      !/\.(txt|md|csv|json|js|html|css|xml|log)$/i.test(file.name)
    ) {
      alert(file.name + " is not a supported file.");
      continue;
    }

    if (state.files.length >= 5) {
      alert("You can attach up to 5 files.");
      break;
    }

    state.files.push(file);
  }

  renderFiles();
  event.target.value = "";
});

function renderFiles() {
  const container = $("attachmentPreview");
  container.innerHTML = "";

  state.files.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "file-chip";

    const name = document.createElement("span");
    name.textContent = file.name;

    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.type = "button";

    remove.addEventListener("click", () => {
      state.files.splice(index, 1);
      renderFiles();
    });

    chip.appendChild(name);
    chip.appendChild(remove);

    container.appendChild(chip);
  });
}

/* -------------------- CHAT HISTORY -------------------- */

async function loadHistory() {
  if (!state.user || state.user.guest) {
    $("chatHistory").innerHTML = "";
    return;
  }

  try {
    const data = await api("/api/chats");

    const container = $("chatHistory");
    container.innerHTML = "";

    data.chats.forEach((chat) => {
      const item = document.createElement("div");

      item.className =
        "history-item" +
        (state.chatId === chat.id ? " active" : "");

      item.textContent = chat.title;

      item.addEventListener("click", () => {
        openChat(chat.id);
      });

      container.appendChild(item);
    });
  } catch (error) {
    console.error("History error:", error);
  }
}

async function openChat(chatId) {
  try {
    const data = await api("/api/chats/" + encodeURIComponent(chatId));

    state.chatId = data.chat.id;
    state.messages = data.chat.messages || [];

    renderMessages();
    await loadHistory();

    $("sidebar").classList.remove("open");
  } catch (error) {
    alert(error.message);
  }
}

/* -------------------- SUGGESTIONS -------------------- */

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    $("messageInput").value = button.dataset.prompt;
    $("messageInput").focus();
    sendMessage();
  });
});

/* -------------------- SETTINGS -------------------- */

$("settingsBtn").addEventListener("click", () => {
  $("settingsMode").value = $("modeSelect").value;
  $("settingsModal").classList.add("show");
});

$("closeSettings").addEventListener("click", () => {
  $("settingsModal").classList.remove("show");
});

$("saveSettings").addEventListener("click", () => {
  $("modeSelect").value = $("settingsMode").value;

  localStorage.setItem(
    "stacknetwork_mode",
    $("settingsMode").value
  );

  localStorage.setItem(
    "stacknetwork_instructions",
    $("instructions").value
  );

  $("settingsModal").classList.remove("show");
  alert("Settings saved!");
});

$("clearChat").addEventListener("click", async () => {
  if (!confirm("Clear this conversation?")) return;

  if (state.chatId && state.user && !state.user.guest) {
    try {
      await api("/api/chats/" + encodeURIComponent(state.chatId), {
        method: "DELETE"
      });
    } catch (error) {
      console.error(error);
    }
  }

  newChat();
  await loadHistory();

  $("settingsModal").classList.remove("show");
});

/* -------------------- MOBILE MENU -------------------- */

$("menuBtn").addEventListener("click", () => {
  $("sidebar").classList.toggle("open");
});

/* -------------------- START -------------------- */

const savedMode = localStorage.getItem("stacknetwork_mode");

if (savedMode) {
  $("modeSelect").value = savedMode;
  $("settingsMode").value = savedMode;
}

$("instructions").value =
  localStorage.getItem("stacknetwork_instructions") || "";

checkLogin();
