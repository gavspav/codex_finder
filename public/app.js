const state = {
  projects: [],
  query: localStorage.getItem("codexFinder.query") || "",
  sort: localStorage.getItem("codexFinder.sort") || "recent",
  view: localStorage.getItem("codexFinder.view") || "grid",
  activeDate: "all",
  showFavorites: false,
  selectedPath: null,
  loading: false,
};

const els = {
  rootLabel: document.getElementById("rootLabel"),
  searchInput: document.getElementById("searchInput"),
  sortSelect: document.getElementById("sortSelect"),
  gridButton: document.getElementById("gridButton"),
  listButton: document.getElementById("listButton"),
  refreshButton: document.getElementById("refreshButton"),
  allFilter: document.getElementById("allFilter"),
  favoriteFilter: document.getElementById("favoriteFilter"),
  allCount: document.getElementById("allCount"),
  favoriteCount: document.getElementById("favoriteCount"),
  dateFilters: document.getElementById("dateFilters"),
  viewTitle: document.getElementById("viewTitle"),
  resultMeta: document.getElementById("resultMeta"),
  statusPill: document.getElementById("statusPill"),
  emptyState: document.getElementById("emptyState"),
  projectGrid: document.getElementById("projectGrid"),
  toast: document.getElementById("toast"),
};

const formatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const relativeFormatter = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });

function icon(name) {
  return `<svg aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function formatDate(dateString) {
  if (!dateString) return "No date";
  const date = new Date(`${dateString}T12:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;
  return formatter.format(date);
}

function formatRelative(ms) {
  const delta = ms - Date.now();
  const minutes = Math.round(delta / 60000);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);

  if (Math.abs(minutes) < 60) return relativeFormatter.format(minutes, "minute");
  if (Math.abs(hours) < 48) return relativeFormatter.format(hours, "hour");
  return relativeFormatter.format(days, "day");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(text, type = "") {
  els.statusPill.textContent = text;
  els.statusPill.className = `status-pill ${type}`.trim();
}

