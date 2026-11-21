
const $ = id => document.getElementById(id);

const state = {
  user: null,
  messages: [],
  chatId: null,
  files: [],
  sending: false,
  settings: {
    style: "balanced",
    persona: "helpful",
    instructions: ""
  },
  imageUrl: null
};

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

function toast(message) {
  const element = $("toast");
  element.textContent = message;
  element.classList.add("show");

  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    element.classList.remove("show");
  }, 2800);
}

function showAuthError(message) {
  $("authError").textContent = message;
}

function showApp(user) {
  state.user = user;

  $("authScreen").classList.add("hidden");
  $("app").classList.remove("hidden");

  $("usernameDisplay").textContent = user.username;
  $("userAvatar").textContent = (user.username || "G")[0].toUpperCase();
  $("accountType").textContent = user.guest ? "Guest account" : "Registered account";

  loadHistory();
}

function showAuth() {
  $("app").classList.add("hidden");
  $("authScreen").classList.remove("hidden");
}

async function checkSession() {
  try {
    const data = await api("/api/me");

    if (data.user) {
      showApp(data.user);
    } else {
      showAuth();
    }
  } catch {
    showAuth();
  }
}

// --------------------------------------------------
// LOGIN / REGISTER / GUEST
// --------------------------------------------------

document.querySelectorAll(".auth-tab").forEach(button => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach(tab => {
      tab.classList.remove("active");
    });

    button.classList.add("active");

    const register = button.dataset.auth === "register";

    $("loginForm").classList.toggle("hidden", register);
    $("registerForm").classList.toggle("hidden", !register);

    showAuthError("");
  });
});

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  showAuthError("");

  const form = new FormData(event.currentTarget);

  try {
    const data = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password")
      })
    });

    showApp(data.user);
    toast("Welcome back!");
  } catch (err) {
    showAuthError(err.message);
  }
});

$("registerForm").addEventListener("submit", async event => {
  event.preventDefault();
  showAuthError("");

  const form = new FormData(event.currentTarget);

  try {
    const data = await api("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.get("username"),
        email: form.get("email"),
        password: form.get("password")
      })
    });

    showApp(data.user);
    toast("Account created successfully!");
  } catch (err) {
    showAuthError(err.message);
  }
});

$("guestBtn").addEventListener("click", async () => {
  showAuthError("");

  try {
    const data = await api("/api/guest", {
      method: "POST"
    });

    showApp(data.user);
    toast("Welcome, Guest!");
  } catch (err) {
    showAuthError(err.message);
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    state.user = null;
    state.messages = [];
    state.chatId = null;
    showAuth();
    toast("Logged out.");
  } catch (err) {
    toast(err.message);
  }
});

// --------------------------------------------------
// SIDEBAR
// --------------------------------------------------

$("menuBtn").addEventListener("click", () => {
  $("sidebar").classList.add("open");
});

$("closeSidebar").addEventListener("click", () => {
  $("sidebar").classList.remove("open");
});

function newChat() {
  state.messages = [];
  state.chatId = null;

  $("messages").innerHTML = "";
  $("welcome").classList.remove("hidden");
  $("messageInput").value = "";
  $("fileInput").value = "";
  state.files = [];

  renderAttachments();
  $("sidebar").classList.remove("open");
  $("messageInput").focus();
}

$("newChatBtn").addEventListener("click", newChat);

// --------------------------------------------------
// CHAT HISTORY
// --------------------------------------------------

async function loadHistory() {
  const container = $("chatHistory");

  if (!state.user || state.user.guest) {
    container.innerHTML =
      '<p class="muted tiny">Register to save your conversations.</p>';
    return;
  }

  try {
    const data = await api("/api/chats");

    container.innerHTML = "";

    if (!data.chats.length) {
      container.innerHTML =
        '<p class="muted tiny">No saved conversations yet.</p>';
      return;
    }

    data.chats.forEach(chat => {
      const item = document.createElement("div");
      item.className = "history-item";

      const title = document.createElement("span");
      title.className = "history-title";
      title.textContent = chat.title || "New conversation";

      title.addEventListener("click", () => openChat(chat.id));

      const remove = document.createElement("button");
      remove.className = "delete-chat";
      remove.textContent = "✕";
      remove.title = "Delete conversation";

      remove.addEventListener("click", async event => {
        event.stopPropagation();

        if (!confirm("Delete this conversation?")) return;

        try {
          await api("/api/chats/" + encodeURIComponent(chat.id), {
            method: "DELETE"
          });

          if (state.chatId === chat.id) newChat();

          loadHistory();
        } catch (err) {
          toast(err.message);
        }
      });

      item.append(title, remove);
      container.appendChild(item);
    });
  } catch (err) {
    container.textContent = err.message;
  }
}

