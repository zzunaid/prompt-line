(() => {
  "use strict";

  const state = {
    data: null,
    view: "timeline",
    sort: "newest",
    search: "",
    projectFilter: "",
    collapsed: new Set(),
    sessionMeta: new Map(),
  };

  const contentEl = document.getElementById("content");
  const emptyStateEl = document.getElementById("empty-state");
  const liveDot = document.getElementById("live-dot");
  const searchEl = document.getElementById("search");
  const projectFilterEl = document.getElementById("project-filter");
  const cardTemplate = document.getElementById("entry-card-template");

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlight(escapedHtml, rawQuery) {
    if (!rawQuery) return escapedHtml;
    const needle = escapeRegex(escapeHtml(rawQuery));
    if (!needle) return escapedHtml;
    const re = new RegExp(needle, "ig");
    return escapedHtml.replace(re, (m) => `<mark>${m}</mark>`);
  }

  function formatTime(ts) {
    if (!ts) return "(unknown time)";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function shortenProject(p) {
    if (!p) return "(unknown project)";
    const parts = p.split("/").filter(Boolean);
    if (parts.length <= 2) return p;
    return "…/" + parts.slice(-2).join("/");
  }

  function buildCard(entry, query) {
    const node = cardTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = entry.id;

    node.querySelector(".entry-time").textContent = formatTime(entry.timestamp);

    const projectEl = node.querySelector(".entry-project");
    projectEl.textContent = shortenProject(entry.project);
    projectEl.title = entry.project || "";

    const sessionEl = node.querySelector(".entry-session");
    sessionEl.textContent = `session ${(entry.sessionId || "").slice(0, 8)}`;
    sessionEl.title = entry.sessionId || "";

    node.querySelector(".entry-prompt").innerHTML = highlight(escapeHtml(entry.prompt || ""), query);

    const responseEl = node.querySelector(".entry-response");
    if (entry.response) {
      responseEl.innerHTML = highlight(escapeHtml(entry.response), query);
    } else {
      responseEl.innerHTML = "<em>(no text response captured)</em>";
    }

    return node;
  }

  function attachShowMoreHandlers(root) {
    root.querySelectorAll(".entry-response-wrap").forEach((wrap) => {
      const resp = wrap.querySelector(".entry-response");
      const btn = wrap.querySelector(".show-more-btn");
      if (resp.scrollHeight > resp.clientHeight + 4) {
        btn.classList.remove("hidden");
        btn.textContent = "Show more";
        btn.onclick = () => {
          resp.classList.toggle("expanded");
          btn.textContent = resp.classList.contains("expanded") ? "Show less" : "Show more";
        };
      }
    });
  }

  function sortComparator() {
    const dir = state.sort === "newest" ? -1 : 1;
    return (a, b) => {
      if (a.timestamp === b.timestamp) return 0;
      return (a.timestamp < b.timestamp ? -1 : 1) * dir;
    };
  }

  function renderGroups(entries, keyFn, metaFn, query) {
    const groups = new Map();
    entries.forEach((e) => {
      const k = keyFn(e);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    });

    const groupKeys = Array.from(groups.keys());
    const extremeTime = (k) => {
      const times = groups.get(k).map((e) => e.timestamp || "");
      return state.sort === "newest" ? times.reduce((a, b) => (b > a ? b : a), "") : times.reduce((a, b) => (a === null || (b < a && b) ? b : a), null);
    };
    groupKeys.sort((a, b) => {
      const ta = extremeTime(a) || "";
      const tb = extremeTime(b) || "";
      if (ta === tb) return 0;
      if (state.sort === "newest") return ta < tb ? 1 : -1;
      return ta < tb ? -1 : 1;
    });

    const byTime = sortComparator();
    const frag = document.createDocumentFragment();

    groupKeys.forEach((key) => {
      const groupEntries = groups.get(key).slice().sort(byTime);
      const meta = metaFn(key, groupEntries);
      const groupEl = document.createElement("div");
      groupEl.className = "group";
      if (state.collapsed.has(key)) groupEl.classList.add("collapsed");

      const header = document.createElement("div");
      header.className = "group-header";
      header.innerHTML = `
        <span class="group-caret">▼</span>
        <span class="group-title" title="${escapeHtml(meta.title)}">${escapeHtml(meta.title)}</span>
        <span class="group-sub">${escapeHtml(meta.sub)}</span>
      `;
      header.addEventListener("click", () => {
        groupEl.classList.toggle("collapsed");
        if (groupEl.classList.contains("collapsed")) state.collapsed.add(key);
        else state.collapsed.delete(key);
      });

      const body = document.createElement("div");
      body.className = "group-body";
      groupEntries.forEach((e) => body.appendChild(buildCard(e, query)));

      groupEl.appendChild(header);
      groupEl.appendChild(body);
      frag.appendChild(groupEl);
    });

    contentEl.appendChild(frag);
  }

  function render() {
    const data = state.data;
    if (!data) return;

    let entries = data.entries.slice();

    const q = state.search.trim().toLowerCase();
    if (q) {
      entries = entries.filter(
        (e) =>
          (e.prompt && e.prompt.toLowerCase().includes(q)) ||
          (e.response && e.response.toLowerCase().includes(q))
      );
    }
    if (state.projectFilter) {
      entries = entries.filter((e) => e.project === state.projectFilter);
    }

    contentEl.innerHTML = "";

    if (entries.length === 0) {
      emptyStateEl.classList.remove("hidden");
      return;
    }
    emptyStateEl.classList.add("hidden");

    if (state.view === "timeline") {
      entries.sort(sortComparator());
      const frag = document.createDocumentFragment();
      entries.forEach((e) => frag.appendChild(buildCard(e, state.search.trim())));
      contentEl.appendChild(frag);
    } else if (state.view === "project") {
      renderGroups(
        entries,
        (e) => e.project,
        (key, groupEntries) => ({
          title: shortenProject(key),
          sub: `${groupEntries.length} prompt${groupEntries.length === 1 ? "" : "s"}`,
        }),
        state.search.trim()
      );
    } else {
      renderGroups(
        entries,
        (e) => e.sessionId,
        (key, groupEntries) => {
          const meta = state.sessionMeta.get(key);
          const total = meta ? meta.promptCount : groupEntries.length;
          const start = meta ? formatTime(meta.startTime) : "";
          const project = meta ? meta.project : groupEntries[0] && groupEntries[0].project;
          const matchingNote = groupEntries.length !== total ? ` (${groupEntries.length} matching)` : "";
          return {
            title: `${shortenProject(project)} — session ${key.slice(0, 8)}`,
            sub: `started ${start} · ${total} prompt${total === 1 ? "" : "s"}${matchingNote}`,
          };
        },
        state.search.trim()
      );
    }

    attachShowMoreHandlers(contentEl);
  }

  function populateProjectFilter(projects) {
    const current = projectFilterEl.value;
    projectFilterEl.innerHTML =
      '<option value="">All projects</option>' +
      projects
        .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(shortenProject(p))}</option>`)
        .join("");
    if (projects.includes(current)) projectFilterEl.value = current;
  }

  async function loadData() {
    const res = await fetch("/api/data");
    const data = await res.json();
    state.data = data;
    state.sessionMeta = new Map(data.sessions.map((s) => [s.sessionId, s]));
    populateProjectFilter(data.projects);
    render();
  }

  function wireControls() {
    document.querySelectorAll(".view-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".view-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.view = btn.dataset.view;
        render();
      });
    });

    document.querySelectorAll(".sort-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.sort = btn.dataset.sort;
        render();
      });
    });

    let debounceHandle = null;
    searchEl.addEventListener("input", () => {
      clearTimeout(debounceHandle);
      debounceHandle = setTimeout(() => {
        state.search = searchEl.value;
        render();
      }, 200);
    });

    projectFilterEl.addEventListener("change", () => {
      state.projectFilter = projectFilterEl.value;
      render();
    });
  }

  function connectStream() {
    const es = new EventSource("/api/stream");
    es.addEventListener("refresh", () => {
      loadData();
    });
    es.onopen = () => liveDot.classList.remove("stale");
    es.onerror = () => {
      liveDot.classList.add("stale");
    };
  }

  wireControls();
  loadData();
  connectStream();
})();
