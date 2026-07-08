// nr-vse-webdev — /admin content editor: login gate + fetch-driven textarea
// editors for the Intro/Details/Contact page content. Vanilla JS, no
// framework, consistent with the rest of the site.
document.addEventListener("DOMContentLoaded", () => {
  const disabledPanel = document.getElementById("admin-disabled");
  const loginPanel = document.getElementById("login-panel");
  const editorPanel = document.getElementById("editor-panel");
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");
  const logoutBtn = document.getElementById("logout-btn");
  const messageBox = document.getElementById("admin-message");

  function showMessage(text, kind) {
    messageBox.textContent = text;
    messageBox.hidden = false;
    messageBox.classList.remove("admin-message-success", "admin-message-error");
    messageBox.classList.add(kind === "error" ? "admin-message-error" : "admin-message-success");
  }

  function showPanel(panel) {
    [disabledPanel, loginPanel, editorPanel].forEach((p) => {
      p.hidden = p !== panel;
    });
  }

  async function refreshStatus() {
    const res = await fetch("/admin/status");
    const status = await res.json();
    if (!status.adminEnabled) {
      showPanel(disabledPanel);
      return;
    }
    if (status.loggedIn) {
      showPanel(editorPanel);
      await loadContent();
    } else {
      showPanel(loginPanel);
    }
  }

  async function loadContent() {
    const res = await fetch("/admin/content");
    if (res.status === 401) {
      showPanel(loginPanel);
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      showMessage(data.error || "Failed to load content.", "error");
      return;
    }
    if (data.dbAvailable === false) {
      showMessage(
        "Azure SQL is unreachable right now — showing static fallback content. Edits can't be saved until the database is reachable.",
        "error"
      );
    }
    Object.entries(data.pages).forEach(([pageKey, page]) => {
      const card = document.querySelector(`[data-page-key="${pageKey}"]`);
      if (!card) return;
      const textarea = card.querySelector('[data-field="bodyHtml"]');
      const sourceTag = card.querySelector(".page-source");
      if (textarea) textarea.value = page.bodyHtml || "";
      if (sourceTag) {
        sourceTag.textContent = page.source === "database" ? "from database" : "static fallback";
      }
    });
  }

  loginForm.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    loginError.hidden = true;
    const password = document.getElementById("password").value;
    const res = await fetch("/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      loginForm.reset();
      showPanel(editorPanel);
      await loadContent();
    } else {
      loginError.textContent = data.error || "Login failed.";
      loginError.hidden = false;
    }
  });

  logoutBtn.addEventListener("click", async () => {
    await fetch("/admin/logout", { method: "POST" });
    showPanel(loginPanel);
  });

  document.querySelectorAll(".save-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pageKey = btn.dataset.pageKey;
      const card = document.querySelector(`[data-page-key="${pageKey}"]`);
      const textarea = card.querySelector('[data-field="bodyHtml"]');
      const statusEl = card.querySelector(".admin-status");
      statusEl.textContent = "Saving…";
      const res = await fetch(`/admin/content/${pageKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bodyHtml: textarea.value }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        statusEl.textContent = "Saved ✓";
        const sourceTag = card.querySelector(".page-source");
        if (sourceTag) sourceTag.textContent = "from database";
      } else {
        statusEl.textContent = data.error || "Save failed.";
      }
    });
  });

  refreshStatus();
});
