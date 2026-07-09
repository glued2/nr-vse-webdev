// nr-vse-webdev — /admin content editor: Entra ID sign-in gate + fetch-driven
// Quill rich-text editors for the Intro/Details/Contact page content. Vanilla
// JS (Quill is the one exception, loaded locally from /vendor/quill — no
// build step, no CDN), consistent with the rest of the site.
document.addEventListener("DOMContentLoaded", () => {
  const disabledPanel = document.getElementById("admin-disabled");
  const loginPanel = document.getElementById("login-panel");
  const editorPanel = document.getElementById("editor-panel");
  const loginError = document.getElementById("login-error");
  const adminUsername = document.getElementById("admin-username");
  const messageBox = document.getElementById("admin-message");
  const navAdminItem = document.getElementById("nav-admin-item");
  const tabButtons = document.querySelectorAll(".admin-tab");
  const contentPanel = document.getElementById("content-panel");
  const statsPanel = document.getElementById("stats-panel");
  const statsDisabled = document.getElementById("stats-disabled");
  const statsError = document.getElementById("stats-error");
  const statsContent = document.getElementById("stats-content");
  const statsHitsBody = document.getElementById("stats-hits-body");
  const statsGamesBody = document.getElementById("stats-games-body");
  const statsBarChart = document.getElementById("stats-bar-chart");

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  // Reflects sign-in state in the "Admin" nav item itself: signed out shows
  // a plain link to /admin (unchanged); signed in swaps it for a "Signed in
  // as ..." indicator plus a sign-out link, driven off the same
  // /admin/status response the rest of this page already uses.
  function updateNavAdminItem(status) {
    if (!navAdminItem) return;
    if (status.loggedIn && status.user) {
      const label = status.user.name || status.user.username || "admin";
      navAdminItem.innerHTML =
        `<span class="nav-admin-user">Signed in as <strong>${escapeHtml(label)}</strong></span>` +
        `<a href="/auth/logout" class="nav-admin-logout">Sign out</a>`;
    } else {
      navAdminItem.innerHTML = `<a href="/admin">Admin</a>`;
    }
  }

  // Sign-in failures land back here as /admin?error=... (see server.js's
  // /auth/callback) since a full Entra redirect flow can't report errors any
  // other way than a query param.
  const SIGN_IN_ERRORS = {
    access_denied:
      "Sign-in was denied — your Microsoft account isn't assigned to this application.",
    sign_in_failed: "Sign-in failed. Please try again.",
  };
  const errorParam = new URLSearchParams(window.location.search).get("error");
  if (errorParam) {
    loginError.textContent = SIGN_IN_ERRORS[errorParam] || "Sign-in failed. Please try again.";
    loginError.hidden = false;
    window.history.replaceState({}, "", "/admin");
  }

  // pageKey -> Quill instance, created lazily the first time the editor
  // panel is shown (Quill needs a visible/laid-out container to size its
  // toolbar correctly).
  const quillEditors = {};

  const QUILL_TOOLBAR = [
    [{ header: [2, 3, false] }],
    ["bold", "italic", "underline"],
    ["link"],
    [{ list: "ordered" }, { list: "bullet" }],
    ["clean"],
  ];

  function initQuillEditors() {
    document.querySelectorAll(".quill-editor").forEach((el) => {
      const pageKey = el.dataset.editor;
      if (quillEditors[pageKey]) return;
      quillEditors[pageKey] = new Quill(el, {
        theme: "snow",
        modules: { toolbar: QUILL_TOOLBAR },
      });
    });
  }

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
    if (panel === editorPanel) {
      initQuillEditors();
    }
  }

  async function refreshStatus() {
    const res = await fetch("/admin/status");
    const status = await res.json();
    updateNavAdminItem(status);
    if (!status.adminEnabled) {
      showPanel(disabledPanel);
      return;
    }
    if (status.loggedIn) {
      adminUsername.textContent = (status.user && (status.user.name || status.user.username)) || "admin";
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
      const quill = quillEditors[pageKey];
      const sourceTag = card.querySelector(".page-source");
      if (quill) {
        // dangerouslyPasteHTML(html) replaces the whole document, parsing
        // arbitrary HTML into Quill's internal model (rather than just
        // poking the DOM), so the editor's state stays consistent with what
        // the user sees/edits afterwards.
        quill.clipboard.dangerouslyPasteHTML(page.bodyHtml || "");
      }
      if (sourceTag) {
        sourceTag.textContent = page.source === "database" ? "from database" : "static fallback";
      }
    });
  }

  document.querySelectorAll(".save-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pageKey = btn.dataset.pageKey;
      const card = document.querySelector(`[data-page-key="${pageKey}"]`);
      const quill = quillEditors[pageKey];
      const statusEl = card.querySelector(".admin-status");
      if (!quill) return;
      statusEl.textContent = "Saving…";
      const res = await fetch(`/admin/content/${pageKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bodyHtml: quill.root.innerHTML }),
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

  // --- Stats tab (Content / Stats toggle + usage analytics rendering) ---

  function switchTab(tabName) {
    tabButtons.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tab === tabName);
    });
    contentPanel.hidden = tabName !== "content";
    statsPanel.hidden = tabName !== "stats";
    if (tabName === "stats") {
      loadStats();
    }
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  function renderBarChart(hitsByDay) {
    statsBarChart.innerHTML = "";
    const max = Math.max(1, ...hitsByDay.map((d) => d.count));
    hitsByDay.forEach((d) => {
      const row = document.createElement("div");
      row.className = "bar-chart-row";
      const pct = Math.round((d.count / max) * 100);
      row.innerHTML =
        `<span class="bar-chart-label">${escapeHtml(d.date)}</span>` +
        `<span class="bar-chart-track"><span class="bar-chart-fill" style="width: ${pct}%"></span></span>` +
        `<span class="bar-chart-count">${d.count}</span>`;
      statsBarChart.appendChild(row);
    });
  }

  function renderStats(summary) {
    statsHitsBody.innerHTML = "";
    Object.entries(summary.hitsByPage || {}).forEach(([pagePath, count]) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(pagePath)}</td><td>${count}</td>`;
      statsHitsBody.appendChild(tr);
    });
    if (!Object.keys(summary.hitsByPage || {}).length) {
      statsHitsBody.innerHTML = `<tr><td colspan="2">No page hits recorded yet.</td></tr>`;
    }

    renderBarChart(summary.hitsByDay || []);

    statsGamesBody.innerHTML = "";
    const games = summary.games || {};
    const gameLabels = { blocks: "Play: Blocks", jump: "Play: Jump", eat: "Play: Eat" };
    Object.entries(games).forEach(([gameKey, g]) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${escapeHtml(gameLabels[gameKey] || gameKey)}</td>` +
        `<td>${g.plays || 0}</td>` +
        `<td>${g.highScore || 0}</td>` +
        `<td>${g.avgScore != null ? g.avgScore : "—"}</td>`;
      statsGamesBody.appendChild(tr);
    });
  }

  async function loadStats() {
    statsDisabled.hidden = true;
    statsError.hidden = true;
    statsContent.hidden = true;
    try {
      const res = await fetch("/admin/stats");
      if (res.status === 401) {
        showPanel(loginPanel);
        return;
      }
      const data = await res.json();
      if (!data.configured) {
        statsDisabled.hidden = false;
        return;
      }
      if (!res.ok) {
        statsError.textContent = data.error || "Failed to load analytics.";
        statsError.hidden = false;
        return;
      }
      renderStats(data);
      statsContent.hidden = false;
    } catch (err) {
      statsError.textContent = "Failed to load analytics.";
      statsError.hidden = false;
    }
  }

  refreshStatus();
});

