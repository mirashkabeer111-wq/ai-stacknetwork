"use strict";

const $ = id => document.getElementById(id);

const state = {
  user: null,
  chats: [],
  chatId: null,
  messages: [],
  files: [],
  sending: false,
  settings: {
    theme: "dark",
    sendOnEnter: true,
    responseStyle: "balanced",
    answerLength: "medium",
    customInstructions: ""
  }
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options
  });

  const contentType = response.headers.get("content-type") || "";

  let data = {};

  if (contentType.includes("application/json")) {
    data = await response.json();
  }

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

function toast(message) {
  const element = $("toast");

  if (!element) {
    console.log(message);
    return;
  }

  element.textContent = message;
  element.classList.add("show");

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    element.classList.remove("show");
  }, 2800);
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function applyTheme(theme) {
  const selected = theme === "light" ? "light" : "dark";

  state.settings.theme = selected;

  document.documentElement.dataset.theme = selected;
  document.body.dataset.theme = selected;

  localStorage.setItem("stacknetwork-theme", selected);

  const themeButton = $("themeBtn");

  if (themeButton) {
    themeButton.textContent = selected === "dark"
      ? "☀️"
      : "🌙";
    themeButton.title = selected === "dark"
      ? "Switch to light mode"
      : "Switch to dark mode";
  }

  const topTheme = $("topTheme");

  if (topTheme) {
    topTheme.textContent = selected === "dark"
      ? "☀️"
      : "🌙";
  }

  const themeSelect = $("themeSelect");

  if (themeSelect) {
    themeSelect.value = selected;
  }
}

function setLoading(loading) {
  state.sending = loading;

  const button = $("sendBtn");

  if (button) {
    button.disabled = loading;
    button.textContent = loading ? "..." : "➤";
  }

  const input = $("messageInput");

  if (input) {
    input.disabled = loading;
  }
}

function showApp() {
  $("loadingScreen")?.classList.add("hidden");
  $("authScreen")?.classList.add("hidden");
  $("app")?.classList.remove("hidden");
}

function showAuth() {
  $("loadingScreen")?.classList.add("hidden");
  $("app")?.classList.add("hidden");
  $("authScreen")?.classList.remove("hidden");
}

function setUser(user) {
  state.user = user;

  const username = $("usernameDisplay");
  const avatar = $("userAvatar");
  const accountType = $("accountType");

  if (username) {
    username.textContent = user.name;
  }

  if (avatar) {
    avatar.textContent = (user.name || "U")
      .charAt(0)
      .toUpperCase();
  }

  if (accountType) {
    accountType.textContent = user.guest
      ? "Guest account"
      : "Account";
  }
}

/* -------------------- AUTHENTICATION -------------------- */

async function checkSession() {
  try {
    const data = await api("/api/me");

    if (data.user) {
      setUser(data.user);
      showApp();

      await loadSettings();
      await loadChats();

      if (state.chats.length) {
        await openChat(state.chats[0].id);
      } else {
        newChat();
      }
    } else {
      showAuth();
    }
  } catch (error) {
    console.error(error);
    showAuth();
  }
}

async function login(email, password) {
  const data = await api("/api/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password })
  });

  setUser(data.user);
  showApp();

  await loadSettings();
  await loadChats();

  if (state.chats.length) {
    await openChat(state.chats[0].id);
  } else {
    newChat();
  }

  toast("Welcome back!");
}

async function register(name, email, password) {
  const data = await api("/api/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name, email, password })
  });

  setUser(data.user);
  showApp();

  await loadSettings();
  await loadChats();

  newChat();
  toast("Account created!");
}

async function guestLogin() {
  const data = await api("/api/guest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({})
  });

  setUser(data.user);
  showApp();

  await loadSettings();
  await loadChats();

  newChat();
  toast("Welcome to StackNetwork!");
}

async function logout() {
  try {
    await api("/api/logout", {
      method: "POST"
    });

    state.user = null;
    state.chats = [];
    state.messages = [];
    state.chatId = null;

    showAuth();
    toast("Logged out.");
  } catch (error) {
    toast(error.message);
  }
}

/* -------------------- SETTINGS -------------------- */