let toastTimer = 0;
function showToast(message) {
  window.clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.add("show");
  toastTimer = window.setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function getDateCounts(projects = state.projects) {
  const counts = new Map();
  for (const project of projects) {
    const key = project.date || "No date";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => {
    if (a[0] === "No date") return 1;
    if (b[0] === "No date") return -1;
    return b[0].localeCompare(a[0]);
  });
}

function projectMatchesQuery(project, query) {
  if (!query) return true;
  const haystack = [
    project.title,
    project.folder,
    project.relativePath,
    project.date,
    project.markers.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function visibleProjects() {
  const filtered = state.projects.filter((project) => {
    if (state.showFavorites && !project.favorite) return false;
    if (state.activeDate !== "all" && (project.date || "No date") !== state.activeDate) {
      return false;
    }
    return projectMatchesQuery(project, state.query);
  });

  return filtered.sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    if (state.sort === "name") return a.title.localeCompare(b.title);
    if (state.sort === "date") return (b.date || "").localeCompare(a.date || "");
    if (state.sort === "files") return b.fileCount - a.fileCount || b.latestMs - a.latestMs;
    return b.latestMs - a.latestMs;
  });
}

function renderFilters() {
  const favoriteCount = state.projects.filter((project) => project.favorite).length;
  els.allCount.textContent = state.projects.length;
  els.favoriteCount.textContent = favoriteCount;
  els.allFilter.classList.toggle("active", !state.showFavorites && state.activeDate === "all");
  els.favoriteFilter.classList.toggle("active", state.showFavorites);

  els.dateFilters.innerHTML = getDateCounts()
    .map(
      ([date, count]) => `
        <button class="date-button ${state.activeDate === date ? "active" : ""}" type="button" data-date="${escapeHtml(date)}">
          <span>${escapeHtml(formatDate(date))}</span>
          <strong>${count}</strong>
        </button>
      `,
    )
    .join("");
}

function projectCard(project) {
  const isSelected = state.selectedPath === project.path;
  const badges = project.markers.length
    ? project.markers.map((marker) => `<span class="badge">${escapeHtml(marker)}</span>`).join("")
    : '<span class="badge">Folder</span>';
  const changed = formatRelative(project.latestMs);
  const date = formatDate(project.date);

  return `
    <article class="project-card ${isSelected ? "selected" : ""}" data-path="${escapeHtml(project.path)}" tabindex="0" aria-label="${escapeHtml(project.title)}">
      <div class="card-top">
        <div class="folder-art">${icon("folder")}</div>
        <button class="icon-button favorite-button ${project.favorite ? "active" : ""}" type="button" data-action="favorite" aria-label="Favourite">
          ${icon("star")}
        </button>
      </div>
      <div class="card-body">
        <div>
          <div class="project-title">${escapeHtml(project.title)}</div>
          <div class="project-path">${escapeHtml(project.relativePath)}</div>
        </div>
        <div class="project-meta">${date} · ${project.fileCount} files · ${changed}</div>
        <div class="badges">${badges}</div>
      </div>
      <div class="card-actions">
        <button class="open-button" type="button" data-action="open">${icon("open")}<span>Open</span></button>
        <button class="ghost-button" type="button" data-action="reveal" aria-label="Reveal in Finder">${icon("eye")}</button>
      </div>
    </article>
  `;
}

function renderProjects() {
  const projects = visibleProjects();
  els.projectGrid.classList.toggle("list", state.view === "list");
  els.gridButton.classList.toggle("active", state.view === "grid");
  els.listButton.classList.toggle("active", state.view === "list");
  els.emptyState.hidden = projects.length > 0;
  els.projectGrid.hidden = projects.length === 0;
  els.projectGrid.innerHTML = projects.map(projectCard).join("");

  const noun = projects.length === 1 ? "folder" : "folders";
  const total = state.projects.length;
  const suffix = state.query ? ` matching "${state.query}"` : "";
  els.resultMeta.textContent = `${projects.length} ${noun} of ${total}${suffix}`;
  els.viewTitle.textContent = state.showFavorites
    ? "Favourites"
    : state.activeDate === "all"
      ? "Folders"
      : formatDate(state.activeDate);
}

function render() {
  renderFilters();
  renderProjects();
}

async function loadProjects() {
  state.loading = true;
  setStatus("Scanning");
  try {
    const [config, data] = await Promise.all([fetchJson("/api/config"), fetchJson("/api/projects")]);
    state.projects = data.projects;
    els.rootLabel.textContent = config.root;
    setStatus(config.codexCliAvailable ? "Ready" : "Fallback launch", "ready");
    render();
  } catch (error) {
    setStatus("Error", "error");
    showToast(error.message);
  } finally {
    state.loading = false;
  }
}

async function openProject(projectPath) {
  const project = state.projects.find((item) => item.path === projectPath);
  if (!project) return;

  state.selectedPath = projectPath;
  renderProjects();
  showToast(`Opening ${project.title}`);

  try {
    await fetchJson("/api/open", {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    });
  } catch (error) {
    showToast(error.message);
  }
}

async function revealProject(projectPath) {
  try {
    await fetchJson("/api/reveal", {
      method: "POST",
      body: JSON.stringify({ path: projectPath }),
    });
  } catch (error) {
    showToast(error.message);
  }
}

async function toggleFavorite(projectPath) {
  const project = state.projects.find((item) => item.path === projectPath);
  if (!project) return;

  project.favorite = !project.favorite;
  render();

  try {
    await fetchJson("/api/favorite", {
      method: "POST",
      body: JSON.stringify({ path: projectPath, favorite: project.favorite }),
    });
  } catch (error) {
    project.favorite = !project.favorite;
    render();
    showToast(error.message);
  }
}

function selectProject(projectPath) {
  state.selectedPath = projectPath;
  renderProjects();
}

els.searchInput.value = state.query;
els.sortSelect.value = state.sort;

els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  localStorage.setItem("codexFinder.query", state.query);
  renderProjects();
});

els.sortSelect.addEventListener("change", (event) => {
  state.sort = event.target.value;
  localStorage.setItem("codexFinder.sort", state.sort);
  renderProjects();
});

els.gridButton.addEventListener("click", () => {
  state.view = "grid";
  localStorage.setItem("codexFinder.view", state.view);
  renderProjects();
});

els.listButton.addEventListener("click", () => {
  state.view = "list";
  localStorage.setItem("codexFinder.view", state.view);
  renderProjects();
});

els.refreshButton.addEventListener("click", loadProjects);

els.allFilter.addEventListener("click", () => {
  state.showFavorites = false;
  state.activeDate = "all";
  render();
});

els.favoriteFilter.addEventListener("click", () => {
  state.showFavorites = true;
  state.activeDate = "all";
  render();
});

els.dateFilters.addEventListener("click", (event) => {
  const button = event.target.closest("[data-date]");
  if (!button) return;
  state.showFavorites = false;
  state.activeDate = button.dataset.date;
  render();
});

els.projectGrid.addEventListener("click", (event) => {
  const card = event.target.closest(".project-card");
  if (!card) return;

  const actionButton = event.target.closest("[data-action]");
  const projectPath = card.dataset.path;
  selectProject(projectPath);

  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === "open") openProject(projectPath);
  if (action === "reveal") revealProject(projectPath);
  if (action === "favorite") toggleFavorite(projectPath);
});

els.projectGrid.addEventListener("dblclick", (event) => {
  const card = event.target.closest(".project-card");
  if (card) openProject(card.dataset.path);
});

els.projectGrid.addEventListener("keydown", (event) => {
  const card = event.target.closest(".project-card");
  if (!card) return;

  if (event.key === "Enter") {
    event.preventDefault();
    openProject(card.dataset.path);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== els.searchInput) {
    event.preventDefault();
    els.searchInput.focus();
  }
});

loadProjects();
