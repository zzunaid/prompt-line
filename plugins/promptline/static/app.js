(() => {
  "use strict";

  const state = {
    data: null,
    view: "overview", // "overview" | "projects" | "timeline"
    previousView: "overview", // where "timeline" was drilled into from
    sort: "newest",
    search: "",
    projectFilter: "",
    dateFilter: "",
    summaryRange: "all",
    visibleEntries: [], // currently filtered+sorted Timeline entries, for "copy transcript"
    projectDisplayNames: new Map(), // full project path -> disambiguated short name
  };

  const contentEl = document.getElementById("content");
  const emptyStateEl = document.getElementById("empty-state");
  const liveDot = document.getElementById("live-dot");
  const searchEl = document.getElementById("search");
  const projectFilterEl = document.getElementById("project-filter");
  const filterControlsEl = document.getElementById("filter-controls");
  const backBtnEl = document.getElementById("back-btn");
  const brandBtnEl = document.getElementById("brand-btn");
  const copyAllBtnEl = document.getElementById("copy-all-btn");
  const dateChipEl = document.getElementById("date-chip");
  const dateChipLabelEl = dateChipEl.querySelector(".date-chip-label");
  const dateChipClearEl = dateChipEl.querySelector(".date-chip-clear");
  const cardTemplate = document.getElementById("entry-card-template");
  const statTileTemplate = document.getElementById("stat-tile-template");

  const RANGE_DAYS = { "1d": 1, "7d": 7, "30d": 30 };
  const EMPTY_MESSAGE_NO_DATA = "nothing found yet under the watched directory.";
  const EMPTY_MESSAGE_NO_MATCH = "no prompts match these filters.";

  function showEmptyState(message) {
    emptyStateEl.textContent = message;
    emptyStateEl.classList.remove("hidden");
  }

  // ~16,700 words at Claude's ~1.3 tokens/word for English prose.
  const LITTLE_PRINCE_TOKENS = 22000;

  function dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function formatDayKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function resetDrilldownFilters() {
    state.dateFilter = "";
    state.projectFilter = "";
    state.search = "";
    searchEl.value = "";
    projectFilterEl.value = "";
  }

  // Enter the flat Timeline drill-down scoped to a single day or project
  // (never both - each click-through path sets exactly one dimension).
  function enterTimeline({ date = "", project = "" } = {}) {
    if (state.view !== "timeline") state.previousView = state.view;
    state.dateFilter = date;
    state.projectFilter = project;
    projectFilterEl.value = project;
    state.view = "timeline";
    render();
  }


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

  function entryToTranscript(entry) {
    return [
      `[${formatTime(entry.timestamp)}] ${entry.project || "(unknown project)"} · session ${(entry.sessionId || "").slice(0, 8)}`,
      `You: ${entry.prompt || ""}`,
      `Claude: ${entry.response || "(no text response captured)"}`,
    ].join("\n");
  }

  function copyToClipboard(text, btnEl, copiedLabel) {
    const original = btnEl.textContent;
    const revert = () => {
      btnEl.textContent = original;
      btnEl.classList.remove("copied");
    };
    // A timeout guard: some browsers/policies leave the clipboard promise
    // pending indefinitely instead of rejecting, which would otherwise strand
    // the button with no feedback at all.
    const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 3000));
    Promise.race([navigator.clipboard.writeText(text).then(() => "ok"), timeout]).then(
      (result) => {
        if (result === "ok") {
          btnEl.textContent = copiedLabel || "copied";
          btnEl.classList.add("copied");
        } else {
          btnEl.textContent = "copy failed";
        }
        setTimeout(revert, 1400);
      },
      () => {
        btnEl.textContent = "copy failed";
        setTimeout(revert, 1400);
      }
    );
  }

  function shortenProject(p) {
    if (!p) return "(unknown project)";
    const parts = p.split("/").filter(Boolean);
    if (parts.length <= 2) return p;
    return "…/" + parts.slice(-2).join("/");
  }

  // shortenProject() only keeps the last 2 path segments, so two different
  // projects that share a parent+leaf name (e.g. /work/x/api and
  // /personal/x/api) would otherwise render identically everywhere. Build a
  // stable full-project-list -> display-name map once per data load, adding
  // a segment for any project whose short name collides with another's.
  function buildProjectDisplayNames(projects) {
    const byShort = new Map();
    projects.forEach((p) => {
      const short = shortenProject(p);
      if (!byShort.has(short)) byShort.set(short, []);
      byShort.get(short).push(p);
    });

    const map = new Map();
    byShort.forEach((fulls, short) => {
      if (fulls.length === 1) {
        map.set(fulls[0], short);
        return;
      }
      fulls.forEach((p) => {
        const parts = p.split("/").filter(Boolean);
        map.set(p, parts.length <= 3 ? p : "…/" + parts.slice(-3).join("/"));
      });
    });
    return map;
  }

  function displayProject(p) {
    if (!p) return "(unknown project)";
    return state.projectDisplayNames.get(p) || shortenProject(p);
  }

  function rangeStartDate(range) {
    const days = RANGE_DAYS[range];
    if (!days) return null;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (days - 1));
    return d;
  }

  function formatCompactNumber(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  function formatHour(h) {
    if (h === null || h === undefined) return "—";
    const period = h < 12 ? "AM" : "PM";
    let hour12 = h % 12;
    if (hour12 === 0) hour12 = 12;
    return `${hour12} ${period}`;
  }

  function formatModelName(m) {
    if (!m) return "—";
    const s = m.replace(/^claude-/, "").replace(/-\d{6,}$/, "");
    const out = [];
    s.split("-").forEach((p) => {
      if (/^\d+$/.test(p)) {
        if (out.length && /^\d/.test(out[out.length - 1])) out[out.length - 1] += "." + p;
        else out.push(p);
      } else if (p) {
        out.push(p[0].toUpperCase() + p.slice(1));
      }
    });
    return out.join(" ") || m;
  }

  // ---------- entry cards (timeline / project / session views) ----------

  function buildCard(entry, query) {
    const node = cardTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = entry.id;

    node.querySelector(".entry-time").textContent = formatTime(entry.timestamp);

    const projectEl = node.querySelector(".entry-project");
    projectEl.textContent = displayProject(entry.project);
    projectEl.title = entry.project || "";

    const sessionEl = node.querySelector(".entry-session");
    sessionEl.textContent = `session ${(entry.sessionId || "").slice(0, 8)}`;
    sessionEl.title = entry.sessionId || "";

    node.querySelector(".entry-copy-btn").addEventListener("click", (ev) => {
      copyToClipboard(entryToTranscript(entry), ev.currentTarget);
    });

    node.querySelector(".entry-prompt").innerHTML = highlight(escapeHtml(entry.prompt || ""), query);

    const responseBlock = node.querySelector(".entry-response-block");
    const responseEl = node.querySelector(".entry-response");
    const responseToggle = node.querySelector(".response-toggle-btn");

    if (entry.response) {
      responseEl.innerHTML = highlight(escapeHtml(entry.response), query);
      // A search match hiding inside a collapsed response would defeat the
      // point of highlighting it - expand automatically when that happens.
      if (query && entry.response.toLowerCase().includes(query.toLowerCase())) {
        responseBlock.classList.remove("collapsed");
        responseToggle.textContent = "hide response";
      }
      responseToggle.addEventListener("click", () => {
        const collapsed = responseBlock.classList.toggle("collapsed");
        responseToggle.textContent = collapsed ? "show response" : "hide response";
      });
    } else {
      responseEl.classList.add("empty");
      responseEl.textContent = "(no text response captured)";
      responseBlock.classList.remove("collapsed");
      responseToggle.remove();
    }

    return node;
  }

  function attachShowMoreHandlers(root) {
    root.querySelectorAll(".entry-block").forEach((block) => {
      const collapsible = block.querySelector(".collapsible");
      const btn = block.querySelector(".show-more-btn");
      if (!collapsible || !btn) return;
      collapsible.classList.remove("expanded", "has-overflow");
      btn.classList.add("hidden");
      if (collapsible.scrollHeight > collapsible.clientHeight + 4) {
        collapsible.classList.add("has-overflow");
        btn.classList.remove("hidden");
        btn.textContent = "more";
        btn.onclick = () => {
          collapsible.classList.toggle("expanded");
          btn.textContent = collapsible.classList.contains("expanded") ? "less" : "more";
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

  // ---------- summary dashboard ----------

  function buildStatTile(value, label) {
    const node = statTileTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".stat-value").textContent = value;
    node.querySelector(".stat-label").textContent = label;
    return node;
  }

  function computeOverviewStats(entries, assistantMsgs) {
    const sessionIds = new Set(entries.map((e) => e.sessionId));
    const messages = entries.length + assistantMsgs.length;
    const tokens = assistantMsgs.reduce((sum, m) => sum + (m.tokens || 0), 0);

    const dayKeys = new Set();
    entries.forEach((e) => {
      if (e.timestamp) dayKeys.add(dayKey(new Date(e.timestamp)));
    });
    const sortedDays = Array.from(dayKeys).sort();

    let longestStreak = 0;
    let run = 0;
    let prevKey = null;
    sortedDays.forEach((key) => {
      if (prevKey) {
        const diff = Math.round((new Date(key) - new Date(prevKey)) / 86400000);
        run = diff === 1 ? run + 1 : 1;
      } else {
        run = 1;
      }
      longestStreak = Math.max(longestStreak, run);
      prevKey = key;
    });

    let currentStreak = 0;
    if (dayKeys.size) {
      const cursor = new Date();
      cursor.setHours(0, 0, 0, 0);
      while (dayKeys.has(dayKey(cursor))) {
        currentStreak++;
        cursor.setDate(cursor.getDate() - 1);
      }
    }

    const hourCounts = new Array(24).fill(0);
    entries.forEach((e) => {
      if (e.timestamp) hourCounts[new Date(e.timestamp).getHours()]++;
    });
    let peakHour = null;
    let peakCount = 0;
    hourCounts.forEach((c, h) => {
      if (c > peakCount) {
        peakCount = c;
        peakHour = h;
      }
    });

    const modelCounts = new Map();
    assistantMsgs.forEach((m) => {
      if (m.model) modelCounts.set(m.model, (modelCounts.get(m.model) || 0) + 1);
    });
    let favoriteModel = null;
    let favCount = 0;
    modelCounts.forEach((c, model) => {
      if (c > favCount) {
        favCount = c;
        favoriteModel = model;
      }
    });

    return {
      sessions: sessionIds.size,
      messages,
      tokens,
      activeDays: dayKeys.size,
      currentStreak,
      longestStreak,
      peakHour,
      favoriteModel,
    };
  }

  function buildHeatmap(entries) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let windowDays = RANGE_DAYS[state.summaryRange];
    if (!windowDays) {
      const timestamps = entries.map((e) => e.timestamp).filter(Boolean);
      if (timestamps.length) {
        const earliest = new Date(Math.min(...timestamps.map((t) => new Date(t).getTime())));
        earliest.setHours(0, 0, 0, 0);
        windowDays = Math.round((today - earliest) / 86400000) + 1;
      } else {
        windowDays = 14;
      }
      windowDays = Math.min(Math.max(windowDays, 84), 140);
    }

    const windowStart = new Date(today);
    windowStart.setDate(windowStart.getDate() - (windowDays - 1));

    const gridStart = new Date(windowStart);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    const totalCells = Math.ceil((Math.round((today - gridStart) / 86400000) + 1) / 7) * 7;
    const counts = new Map();
    entries.forEach((e) => {
      if (!e.timestamp) return;
      const key = dayKey(new Date(e.timestamp));
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const max = Math.max(1, ...Array.from(counts.values()));

    const wrap = document.createElement("div");
    wrap.className = "heatmap";

    const tooltip = document.createElement("div");
    tooltip.className = "heatmap-tooltip";

    function showTooltip(cell, label) {
      const cellRect = cell.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      tooltip.textContent = label;
      tooltip.style.left = cellRect.left - wrapRect.left + cellRect.width / 2 + "px";
      tooltip.style.top = cellRect.top - wrapRect.top + "px";
      tooltip.classList.add("visible");
    }
    function hideTooltip() {
      tooltip.classList.remove("visible");
    }

    const cursorDot = document.createElement("div");
    cursorDot.className = "heatmap-cursor-dot";

    const weeksWrap = document.createElement("div");
    weeksWrap.className = "heatmap-weeks";
    weeksWrap.addEventListener("mousemove", (ev) => {
      const wrapRect = wrap.getBoundingClientRect();
      cursorDot.style.left = ev.clientX - wrapRect.left + "px";
      cursorDot.style.top = ev.clientY - wrapRect.top + "px";
      cursorDot.classList.add("visible");
    });
    weeksWrap.addEventListener("mouseleave", () => {
      cursorDot.classList.remove("visible");
    });

    for (let w = 0; w < totalCells / 7; w++) {
      const weekCol = document.createElement("div");
      weekCol.className = "heatmap-week";
      for (let d = 0; d < 7; d++) {
        const date = new Date(gridStart);
        date.setDate(date.getDate() + w * 7 + d);

        if (date < windowStart || date > today) {
          const cell = document.createElement("div");
          cell.className = "heatmap-cell out-of-range";
          cell.setAttribute("aria-hidden", "true");
          weekCol.appendChild(cell);
        } else {
          const key = dayKey(date);
          const count = counts.get(key) || 0;
          let level = 0;
          if (count > 0) {
            const ratio = count / max;
            level = ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
          }
          const dateLabel = date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
          const cell = document.createElement("button");
          cell.type = "button";
          cell.className = `heatmap-cell level-${level}`;
          const label = `${count} prompt${count === 1 ? "" : "s"} · ${dateLabel}`;
          cell.setAttribute("aria-label", label);
          cell.addEventListener("mouseenter", () => showTooltip(cell, label));
          cell.addEventListener("mouseleave", hideTooltip);
          cell.addEventListener("focus", () => showTooltip(cell, label));
          cell.addEventListener("blur", hideTooltip);
          cell.addEventListener("click", () => {
            enterTimeline({ date: key });
          });
          weekCol.appendChild(cell);
        }
      }
      weeksWrap.appendChild(weekCol);
    }
    wrap.appendChild(weeksWrap);
    wrap.appendChild(cursorDot);
    wrap.appendChild(tooltip);
    return wrap;
  }

  function buildDashboardToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "dashboard-toolbar";

    const tabs = document.createElement("div");
    tabs.className = "pill-toggle";
    tabs.setAttribute("role", "tablist");
    [
      ["overview", "Overview"],
      ["projects", "Projects"],
    ].forEach(([key, label]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill-btn" + (state.view === key ? " active" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        resetDrilldownFilters();
        state.view = key;
        render();
      });
      tabs.appendChild(btn);
    });
    toolbar.appendChild(tabs);

    const range = document.createElement("div");
    range.className = "pill-toggle";
    range.setAttribute("role", "tablist");
    [
      ["all", "All"],
      ["1d", "1d"],
      ["7d", "7d"],
      ["30d", "30d"],
    ].forEach(([key, label]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pill-btn" + (state.summaryRange === key ? " active" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        resetDrilldownFilters();
        state.summaryRange = key;
        render();
      });
      range.appendChild(btn);
    });
    toolbar.appendChild(range);

    return toolbar;
  }

  function renderOverviewTab(container, entries, assistantMsgs) {
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "summary-empty";
      empty.textContent = "Nothing tracked in this range.";
      container.appendChild(empty);
      return;
    }

    const stats = computeOverviewStats(entries, assistantMsgs);

    const grid = document.createElement("div");
    grid.className = "stat-grid";
    [
      [stats.sessions.toLocaleString(), "sessions"],
      [stats.messages.toLocaleString(), "messages"],
      [formatCompactNumber(stats.tokens), "total tokens"],
      [stats.activeDays.toLocaleString(), "active days"],
      [`${stats.currentStreak}d`, "current streak"],
      [`${stats.longestStreak}d`, "longest streak"],
      [formatHour(stats.peakHour), "peak hour"],
      [formatModelName(stats.favoriteModel), "favorite model"],
    ].forEach(([value, label]) => grid.appendChild(buildStatTile(value, label)));
    container.appendChild(grid);

    const heatmapSection = document.createElement("div");
    heatmapSection.className = "summary-section heatmap-section";
    heatmapSection.appendChild(buildHeatmap(entries));

    const legend = document.createElement("div");
    legend.className = "heatmap-legend";
    legend.innerHTML =
      '<span>less</span>' +
      [0, 1, 2, 3, 4].map((l) => `<span class="heatmap-cell level-${l}"></span>`).join("") +
      '<span>more</span>';
    heatmapSection.appendChild(legend);
    container.appendChild(heatmapSection);

    if (stats.tokens > 0) {
      const multiplier = Math.max(1, Math.round(stats.tokens / LITTLE_PRINCE_TOKENS));
      const footer = document.createElement("div");
      footer.className = "summary-footnote";
      footer.textContent = `You've used ~${multiplier}× more tokens than The Little Prince.`;
      container.appendChild(footer);
    }
  }

  function renderProjectsTab(container, entries, assistantMsgs) {
    const byProject = new Map();
    entries.forEach((e) => {
      if (!byProject.has(e.project)) byProject.set(e.project, { entries: [], msgs: [] });
      byProject.get(e.project).entries.push(e);
    });
    assistantMsgs.forEach((m) => {
      if (!byProject.has(m.project)) byProject.set(m.project, { entries: [], msgs: [] });
      byProject.get(m.project).msgs.push(m);
    });

    const sorted = Array.from(byProject.entries()).sort((a, b) => b[1].entries.length - a[1].entries.length);

    if (sorted.length === 0) {
      const empty = document.createElement("div");
      empty.className = "summary-empty";
      empty.textContent = "Nothing tracked in this range.";
      container.appendChild(empty);
      return;
    }

    const heading = document.createElement("div");
    heading.className = "summary-footnote projects-heading";
    heading.textContent = `${sorted.length} project${sorted.length === 1 ? "" : "s"}`;
    container.appendChild(heading);

    const wrap = document.createElement("div");
    wrap.className = "project-list";

    sorted.forEach(([project, group]) => {
      const stats = computeOverviewStats(group.entries, group.msgs);
      const lastActive = group.entries.reduce((max, e) => (e.timestamp && e.timestamp > max ? e.timestamp : max), "");

      const row = document.createElement("div");
      row.className = "project-block";

      const header = document.createElement("button");
      header.type = "button";
      header.className = "project-block-header";
      header.title = `View prompts for ${project}`;
      header.innerHTML = `
        <span class="project-block-name">${escapeHtml(displayProject(project))}</span>
        <span class="project-block-last">${lastActive ? "last " + formatTime(lastActive) : ""}</span>
      `;
      header.addEventListener("click", () => {
        enterTimeline({ project });
      });
      row.appendChild(header);

      const statsRow = document.createElement("div");
      statsRow.className = "project-block-stats";
      statsRow.innerHTML = `
        <span><b>${stats.sessions}</b> session${stats.sessions === 1 ? "" : "s"}</span>
        <span><b>${stats.messages.toLocaleString()}</b> messages</span>
        <span><b>${formatCompactNumber(stats.tokens)}</b> tokens</span>
        <span><b>${formatModelName(stats.favoriteModel)}</b></span>
      `;
      row.appendChild(statsRow);

      wrap.appendChild(row);
    });
    container.appendChild(wrap);
  }

  function renderSummary() {
    const data = state.data;

    if (data.entries.length === 0) {
      showEmptyState(EMPTY_MESSAGE_NO_DATA);
      return;
    }
    emptyStateEl.classList.add("hidden");

    let entries = data.entries;
    let assistantMsgs = data.assistantMessages || [];
    const start = rangeStartDate(state.summaryRange);
    if (start) {
      entries = entries.filter((e) => e.timestamp && new Date(e.timestamp) >= start);
      assistantMsgs = assistantMsgs.filter((m) => m.timestamp && new Date(m.timestamp) >= start);
    }

    const card = document.createElement("div");
    card.className = "dashboard-card";
    card.appendChild(buildDashboardToolbar());

    if (state.view === "projects") {
      renderProjectsTab(card, entries, assistantMsgs);
    } else {
      renderOverviewTab(card, entries, assistantMsgs);
    }

    if (data.maxSessionsPerProject) {
      const note = document.createElement("div");
      note.className = "summary-empty";
      note.style.textAlign = "center";
      note.style.marginTop = "20px";
      note.textContent = `Showing the ${data.maxSessionsPerProject} most recent sessions per project.`;
      card.appendChild(note);
    }

    contentEl.appendChild(card);
  }

  // ---------- top-level render ----------

  function updateFilterControlsVisibility() {
    filterControlsEl.classList.toggle("hidden", state.view !== "timeline");
  }

  function updateDateChip() {
    if (state.dateFilter) {
      dateChipLabelEl.textContent = formatDayKey(state.dateFilter);
      dateChipEl.classList.remove("hidden");
    } else {
      dateChipEl.classList.add("hidden");
    }
  }

  function render() {
    const data = state.data;
    if (!data) return;

    contentEl.innerHTML = "";
    contentEl.className = "view-" + state.view;
    updateFilterControlsVisibility();

    if (state.view === "overview" || state.view === "projects") {
      renderSummary();
      return;
    }

    // state.view === "timeline"
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
    if (state.dateFilter) {
      entries = entries.filter((e) => e.timestamp && dayKey(new Date(e.timestamp)) === state.dateFilter);
    }
    updateDateChip();

    if (entries.length === 0) {
      state.visibleEntries = [];
      const filtered = q || state.projectFilter || state.dateFilter;
      showEmptyState(filtered ? EMPTY_MESSAGE_NO_MATCH : EMPTY_MESSAGE_NO_DATA);
      return;
    }
    emptyStateEl.classList.add("hidden");

    entries.sort(sortComparator());
    state.visibleEntries = entries;
    const frag = document.createDocumentFragment();
    entries.forEach((e) => frag.appendChild(buildCard(e, state.search.trim())));
    contentEl.appendChild(frag);

    attachShowMoreHandlers(contentEl);
  }

  function populateProjectFilter(projects) {
    // state.projectFilter is the source of truth for what's actually being
    // filtered; if it fell out of the live-refreshed project list (e.g. its
    // last session aged out of the per-project cap), clear it too, so the
    // dropdown never shows "all projects" while still silently filtering.
    if (state.projectFilter && !projects.includes(state.projectFilter)) {
      state.projectFilter = "";
    }
    projectFilterEl.innerHTML =
      '<option value="">all projects</option>' +
      projects
        .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(displayProject(p))}</option>`)
        .join("");
    projectFilterEl.value = state.projectFilter;
  }

  async function loadData() {
    const res = await fetch("/api/data");
    const data = await res.json();
    state.data = data;
    state.projectDisplayNames = buildProjectDisplayNames(data.projects);
    populateProjectFilter(data.projects);
    render();
  }

  function wireControls() {
    brandBtnEl.addEventListener("click", () => {
      resetDrilldownFilters();
      state.view = "overview";
      render();
    });

    backBtnEl.addEventListener("click", () => {
      state.view = state.previousView || "overview";
      resetDrilldownFilters();
      render();
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

    dateChipClearEl.addEventListener("click", () => {
      state.dateFilter = "";
      render();
    });

    copyAllBtnEl.addEventListener("click", () => {
      if (state.visibleEntries.length === 0) {
        copyToClipboard("", copyAllBtnEl, "nothing to copy");
        return;
      }
      const header = `Promptline export — ${state.visibleEntries.length} prompt${state.visibleEntries.length === 1 ? "" : "s"}`;
      const text = header + "\n\n" + state.visibleEntries.map(entryToTranscript).join("\n\n---\n\n");
      copyToClipboard(text, copyAllBtnEl);
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