async function loadSettings() {
  try {
    const data = await api("/api/settings");

    state.settings = {
      ...state.settings,
      ...(data.settings || {})
    };

    applyTheme(state.settings.theme);
    syncSettingsControls();
  } catch (error) {
    console.error("Settings:", error);
  }
}

function syncSettingsControls() {
  const fields = {
    themeSelect: "theme",
    sendOnEnter: "sendOnEnter",
    styleSelect: "responseStyle",
    answerLengthSelect: "answerLength",
    lengthSelect: "answerLength",
    customInstructions: "customInstructions"
  };

  for (const [id, key] of Object.entries(fields)) {
    const element = $(id);

    if (!element) continue;

    if (element.type === "checkbox") {
      element.checked = Boolean(state.settings[key]);
    } else {
      element.value = state.settings[key] ?? "";
    }
  }

  const persona = $("personaSelect");

  if (persona && !state.settings.responseStyle) {
    persona.value = "balanced";
  }
}

async function saveSettings() {
  const theme = $("themeSelect")?.value ||
    state.settings.theme;

  const sendOnEnter = $("sendOnEnter")
    ? $("sendOnEnter").checked
    : state.settings.sendOnEnter;

  const responseStyle = $("styleSelect")?.value ||
    state.settings.responseStyle;

  const answerLength =
    $("answerLengthSelect")?.value ||
    $("lengthSelect")?.value ||
    state.settings.answerLength;

  const customInstructions =
    $("customInstructions")?.value ??
    state.settings.customInstructions;

  state.settings = {
    theme: theme === "light" ? "light" : "dark",
    sendOnEnter,
    responseStyle,
    answerLength,
    customInstructions
  };

  try {
    await api("/api/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        settings: state.settings
      })
    });

    applyTheme(state.settings.theme);
    toast("Settings saved!");
  } catch (error) {
    toast(error.message);
  }
}

function openSettings() {
  const modal = $("settingsModal");

  if (!modal) {
    createSettingsModal();
  } else {
    modal.classList.remove("hidden");
    modal.style.display = "flex";
  }

  syncSettingsControls();
}

function closeSettings() {
  const modal = $("settingsModal");

  if (modal) {
    modal.classList.add("hidden");
    modal.style.display = "none";
  }
}