async function openChat(id) {
  try {
    const data = await api("/api/chats/" + encodeURIComponent(id));

    state.chatId = data.chat.id;
    state.messages = data.chat.messages || [];

    $("messages").innerHTML = "";
    $("welcome").classList.add("hidden");

    state.messages.forEach(message => {
      renderMessage(message.role, message.content);
    });

    $("sidebar").classList.remove("open");
    scrollToBottom();
  } catch (err) {
    toast(err.message);
  }
}

// --------------------------------------------------
// MESSAGE DISPLAY
// --------------------------------------------------

function renderMessage(role, content) {
  const wrapper = document.createElement("div");
  wrapper.className = "message";

  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "assistant" ? "S" : "U";

  const contentBox = document.createElement("div");
  contentBox.className = "message-content";

  const roleLabel = document.createElement("div");
  roleLabel.className = "message-role";
  roleLabel.textContent = role === "assistant"
    ? "StackNetwork"
    : (state.user?.username || "You");

  const body = document.createElement("div");
  body.className = "message-body";

  // Use textContent so AI responses cannot inject HTML or scripts.
  body.textContent = String(content || "");

  contentBox.append(roleLabel, body);
  wrapper.append(avatar, contentBox);

  $("messages").appendChild(wrapper);
  return body;
}

function scrollToBottom() {
  const area = $("chatArea");
  area.scrollTop = area.scrollHeight;
}

function setSending(value) {
  state.sending = value;
  $("sendBtn").disabled = value;
  $("sendBtn").textContent = value ? "…" : "➤";
}

// --------------------------------------------------
// ATTACHMENTS
// --------------------------------------------------

$("attachBtn").addEventListener("click", () => {
  $("fileInput").click();
});

$("fileInput").addEventListener("change", event => {
  const selected = Array.from(event.target.files || []);

  for (const file of selected) {
    if (state.files.length >= 4) {
      toast("Maximum 4 files per message.");
      break;
    }

    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf"
    ];

    if (!allowed.includes(file.type)) {
      toast("Unsupported file type: " + file.name);
      continue;
    }

    if (file.size > 8 * 1024 * 1024) {
      toast("File must be 8 MB or smaller.");
      continue;
    }

    state.files.push(file);
  }

  $("fileInput").value = "";
  renderAttachments();
});

function renderAttachments() {
  const container = $("attachmentPreview");
  container.innerHTML = "";

  state.files.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "attachment";

    const label = document.createElement("span");
    label.textContent = "📎 " + file.name;

    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.addEventListener("click", () => {
      state.files.splice(index, 1);
      renderAttachments();
    });

    item.append(label, remove);
    container.appendChild(item);
  });
}

// --------------------------------------------------
// SEND CHAT MESSAGE
// --------------------------------------------------

async function sendMessage() {
  if (state.sending) return;

  const input = $("messageInput");
  const text = input.value.trim();

  if (!text && !state.files.length) return;

  const userMessage = {
    role: "user",
    content: text
  };

  state.messages.push(userMessage);

  $("welcome").classList.add("hidden");
  renderMessage("user", text || "📎 Attached files");
  scrollToBottom();

  input.value = "";
  input.style.height = "auto";

  const selectedFiles = [...state.files];
  state.files = [];
  renderAttachments();

  const loading = renderMessage("assistant", "StackNetwork is thinking...");
  setSending(true);

  try {
    const form = new FormData();

    form.append("messages", JSON.stringify(state.messages));
    form.append("mode", $("modeSelect").value);
    form.append("answerLength", $("lengthSelect").value);
    form.append("webSearch", String($("webSearch").checked));
    form.append("style", state.settings.style);
    form.append("persona", state.settings.persona);
    form.append("instructions", state.settings.instructions);

    if (state.chatId) {
      form.append("chatId", state.chatId);
    }

    selectedFiles.forEach(file => {
      form.append("files", file);
    });

    const response = await fetch("/api/chat", {
      method: "POST",
      credentials: "same-origin",
      body: form
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "AI request failed.");
    }

    loading.textContent = data.reply || "No response received.";

    state.messages.push({
      role: "assistant",
      content: data.reply
    });

    if (data.chatId) {
      state.chatId = data.chatId;
    }

    if (data.webResults?.length) {
      const links = document.createElement("div");
      links.className = "message-body";

      const heading = document.createElement("p");
      heading.textContent = "Web sources:";
      links.appendChild(heading);

      data.webResults.forEach(result => {
        try {
          const url = new URL(result.url);

          if (!["https:", "http:"].includes(url.protocol)) return;

          const link = document.createElement("a");
          link.href = url.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = result.title || url.hostname;
          link.style.display = "block";
          link.style.color = "#b6a9ff";

          links.appendChild(link);
        } catch {}
      });

      loading.parentElement.appendChild(links);
    }

    loadHistory();
  } catch (err) {
    loading.textContent = "⚠️ " + err.message;

    // Remove the failed user message from local history so it can be retried.
    state.messages.pop();
  } finally {
    setSending(false);
    scrollToBottom();
  }
}