function createSettingsModal() {
  const modal = document.createElement("div");

  modal.id = "settingsModal";
  modal.className = "modal";

  modal.innerHTML = `
    <div class="settings-panel">
      <div class="settings-header">
        <h2>Settings</h2>
        <button type="button" id="closeSettingsBtn">✕</button>
      </div>

      <div class="settings-content">

        <section class="settings-section">
          <h3>Appearance</h3>
          <label for="themeSelect">Theme</label>
          <select id="themeSelect">
            <option value="dark">Dark Mode</option>
            <option value="light">Light Mode</option>
          </select>
        </section>

        <section class="settings-section">
          <h3>Chat settings</h3>
          <label class="setting-check">
            <input type="checkbox" id="sendOnEnter">
            Press Enter to send
          </label>
          <p>Use Shift + Enter to create a new line.</p>
        </section>

        <section class="settings-section">
          <h3>AI preferences</h3>

          <label for="styleSelect">Response style</label>
          <select id="styleSelect">
            <option value="balanced">Balanced</option>
            <option value="friendly">Friendly</option>
            <option value="professional">Professional</option>
            <option value="simple">Simple</option>
            <option value="detailed">Detailed</option>
            <option value="creative">Creative</option>
          </select>

          <label for="answerLengthSelect">Answer length</label>
          <select id="answerLengthSelect">
            <option value="short">Short</option>
            <option value="medium">Medium</option>
            <option value="long">Long</option>
          </select>
        </section>

        <section class="settings-section">
          <h3>Personalization</h3>
          <label for="customInstructions">Custom instructions</label>
          <textarea
            id="customInstructions"
            rows="5"
            maxlength="3000"
            placeholder="Tell StackNetwork how you want it to respond..."
          ></textarea>
        </section>

        <section class="settings-section">
          <h3>Privacy</h3>
          <button type="button" id="clearCurrentChatBtn">
            Clear current conversation
          </button>
          <button type="button" id="clearHistoryBtn">
            Clear all chat history
          </button>
          <button type="button" id="deleteAccountBtn">
            Delete account
          </button>
        </section>

        <section class="settings-section">
          <h3>About</h3>
          <p><strong>StackNetwork</strong></p>
          <p>Version 5.1.0</p>
          <p>AI chat powered by Groq.</p>
        </section>

      </div>

      <div class="settings-footer">
        <button type="button" id="cancelSettingsBtn">Cancel</button>
        <button type="button" id="saveSettingsBtn">Save settings</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  addSettingsStyles();

  $("closeSettingsBtn").onclick = closeSettings;
  $("cancelSettingsBtn").onclick = closeSettings;
  $("saveSettingsBtn").onclick = async () => {
    await saveSettings();
    closeSettings();
  };

  $("themeSelect").onchange = event => {
    applyTheme(event.target.value);
  };

  $("clearCurrentChatBtn").onclick = clearCurrentChat;
  $("clearHistoryBtn").onclick = clearAllHistory;
  $("deleteAccountBtn").onclick = deleteAccount;

  syncSettingsControls();
}

function addSettingsStyles() {
  if ($("settingsExtraStyles")) return;

  const style = document.createElement("style");

  style.id = "settingsExtraStyles";

  style.textContent = `
    .settings-panel {
      width: min(560px, 94vw);
      max-height: 90vh;
      overflow-y: auto;
      background: var(--panel, #111827);
      color: var(--text, #fff);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 18px;
      padding: 22px;
      box-shadow: 0 20px 80px rgba(0,0,0,.4);
    }

    .settings-header,
    .settings-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .settings-section {
      padding: 17px 0;
      border-bottom: 1px solid rgba(128,128,128,.2);
    }

    .settings-section h3 {
      margin: 0 0 12px;
      font-size: 15px;
    }

    .settings-section label {
      display: block;
      margin: 10px 0 6px;
      font-size: 13px;
    }

    .settings-section select,
    .settings-section textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 11px;
      border-radius: 9px;
      border: 1px solid rgba(128,128,128,.3);
      background: var(--input-bg, #202938);
      color: inherit;
      margin-bottom: 10px;
    }

    .settings-section button,
    .settings-footer button,
    .settings-header button {
      padding: 10px 13px;
      border-radius: 9px;
      border: 1px solid rgba(128,128,128,.3);
      background: transparent;
      color: inherit;
      cursor: pointer;
      margin: 4px 4px 4px 0;
    }

    .settings-section p {
      opacity: .7;
      font-size: 12px;
    }

    .settings-footer {
      padding-top: 16px;
    }

    .settings-footer #saveSettingsBtn {
      background: #2563eb;
      border-color: #2563eb;
      color: white;
    }

    .setting-check {
      display: flex !important;
      align-items: center;
      gap: 9px;
    }

    body[data-theme="light"] .settings-panel {
      --panel: #fff;
      --text: #171717;
      --input-bg: #f1f2f5;
      background: #fff;
      color: #171717;
    }

    body[data-theme="light"] {
      background: #f7f8fc;
      color: #171717;
    }

    .modal {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(0,0,0,.65);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px;
    }

    .modal.hidden {
      display: none !important;
    }
  `;

  document.head.appendChild(style);
}

/* -------------------- CHAT HISTORY -------------------- */

async function loadChats() {
  try {
    const data = await api("/api/chats");

    state.chats = data.chats || [];

    renderChatHistory();
  } catch (error) {
    console.error(error);
  }
}

function renderChatHistory() {
  const container = $("chatHistory");

  if (!container) return;

  container.innerHTML = "";

  state.chats.forEach(chat => {
    const item = document.createElement("button");

    item.className = "history-item";

    if (chat.id === state.chatId) {
      item.classList.add("active");
    }

    item.textContent = chat.title || "New chat";
    item.dataset.chatId = chat.id;

    item.onclick = () => openChat(chat.id);

    container.appendChild(item);
  });
}

async function createChat() {
  const data = await api("/api/chats", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: "New chat"
    })
  });

  return data.chat;
}

async function newChat() {
  try {
    const chat = await createChat();

    state.chatId = chat.id;
    state.messages = [];

    renderMessages();
    await loadChats();

    $("welcome")?.classList.remove("hidden");

    const input = $("messageInput");

    if (input) input.focus();

    closeSidebar();
  } catch (error) {
    toast(error.message);
  }
}

async function openChat(id) {
  try {
    const data = await api(`/api/chats/${encodeURIComponent(id)}`);

    state.chatId = data.chat.id;
    state.messages = data.chat.messages || [];

    renderMessages();
    renderChatHistory();

    $("welcome")?.classList.toggle(
      "hidden",
      state.messages.length > 0
    );

    closeSidebar();
  } catch (error) {
    toast(error.message);
  }
}

async function clearCurrentChat() {
  if (!state.chatId) {
    toast("No conversation selected.");
    return;
  }

  if (!confirm("Delete this conversation?")) return;

  try {
    await api(`/api/chats/${encodeURIComponent(state.chatId)}`, {
      method: "DELETE"
    });

    state.chatId = null;
    state.messages = [];

    await loadChats();

    if (state.chats.length) {
      await openChat(state.chats[0].id);
    } else {
      await newChat();
    }

    toast("Conversation deleted.");
  } catch (error) {
    toast(error.message);
  }
}

async function clearAllHistory() {
  if (!confirm("Delete all your chat history? This cannot be undone.")) {
    return;
  }

  try {
    await api("/api/chats", {
      method: "DELETE"
    });

    state.chats = [];
    state.messages = [];
    state.chatId = null;

    await loadChats();
    await newChat();

    toast("Chat history cleared.");
  } catch (error) {
    toast(error.message);
  }
}

async function deleteAccount() {
  if (!confirm("Permanently delete your account and all chat history?")) {
    return;
  }

  try {
    await api("/api/account", {
      method: "DELETE"
    });

    state.user = null;
    state.chatId = null;
    state.messages = [];
    state.chats = [];

    showAuth();
    toast("Account deleted.");
  } catch (error) {
    toast(error.message);
  }
}

/* -------------------- MESSAGE DISPLAY -------------------- */

function renderMarkdown(text) {
  let output = escapeHTML(text);

  output = output.replace(
    /```([\w-]*)\n?([\s\S]*?)```/g,
    (_, language, code) =>
      `<pre><code>${code.trim()}</code></pre>`
  );

  output = output.replace(
    /`([^`]+)`/g,
    "<code>$1</code>"
  );

  output = output.replace(
    /\*\*(.*?)\*\*/g,
    "<strong>$1</strong>"
  );

  output = output.replace(
    /\*(.*?)\*/g,
    "<em>$1</em>"
  );

  output = output.replace(
    /\n/g,
    "<br>"
  );

  return output;
}

function renderMessages() {
  const container = $("messages");

  if (!container) return;

  container.innerHTML = "";

  state.messages.forEach(message => {
    addMessageElement(
      message.role,
      message.content,
      false
    );
  });

  container.scrollTop = container.scrollHeight;
}

function addMessageElement(role, content, scroll = true) {
  const container = $("messages");

  if (!container) return;

  const wrapper = document.createElement("div");

  wrapper.className = `message ${role === "user" ? "user-message" : "assistant-message"}`;

  const avatar = document.createElement("div");

  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "You" : "SN";

  const body = document.createElement("div");

  body.className = "message-content";
  body.innerHTML = renderMarkdown(content);

  wrapper.appendChild(avatar);
  wrapper.appendChild(body);

  if (role === "assistant") {
    const actions = document.createElement("div");

    actions.className = "message-actions";

    const copyButton = document.createElement("button");

    copyButton.textContent = "Copy";
    copyButton.title = "Copy response";

    copyButton.onclick = async () => {
      try {
        await navigator.clipboard.writeText(content);
        toast("Copied!");
      } catch {
        toast("Could not copy text.");
      }
    };

    actions.appendChild(copyButton);
    wrapper.appendChild(actions);
  }

  container.appendChild(wrapper);

  if (scroll) {
    container.scrollTop = container.scrollHeight;
  }

  return wrapper;
}

/* -------------------- SEND MESSAGE -------------------- */

function getSelectedFiles() {
  return state.files || [];
}

async function sendMessage() {
  if (state.sending) return;

  const input = $("messageInput");

  if (!input) return;

  const message = input.value.trim();
  const files = getSelectedFiles();

  if (!message && !files.length) return;

  setLoading(true);

  $("welcome")?.classList.add("hidden");

  const userDisplay = message || "Uploaded file";

  state.messages.push({
    role: "user",
    content: userDisplay
  });

  addMessageElement("user", userDisplay);

  input.value = "";
  input.style.height = "auto";

  const formData = new FormData();

  formData.append("message", message);
  formData.append("chatId", state.chatId || "");
  formData.append(
    "mode",
    $("modeSelect")?.value || "fast"
  );

  formData.append(
    "length",
    $("lengthSelect")?.value ||
    state.settings.answerLength ||
    "medium"
  );

  formData.append(
    "webSearch",
    $("webBtn")?.classList.contains("active") ? "true" : "false"
  );

  files.forEach(file => {
    formData.append("files", file);
  });

  const preview = $("attachmentPreview");

  if (preview) preview.innerHTML = "";

  state.files = [];

  if ($("fileInput")) {
    $("fileInput").value = "";
  }

  try {
    const data = await api("/api/chat", {
      method: "POST",
      body: formData
    });

    state.chatId = data.chatId;

    state.messages.push({
      role: "assistant",
      content: data.answer
    });

    addMessageElement("assistant", data.answer);

    await loadChats();
  } catch (error) {
    const errorMessage = `Sorry, something went wrong: ${error.message}`;

    state.messages.push({
      role: "assistant",
      content: errorMessage
    });

    addMessageElement("assistant", errorMessage);
  } finally {
    setLoading(false);
    input.focus();
  }
}

/* -------------------- FILE UPLOADS -------------------- */

function handleFiles(fileList) {
  const files = Array.from(fileList || []);

  const allowed = files.filter(file => {
    const valid =
      file.type.startsWith("image/") ||
      file.type === "application/pdf" ||
      file.type.startsWith("text/") ||
      file.type === "application/json";

    if (!valid) {
      toast(`${file.name} is not supported.`);
    }

    if (file.size > 10 * 1024 * 1024) {
      toast(`${file.name} is larger than 10 MB.`);
      return false;
    }

    return valid;
  });

  state.files = [...state.files, ...allowed].slice(0, 5);

  renderAttachmentPreview();
}

function renderAttachmentPreview() {
  const container = $("attachmentPreview");

  if (!container) return;

  container.innerHTML = "";

  state.files.forEach((file, index) => {
    const item = document.createElement("div");

    item.className = "attachment-item";

    const name = document.createElement("span");
    name.textContent = file.name;

    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Remove file";

    remove.onclick = () => {
      state.files.splice(index, 1);
      renderAttachmentPreview();
    };

    item.appendChild(name);
    item.appendChild(remove);

    container.appendChild(item);
  });
}

/* -------------------- IMAGE GENERATION -------------------- */

function openImageModal() {
  const modal = $("imageModal");

  if (modal) {
    modal.classList.remove("hidden");
    modal.style.display = "flex";
  }
}

function closeImageModal() {
  const modal = $("imageModal");

  if (modal) {
    modal.classList.add("hidden");
    modal.style.display = "none";
  }
}

async function generateImage() {
  const prompt = $("imagePrompt")?.value.trim();

  if (!prompt) {
    toast("Enter an image description.");
    return;
  }

  const button = $("generateImageBtn");
  const status = $("imageStatus");
  const image = $("generatedImage");

  if (button) {
    button.disabled = true;
    button.textContent = "Generating...";
  }

  if (status) {
    status.textContent = "Creating your image...";
  }

  if (image) {
    image.removeAttribute("src");
    image.classList.add("hidden");
  }

  try {
    const data = await api("/api/images/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prompt })
    });

    if (image) {
      image.src = data.image;
      image.classList.remove("hidden");
    }

    if (status) {
      status.textContent = "Image generated successfully!";
    }

    toast("Image generated!");
  } catch (error) {
    if (status) {
      status.textContent = error.message;
    }

    toast(error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Generate image";
    }
  }
}

/* -------------------- SIDEBAR / MOBILE -------------------- */

function closeSidebar() {
  $("sidebar")?.classList.remove("open");
  $("mobileBackdrop")?.classList.remove("show");
}

function toggleSidebar() {
  $("sidebar")?.classList.toggle("open");
  $("mobileBackdrop")?.classList.toggle("show");
}

/* -------------------- VOICE INPUT -------------------- */

function startVoiceInput() {
  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    toast("Voice input is not supported in this browser.");
    return;
  }

  const recognition = new SpeechRecognition();

  recognition.lang = "en-IN";
  recognition.interimResults = false;

  recognition.onresult = event => {
    const transcript = event.results[0][0].transcript;

    const input = $("messageInput");

    if (input) {
      input.value += (input.value ? " " : "") + transcript;
      input.focus();
    }
  };

  recognition.onerror = () => {
    toast("Voice input failed.");
  };

  recognition.start();
}

/* -------------------- EVENT LISTENERS -------------------- */

function bind(id, event, callback) {
  const element = $(id);

  if (element) {
    element.addEventListener(event, callback);
  }
}

function setupAuth() {
  bind("loginForm", "submit", async event => {
    event.preventDefault();

    const email = $("loginEmail")?.value.trim();
    const password = $("loginPassword")?.value;

    try {
      await login(email, password);
    } catch (error) {
      const target = $("loginError") || $("authError");

      if (target) target.textContent = error.message;
      else toast(error.message);
    }
  });

  bind("registerForm", "submit", async event => {
    event.preventDefault();

    const name = $("registerName")?.value.trim();
    const email = $("registerEmail")?.value.trim();
    const password = $("registerPassword")?.value;

    try {
      await register(name, email, password);
    } catch (error) {
      const target = $("registerError") || $("authError");

      if (target) target.textContent = error.message;
      else toast(error.message);
    }
  });

  bind("guestBtn", "click", async () => {
    try {
      await guestLogin();
    } catch (error) {
      toast(error.message);
    }
  });

  bind("showRegister", "click", () => {
    $("loginForm")?.classList.add("hidden");
    $("registerForm")?.classList.remove("hidden");
  });

  bind("showLogin", "click", () => {
    $("registerForm")?.classList.add("hidden");
    $("loginForm")?.classList.remove("hidden");
  });
}