$("sendBtn").addEventListener("click", sendMessage);

$("messageInput").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

$("messageInput").addEventListener("input", event => {
  const input = event.target;
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
});

// --------------------------------------------------
// SUGGESTION BUTTONS
// --------------------------------------------------

document.querySelectorAll(".suggestion").forEach(button => {
  button.addEventListener("click", () => {
    $("messageInput").value = button.dataset.prompt;
    sendMessage();
  });
});

// --------------------------------------------------
// SETTINGS
// --------------------------------------------------

$("settingsBtn").addEventListener("click", () => {
  $("styleSelect").value = state.settings.style;
  $("personaSelect").value = state.settings.persona;
  $("customInstructions").value = state.settings.instructions;

  $("settingsModal").classList.remove("hidden");
});

$("saveSettingsBtn").addEventListener("click", () => {
  state.settings.style = $("styleSelect").value;
  state.settings.persona = $("personaSelect").value;
  state.settings.instructions = $("customInstructions").value.slice(0, 2000);

  $("settingsModal").classList.add("hidden");
  toast("Settings saved.");
});

// --------------------------------------------------
// IMAGE GENERATION
// --------------------------------------------------

$("imageBtn").addEventListener("click", () => {
  $("imageModal").classList.remove("hidden");
  $("imagePrompt").focus();
});

$("generateImageBtn").addEventListener("click", async () => {
  const prompt = $("imagePrompt").value.trim();

  if (!prompt) {
    $("imageStatus").textContent = "Please enter an image description.";
    return;
  }

  if (prompt.length > 1000) {
    $("imageStatus").textContent = "Maximum prompt length is 1000 characters.";
    return;
  }

  const button = $("generateImageBtn");

  button.disabled = true;
  button.textContent = "Generating...";
  $("imageStatus").textContent = "Creating your image. This can take a little while.";
  $("generatedImage").innerHTML = "";

  try {
    const response = await fetch("/api/images/generate", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || "Image generation failed.");
    }

    const blob = await response.blob();

    if (!blob.type.startsWith("image/")) {
      throw new Error("The server returned an invalid image.");
    }

    if (state.imageUrl) {
      URL.revokeObjectURL(state.imageUrl);
    }

    state.imageUrl = URL.createObjectURL(blob);

    const image = document.createElement("img");
    image.src = state.imageUrl;
    image.alt = "Generated image";

    const download = document.createElement("a");
    download.href = state.imageUrl;
    download.download = "stacknetwork-generated-image.png";
    download.textContent = "⬇ Download image";

    $("generatedImage").append(image, download);
    $("imageStatus").textContent = "Image created successfully!";

    // Add generated image to the current chat view.
    $("welcome").classList.add("hidden");

    const messageBody = renderMessage("assistant", "🎨 Here is your generated image:");
    const preview = document.createElement("img");
    preview.src = state.imageUrl;
    preview.alt = "Generated image";
    messageBody.appendChild(preview);

    scrollToBottom();
  } catch (err) {
    $("imageStatus").textContent = "⚠️ " + err.message;
  } finally {
    button.disabled = false;
    button.textContent = "Generate image";
  }
});

// --------------------------------------------------
// MODAL CONTROLS
// --------------------------------------------------

document.querySelectorAll(".close-modal").forEach(button => {
  button.addEventListener("click", () => {
    $("settingsModal").classList.add("hidden");
    $("imageModal").classList.add("hidden");
  });
});

document.querySelectorAll(".modal").forEach(modal => {
  modal.addEventListener("click", event => {
    if (event.target === modal) {
      modal.classList.add("hidden");
    }
  });
});

// --------------------------------------------------
// START
// --------------------------------------------------

checkSession();