function setupChat() {
  bind("sendBtn", "click", sendMessage);

  bind("messageInput", "keydown", event => {
    if (event.key === "Enter") {
      if (event.shiftKey) return;

      if (state.settings.sendOnEnter !== false) {
        event.preventDefault();
        sendMessage();
      }
    }
  });

  bind("messageInput", "input", event => {
    const input = event.target;

    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
  });

  bind("newChatBtn", "click", newChat);

  bind("attachBtn", "click", () => {
    $("fileInput")?.click();
  });

  bind("fileInput", "change", event => {
    handleFiles(event.target.files);
  });

  bind("voiceBtn", "click", startVoiceInput);

  bind("webBtn", "click", () => {
    $("webBtn")?.classList.toggle("active");

    toast(
      $("webBtn")?.classList.contains("active")
        ? "Web search enabled"
        : "Web search disabled"
    );
  });

  bind("imageBtn", "click", openImageModal);

  bind("generateImageBtn", "click", generateImage);

  bind("menuBtn", "click", toggleSidebar);

  bind("mobileBackdrop", "click", closeSidebar);

  bind("settingsBtn", "click", openSettings);

  bind("logoutBtn", "click", logout);

  bind("themeBtn", "click", () => {
    const next = state.settings.theme === "dark"
      ? "light"
      : "dark";

    applyTheme(next);
    saveSettings();
  });

  bind("topTheme", "click", () => {
    const next = state.settings.theme === "dark"
      ? "light"
      : "dark";

    applyTheme(next);
    saveSettings();
  });

  bind("saveSettingsBtn", "click", saveSettings);
}

/* -------------------- INITIALIZATION -------------------- */

async function initialize() {
  const savedTheme = localStorage.getItem("stacknetwork-theme");

  if (savedTheme === "light" || savedTheme === "dark") {
    applyTheme(savedTheme);
  }

  setupAuth();
  setupChat();

  try {
    const config = await api("/api/config");

    document.title = config.appName || "StackNetwork";
  } catch {}

  await checkSession();
}

document.addEventListener("DOMContentLoaded", initialize);
