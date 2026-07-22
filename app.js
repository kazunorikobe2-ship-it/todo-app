// ---------- helpers ----------
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function makeCard(text) {
  return {
    id: uid(),
    text,
    startDate: null,
    dueDate: null,
    priority: null,
    notes: "",
    members: [],
    comments: [],
    attachments: [],
  };
}

function makeColumn(title, cards) {
  return { id: uid(), title, cards: cards || [] };
}

function makeProject(name, seedSampleData) {
  if (seedSampleData) {
    return {
      id: uid(),
      name,
      columns: [
        makeColumn("To Do", [
          makeCard("カードをクリックすると詳細を編集できます"),
          makeCard("「+ カードを追加」で新規作成"),
        ]),
        makeColumn("In Progress"),
        makeColumn("Done"),
      ],
    };
  }
  return {
    id: uid(),
    name,
    columns: [makeColumn("To Do"), makeColumn("In Progress"), makeColumn("Done")],
  };
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function uploadFile(file, pathPrefix) {
  const fileId = uid();
  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `${pathPrefix}/${fileId}-${safeName}`;
  const ref = storage.ref().child(path);
  await ref.put(file, { contentType: file.type || undefined });
  const url = await ref.getDownloadURL();
  return {
    id: fileId,
    name: file.name,
    type: file.type || "",
    size: file.size,
    url,
    path,
  };
}

function buildAttachmentChip(attachment, onRemove) {
  const wrap = document.createElement("div");
  wrap.className = "attachment-item";

  const link = document.createElement("a");
  link.href = attachment.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.style.display = "flex";
  link.style.alignItems = "center";
  link.style.gap = "6px";
  link.style.textDecoration = "none";
  link.style.color = "inherit";
  link.style.minWidth = "0";

  if (attachment.type && attachment.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = attachment.url;
    img.className = "attachment-thumb";
    img.alt = attachment.name;
    link.appendChild(img);
  } else {
    const icon = document.createElement("div");
    icon.className = "attachment-icon";
    icon.textContent = "📄";
    link.appendChild(icon);
  }

  const info = document.createElement("div");
  info.className = "attachment-info";

  const nameEl = document.createElement("span");
  nameEl.className = "attachment-name";
  nameEl.textContent = attachment.name;

  const sizeEl = document.createElement("span");
  sizeEl.className = "attachment-size";
  sizeEl.textContent = formatFileSize(attachment.size);

  info.appendChild(nameEl);
  info.appendChild(sizeEl);
  link.appendChild(info);
  wrap.appendChild(link);

  if (onRemove) {
    const rm = document.createElement("button");
    rm.className = "attachment-remove";
    rm.textContent = "✕";
    rm.title = "削除";
    rm.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRemove();
    });
    wrap.appendChild(rm);
  }

  return wrap;
}

function priorityLabel(p) {
  if (p === "high") return "高";
  if (p === "medium") return "中";
  if (p === "low") return "低";
  return "";
}

// ---------- state & firestore ----------
function defaultState() {
  return {
    projects: [makeProject("マイプロジェクト", true)],
    trash: [],
  };
}

// Handles both the current {projects:[...], trash:[...]} shape and the
// legacy single-board {columns:[...], trash:[...]} shape from before
// the project concept existed, so nobody's existing board data is lost.
function migrateState(data) {
  if (data && Array.isArray(data.projects) && data.projects.length) {
    return {
      projects: data.projects,
      trash: Array.isArray(data.trash) ? data.trash : [],
    };
  }
  if (data && Array.isArray(data.columns)) {
    return {
      projects: [{ id: uid(), name: "マイプロジェクト", columns: data.columns }],
      trash: Array.isArray(data.trash) ? data.trash : [],
    };
  }
  return defaultState();
}

const boardRef = db.collection("kanban").doc("board");

let state = { projects: [], trash: [] };
let unsubscribeBoard = null;

const CURRENT_PROJECT_KEY = "kanban-current-project";
const DRAWER_OPEN_KEY = "kanban-drawer-open";
const CURRENT_VIEW_KEY = "kanban-current-view";

let currentProjectId = localStorage.getItem(CURRENT_PROJECT_KEY) || null;
let currentView = localStorage.getItem(CURRENT_VIEW_KEY) || "board";
if (!["board", "table", "calendar", "timeline", "dashboard"].includes(currentView)) {
  currentView = "board";
}
let drawerOpen = localStorage.getItem(DRAWER_OPEN_KEY);
drawerOpen = drawerOpen === null ? true : drawerOpen === "true";

function getActiveProject() {
  return state.projects.find((p) => p.id === currentProjectId) || state.projects[0];
}

function ensureActiveProject() {
  if (!state.projects.length) {
    state.projects.push(makeProject("マイプロジェクト", true));
  }
  if (!state.projects.find((p) => p.id === currentProjectId)) {
    currentProjectId = state.projects[0].id;
    localStorage.setItem(CURRENT_PROJECT_KEY, currentProjectId);
  }
}

function saveState() {
  boardRef.set(state).catch((err) => {
    console.error("Firestore write failed", err);
    alert(
      "保存に失敗しました。Firestoreのセキュリティルールでログイン済みユーザーの読み書きが許可されているか確認してください。"
    );
  });
}

function handleBoardSnapshot(snap) {
  if (snap.exists) {
    state = migrateState(snap.data());
  } else {
    state = defaultState();
    boardRef.set(state);
  }
  ensureActiveProject();
  renderAll();
  syncModalIfOpen();
  updateTrashBadge();
  if (!trashModal.classList.contains("hidden")) renderTrash();
}

function handleBoardError(err) {
  console.error("Firestore listen failed", err);
}

function renderAll() {
  renderProjectList();
  const project = getActiveProject();
  projectTitleEl.textContent = "📋 " + (project ? project.name : "Kanban Board");
  applyDrawerState();
  applyViewState();

  if (currentView === "board") renderBoard();
  else if (currentView === "table") renderTableView();
  else if (currentView === "calendar") renderCalendarView();
  else if (currentView === "timeline") renderTimelineView();
  else if (currentView === "dashboard") renderDashboardView();
}

// ---------- Google authentication ----------
const provider = new firebase.auth.GoogleAuthProvider();

let currentUser = null;

const authModal = document.getElementById("auth-modal");
const googleLoginBtn = document.getElementById("google-login-btn");
const userInfoEl = document.getElementById("user-info");
const logoutBtn = document.getElementById("logout-btn");
const trashBtn = document.getElementById("trash-btn");

googleLoginBtn.addEventListener("click", () => {
  auth.signInWithPopup(provider).catch((err) => {
    console.error("Google sign-in failed", err);
    alert("ログインに失敗しました: " + err.message);
  });
});

logoutBtn.addEventListener("click", () => {
  auth.signOut();
});

auth.onAuthStateChanged((user) => {
  currentUser = user;

  if (user) {
    authModal.classList.add("hidden");
    userInfoEl.textContent = "👤 " + (user.displayName || user.email || "ログイン中");
    userInfoEl.classList.remove("hidden");
    logoutBtn.classList.remove("hidden");
    trashBtn.classList.remove("hidden");

    if (!unsubscribeBoard) {
      unsubscribeBoard = boardRef.onSnapshot(handleBoardSnapshot, handleBoardError);
    }
  } else {
    authModal.classList.remove("hidden");
    userInfoEl.classList.add("hidden");
    logoutBtn.classList.add("hidden");
    trashBtn.classList.add("hidden");
    trashModal.classList.add("hidden");
    closeCardModal();
    board.innerHTML = "";

    if (unsubscribeBoard) {
      unsubscribeBoard();
      unsubscribeBoard = null;
    }
  }
});

// ---------- project drawer ----------
const projectDrawer = document.getElementById("project-drawer");
const drawerToggleBtn = document.getElementById("drawer-toggle-btn");
const projectTitleEl = document.getElementById("project-title");
const projectListEl = document.getElementById("project-list");
const addProjectBtn = document.getElementById("add-project-btn");

function applyDrawerState() {
  projectDrawer.classList.toggle("closed", !drawerOpen);
}

drawerToggleBtn.addEventListener("click", () => {
  drawerOpen = !drawerOpen;
  localStorage.setItem(DRAWER_OPEN_KEY, String(drawerOpen));
  applyDrawerState();
});

function renderProjectList() {
  projectListEl.innerHTML = "";
  state.projects.forEach((project) => {
    const row = document.createElement("div");
    row.className = "project-item" + (project.id === currentProjectId ? " active" : "");
    row.addEventListener("click", () => {
      currentProjectId = project.id;
      localStorage.setItem(CURRENT_PROJECT_KEY, currentProjectId);
      renderAll();
    });

    const nameInput = document.createElement("input");
    nameInput.className = "project-name-input";
    nameInput.value = project.name;
    nameInput.addEventListener("click", (e) => e.stopPropagation());
    nameInput.addEventListener("change", () => {
      project.name = nameInput.value.trim() || project.name;
      saveState();
    });

    const delBtn = document.createElement("button");
    delBtn.className = "project-delete-btn";
    delBtn.textContent = "✕";
    delBtn.title = "プロジェクトを削除";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.projects.length <= 1) {
        alert("最後のプロジェクトは削除できません。");
        return;
      }
      openConfirmModal({
        title: "プロジェクトを削除しますか？",
        message: `「${project.name}」とその中のすべてのリスト・カードが完全に削除されます。この操作は元に戻せません。`,
        okLabel: "削除する",
        onConfirm: () => {
          state.projects = state.projects.filter((p) => p.id !== project.id);
          if (currentProjectId === project.id) {
            currentProjectId = state.projects[0].id;
            localStorage.setItem(CURRENT_PROJECT_KEY, currentProjectId);
          }
          saveState();
        },
      });
    });

    row.appendChild(nameInput);
    row.appendChild(delBtn);
    projectListEl.appendChild(row);
  });
}

addProjectBtn.addEventListener("click", () => {
  const project = makeProject("新しいプロジェクト", false);
  state.projects.push(project);
  currentProjectId = project.id;
  localStorage.setItem(CURRENT_PROJECT_KEY, currentProjectId);
  saveState();
});

// ---------- view tabs ----------
const viewTabButtons = document.querySelectorAll(".view-tab");
const viewPanels = {
  board: document.getElementById("board"),
  table: document.getElementById("table-view"),
  calendar: document.getElementById("calendar-view"),
  timeline: document.getElementById("timeline-view"),
  dashboard: document.getElementById("dashboard-view"),
};

function applyViewState() {
  viewTabButtons.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === currentView);
  });
  Object.keys(viewPanels).forEach((key) => {
    viewPanels[key].classList.toggle("hidden", key !== currentView);
  });
}

viewTabButtons.forEach((tab) => {
  tab.addEventListener("click", () => {
    currentView = tab.dataset.view;
    localStorage.setItem(CURRENT_VIEW_KEY, currentView);
    renderAll();
  });
});

// ---------- board view ----------
const board = document.getElementById("board");
const addColumnBtn = document.getElementById("add-column-btn");

addColumnBtn.addEventListener("click", () => {
  const project = getActiveProject();
  if (!project) return;
  project.columns.push(makeColumn("新しいリスト"));
  saveState();
});

function renderBoard() {
  const project = getActiveProject();
  board.innerHTML = "";
  if (!project) return;

  project.columns.forEach((column) => {
    const columnEl = document.createElement("div");
    columnEl.className = "column";
    columnEl.dataset.columnId = column.id;

    // header
    const header = document.createElement("div");
    header.className = "column-header";

    const titleInput = document.createElement("input");
    titleInput.className = "column-title";
    titleInput.value = column.title;
    titleInput.addEventListener("change", () => {
      column.title = titleInput.value || "リスト";
      saveState();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-column-btn";
    deleteBtn.textContent = "✕";
    deleteBtn.title = "リストを削除";
    deleteBtn.addEventListener("click", () => {
      if (confirm(`「${column.title}」を削除しますか？`)) {
        project.columns = project.columns.filter((c) => c.id !== column.id);
        saveState();
      }
    });

    header.appendChild(titleInput);
    header.appendChild(deleteBtn);
    columnEl.appendChild(header);

    // card list
    const cardList = document.createElement("div");
    cardList.className = "card-list";

    column.cards.forEach((card) => {
      const cardEl = document.createElement("div");
      cardEl.className = "card";
      cardEl.draggable = true;
      cardEl.dataset.cardId = card.id;

      cardEl.addEventListener("dragstart", (e) => {
        cardEl.classList.add("dragging");
        e.dataTransfer.setData(
          "text/plain",
          JSON.stringify({ cardId: card.id, fromColumnId: column.id })
        );
      });
      cardEl.addEventListener("dragend", () => {
        cardEl.classList.remove("dragging");
      });
      cardEl.addEventListener("click", () => openCardModal(column.id, card.id));

      const textDiv = document.createElement("div");
      textDiv.className = "card-text";
      textDiv.textContent = card.text;
      cardEl.appendChild(textDiv);

      const badges = document.createElement("div");
      badges.className = "card-badges";

      if (card.priority) {
        const b = document.createElement("span");
        b.className = `badge priority-${card.priority}`;
        b.textContent = priorityLabel(card.priority);
        badges.appendChild(b);
      }
      if (card.dueDate) {
        const b = document.createElement("span");
        b.className = "badge due-badge";
        b.textContent = "📅 " + card.dueDate;
        badges.appendChild(b);
      }
      if (card.members && card.members.length) {
        const b = document.createElement("span");
        b.className = "badge member-badge";
        b.textContent = "👤 " + card.members.join(", ");
        badges.appendChild(b);
      }
      if (card.comments && card.comments.length) {
        const b = document.createElement("span");
        b.className = "badge comment-badge";
        b.textContent = "💬 " + card.comments.length;
        badges.appendChild(b);
      }
      if (card.attachments && card.attachments.length) {
        const b = document.createElement("span");
        b.className = "badge attachment-badge";
        b.textContent = "📎 " + card.attachments.length;
        badges.appendChild(b);
      }
      if (badges.children.length) cardEl.appendChild(badges);

      const delBtn = document.createElement("button");
      delBtn.className = "card-delete";
      delBtn.textContent = "✕";
      delBtn.title = "カードを削除";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openConfirmModal({
          title: "削除しますか？",
          message: "このカードはゴミ箱に移動します。ゴミ箱からいつでも復元・完全削除できます。",
          okLabel: "削除する",
          onConfirm: () => moveCardToTrash(column.id, card.id),
        });
      });
      cardEl.appendChild(delBtn);

      cardList.appendChild(cardEl);
    });

    columnEl.appendChild(cardList);

    // add card control
    const addWrap = document.createElement("div");

    const addBtn = document.createElement("button");
    addBtn.className = "add-card-btn";
    addBtn.textContent = "+ カードを追加";
    addBtn.addEventListener("click", () => showCardInput());

    function showCardInput() {
      addWrap.innerHTML = "";
      const textarea = document.createElement("textarea");
      textarea.className = "card-input";
      textarea.rows = 2;
      textarea.placeholder = "カードの内容を入力...";

      const actions = document.createElement("div");
      actions.className = "card-input-actions";

      const confirmBtn = document.createElement("button");
      confirmBtn.className = "confirm-add";
      confirmBtn.textContent = "追加";
      confirmBtn.addEventListener("click", () => {
        const text = textarea.value.trim();
        if (text) {
          column.cards.push(makeCard(text));
          saveState();
        }
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "cancel-add";
      cancelBtn.textContent = "キャンセル";
      cancelBtn.addEventListener("click", () => {
        renderBoard();
      });

      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
      addWrap.appendChild(textarea);
      addWrap.appendChild(actions);
      textarea.focus();
    }

    addWrap.appendChild(addBtn);
    columnEl.appendChild(addWrap);

    // drop handling
    columnEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      columnEl.classList.add("drag-over");
    });
    columnEl.addEventListener("dragleave", () => {
      columnEl.classList.remove("drag-over");
    });
    columnEl.addEventListener("drop", (e) => {
      e.preventDefault();
      columnEl.classList.remove("drag-over");
      const data = JSON.parse(e.dataTransfer.getData("text/plain"));
      const fromColumn = project.columns.find((c) => c.id === data.fromColumnId);
      if (!fromColumn) return;
      const cardIndex = fromColumn.cards.findIndex((c) => c.id === data.cardId);
      if (cardIndex === -1) return;
      const [movedCard] = fromColumn.cards.splice(cardIndex, 1);
      column.cards.push(movedCard);
      saveState();
    });

    board.appendChild(columnEl);
  });
}

// ---------- table view ----------
function renderTableView() {
  const project = getActiveProject();
  const panel = viewPanels.table;
  panel.innerHTML = "";
  if (!project) return;

  const rows = [];
  project.columns.forEach((column) => {
    column.cards.forEach((card) => rows.push({ card, column }));
  });

  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "table-empty";
    empty.textContent = "カードがありません";
    panel.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "kanban-table";

  const thead = document.createElement("thead");
  thead.innerHTML =
    "<tr><th>タイトル</th><th>リスト</th><th>開始日</th><th>期日</th><th>重要度</th><th>メンバー</th><th>💬</th><th>📎</th></tr>";
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  rows.forEach(({ card, column }) => {
    const tr = document.createElement("tr");
    tr.addEventListener("click", () => openCardModal(column.id, card.id));

    const tdTitle = document.createElement("td");
    tdTitle.textContent = card.text;
    tr.appendChild(tdTitle);

    const tdList = document.createElement("td");
    tdList.textContent = column.title;
    tr.appendChild(tdList);

    const tdStart = document.createElement("td");
    tdStart.textContent = card.startDate || "";
    tr.appendChild(tdStart);

    const tdDue = document.createElement("td");
    tdDue.textContent = card.dueDate || "";
    tr.appendChild(tdDue);

    const tdPriority = document.createElement("td");
    if (card.priority) {
      const b = document.createElement("span");
      b.className = `badge priority-${card.priority}`;
      b.textContent = priorityLabel(card.priority);
      tdPriority.appendChild(b);
    }
    tr.appendChild(tdPriority);

    const tdMembers = document.createElement("td");
    tdMembers.textContent = (card.members || []).join(", ");
    tr.appendChild(tdMembers);

    const tdComments = document.createElement("td");
    tdComments.textContent =
      card.comments && card.comments.length ? String(card.comments.length) : "";
    tr.appendChild(tdComments);

    const tdAttachments = document.createElement("td");
    tdAttachments.textContent =
      card.attachments && card.attachments.length ? String(card.attachments.length) : "";
    tr.appendChild(tdAttachments);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  panel.appendChild(table);
}

// ---------- calendar view ----------
let calendarCursor = new Date();

function renderCalendarView() {
  const project = getActiveProject();
  const panel = viewPanels.calendar;
  panel.innerHTML = "";
  if (!project) return;

  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();

  const header = document.createElement("div");
  header.className = "calendar-header";

  const prevBtn = document.createElement("button");
  prevBtn.className = "calendar-nav-btn";
  prevBtn.textContent = "‹";
  prevBtn.addEventListener("click", () => {
    calendarCursor = new Date(year, month - 1, 1);
    renderCalendarView();
  });

  const label = document.createElement("div");
  label.className = "calendar-label";
  label.textContent = `${year}年 ${month + 1}月`;

  const nextBtn = document.createElement("button");
  nextBtn.className = "calendar-nav-btn";
  nextBtn.textContent = "›";
  nextBtn.addEventListener("click", () => {
    calendarCursor = new Date(year, month + 1, 1);
    renderCalendarView();
  });

  const todayBtn = document.createElement("button");
  todayBtn.className = "calendar-today-btn";
  todayBtn.textContent = "今日";
  todayBtn.addEventListener("click", () => {
    calendarCursor = new Date();
    renderCalendarView();
  });

  header.appendChild(prevBtn);
  header.appendChild(label);
  header.appendChild(nextBtn);
  header.appendChild(todayBtn);
  panel.appendChild(header);

  const cardsByDate = {};
  project.columns.forEach((column) => {
    column.cards.forEach((card) => {
      if (card.dueDate) {
        (cardsByDate[card.dueDate] = cardsByDate[card.dueDate] || []).push({ card, column });
      }
    });
  });

  const grid = document.createElement("div");
  grid.className = "calendar-grid";

  ["日", "月", "火", "水", "木", "金", "土"].forEach((d) => {
    const cell = document.createElement("div");
    cell.className = "calendar-weekday";
    cell.textContent = d;
    grid.appendChild(cell);
  });

  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);

  for (let i = 0; i < startOffset; i++) {
    const cell = document.createElement("div");
    cell.className = "calendar-cell empty";
    grid.appendChild(cell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = "calendar-cell" + (dateStr === todayStr ? " today" : "");

    const num = document.createElement("div");
    num.className = "calendar-date-num";
    num.textContent = String(d);
    cell.appendChild(num);

    (cardsByDate[dateStr] || []).forEach(({ card, column }) => {
      const chip = document.createElement("div");
      chip.className = "calendar-card-chip";
      if (card.priority) chip.classList.add(`priority-${card.priority}`);
      chip.textContent = card.text;
      chip.title = column.title;
      chip.addEventListener("click", () => openCardModal(column.id, card.id));
      cell.appendChild(chip);
    });

    grid.appendChild(cell);
  }

  panel.appendChild(grid);
}

// ---------- timeline view ----------
function renderTimelineView() {
  const project = getActiveProject();
  const panel = viewPanels.timeline;
  panel.innerHTML = "";
  if (!project) return;

  const items = [];
  project.columns.forEach((column) => {
    column.cards.forEach((card) => {
      if (card.dueDate || card.startDate) items.push({ card, column });
    });
  });

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "table-empty";
    empty.textContent = "開始日または期日が設定されたカードがありません";
    panel.appendChild(empty);
    return;
  }

  items.sort((a, b) => {
    const da = a.card.startDate || a.card.dueDate;
    const db = b.card.startDate || b.card.dueDate;
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const allDates = [];
  items.forEach(({ card }) => {
    if (card.startDate) allDates.push(card.startDate);
    if (card.dueDate) allDates.push(card.dueDate);
  });
  const minDate = new Date(allDates.reduce((a, b) => (a < b ? a : b)));
  const maxDate = new Date(allDates.reduce((a, b) => (a > b ? a : b)));
  minDate.setDate(minDate.getDate() - 1);
  maxDate.setDate(maxDate.getDate() + 1);
  const totalMs = maxDate - minDate || 1;

  const axis = document.createElement("div");
  axis.className = "timeline-axis-labels";
  const startLabel = document.createElement("span");
  startLabel.textContent = minDate.toISOString().slice(0, 10);
  const endLabel = document.createElement("span");
  endLabel.textContent = maxDate.toISOString().slice(0, 10);
  axis.appendChild(startLabel);
  axis.appendChild(endLabel);
  panel.appendChild(axis);

  const container = document.createElement("div");
  container.className = "timeline-container";

  items.forEach(({ card, column }) => {
    const row = document.createElement("div");
    row.className = "timeline-row";

    const label = document.createElement("div");
    label.className = "timeline-label";
    label.textContent = card.text;
    label.title = column.title;

    const track = document.createElement("div");
    track.className = "timeline-track";

    const startStr = card.startDate || card.dueDate;
    const endStr = card.dueDate || card.startDate;
    const startMs = new Date(startStr) - minDate;
    const endMs = new Date(endStr) - minDate;
    const leftPct = (startMs / totalMs) * 100;
    const widthPct = Math.max(((endMs - startMs) / totalMs) * 100, 1.2);

    const bar = document.createElement("div");
    bar.className = "timeline-bar";
    if (card.priority) bar.classList.add(`priority-${card.priority}`);
    bar.style.left = leftPct + "%";
    bar.style.width = widthPct + "%";
    bar.title = `${startStr} 〜 ${endStr}`;
    bar.addEventListener("click", () => openCardModal(column.id, card.id));

    track.appendChild(bar);
    row.appendChild(label);
    row.appendChild(track);
    container.appendChild(row);
  });

  panel.appendChild(container);
}

// ---------- dashboard view ----------
function renderDashboardView() {
  const project = getActiveProject();
  const panel = viewPanels.dashboard;
  panel.innerHTML = "";
  if (!project) return;

  let total = 0;
  const byPriority = { high: 0, medium: 0, low: 0, none: 0 };
  const byColumn = [];
  let overdue = 0;
  const upcoming = [];
  const todayStr = new Date().toISOString().slice(0, 10);
  const in7 = new Date();
  in7.setDate(in7.getDate() + 7);
  const in7Str = in7.toISOString().slice(0, 10);

  project.columns.forEach((column) => {
    byColumn.push({ title: column.title, count: column.cards.length });
    column.cards.forEach((card) => {
      total++;
      byPriority[card.priority || "none"]++;
      if (card.dueDate) {
        if (card.dueDate < todayStr) overdue++;
        else if (card.dueDate <= in7Str) upcoming.push({ card, column });
      }
    });
  });

  function statTile(label, value, extraClass) {
    const tile = document.createElement("div");
    tile.className = "stat-tile" + (extraClass ? " " + extraClass : "");
    const num = document.createElement("div");
    num.className = "stat-number";
    num.textContent = value;
    const lab = document.createElement("div");
    lab.className = "stat-label";
    lab.textContent = label;
    tile.appendChild(num);
    tile.appendChild(lab);
    return tile;
  }

  const statsRow = document.createElement("div");
  statsRow.className = "dashboard-stats";
  statsRow.appendChild(statTile("カード総数", total));
  statsRow.appendChild(statTile("期限切れ", overdue, overdue > 0 ? "stat-danger" : ""));
  statsRow.appendChild(statTile("7日以内に期限", upcoming.length));
  statsRow.appendChild(statTile("高重要度", byPriority.high));
  panel.appendChild(statsRow);

  const columnSection = document.createElement("div");
  columnSection.className = "dashboard-section";
  const columnTitle = document.createElement("h3");
  columnTitle.textContent = "リストごとのカード数";
  columnSection.appendChild(columnTitle);

  const maxCount = Math.max(1, ...byColumn.map((c) => c.count));
  byColumn.forEach((c) => {
    const barRow = document.createElement("div");
    barRow.className = "dashboard-bar-row";

    const label = document.createElement("div");
    label.className = "dashboard-bar-label";
    label.textContent = `${c.title} (${c.count})`;

    const barWrap = document.createElement("div");
    barWrap.className = "dashboard-bar-wrap";
    const bar = document.createElement("div");
    bar.className = "dashboard-bar";
    bar.style.width = (c.count / maxCount) * 100 + "%";
    barWrap.appendChild(bar);

    barRow.appendChild(label);
    barRow.appendChild(barWrap);
    columnSection.appendChild(barRow);
  });
  panel.appendChild(columnSection);

  const upcomingSection = document.createElement("div");
  upcomingSection.className = "dashboard-section";
  const upcomingTitle = document.createElement("h3");
  upcomingTitle.textContent = "7日以内に期限を迎えるカード";
  upcomingSection.appendChild(upcomingTitle);

  if (!upcoming.length) {
    const p = document.createElement("p");
    p.className = "table-empty";
    p.textContent = "該当するカードはありません";
    upcomingSection.appendChild(p);
  } else {
    upcoming
      .sort((a, b) => (a.card.dueDate < b.card.dueDate ? -1 : 1))
      .forEach(({ card, column }) => {
        const row = document.createElement("div");
        row.className = "dashboard-upcoming-row";
        row.addEventListener("click", () => openCardModal(column.id, card.id));
        row.textContent = `${card.dueDate} - ${card.text} (${column.title})`;
        upcomingSection.appendChild(row);
      });
  }
  panel.appendChild(upcomingSection);
}

// ---------- card detail modal ----------
const cardModal = document.getElementById("card-modal");
const modalTitleInput = document.getElementById("modal-title");
const modalCloseBtn = document.getElementById("modal-close-btn");
const modalStartDate = document.getElementById("modal-start-date");
const modalDueDate = document.getElementById("modal-due-date");
const modalPriority = document.getElementById("modal-priority");
const modalMembersEl = document.getElementById("modal-members");
const modalMemberInput = document.getElementById("modal-member-input");
const modalNotes = document.getElementById("modal-notes");
const modalCommentsEl = document.getElementById("modal-comments");
const modalCommentInput = document.getElementById("modal-comment-input");
const modalAttachmentsEl = document.getElementById("modal-attachments");
const modalAttachmentInput = document.getElementById("modal-attachment-input");
const modalAttachmentLabel = document.getElementById("modal-attachment-label");
const modalAttachmentUploadingEl = document.getElementById("modal-attachment-uploading");
const modalCommentFileInput = document.getElementById("modal-comment-file-input");
const pendingFileEl = document.getElementById("modal-comment-pending-file");

function setAttachmentUploading(isUploading) {
  if (isUploading) {
    modalAttachmentUploadingEl.classList.remove("hidden");
    modalAttachmentLabel.classList.add("disabled");
  } else {
    modalAttachmentUploadingEl.classList.add("hidden");
    modalAttachmentLabel.classList.remove("disabled");
  }
}

function showPendingFileUploading(file) {
  pendingFileEl.classList.remove("hidden");
  pendingFileEl.innerHTML = "";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  const label = document.createElement("span");
  label.textContent = "アップロード中… " + file.name;
  pendingFileEl.appendChild(spinner);
  pendingFileEl.appendChild(label);
}

let pendingCommentFile = null;
let activeCardRef = null; // { columnId, cardId }

function findCard(columnId, cardId) {
  const project = getActiveProject();
  if (!project) return null;
  const column = project.columns.find((c) => c.id === columnId);
  if (!column) return null;
  const card = column.cards.find((c) => c.id === cardId);
  return card ? { column, card } : null;
}

function openCardModal(columnId, cardId) {
  const found = findCard(columnId, cardId);
  if (!found) return;
  activeCardRef = { columnId, cardId };
  populateModal(found.card);
  cardModal.classList.remove("hidden");
}

function closeCardModal() {
  activeCardRef = null;
  cardModal.classList.add("hidden");
}

modalCloseBtn.addEventListener("click", closeCardModal);
cardModal.addEventListener("click", (e) => {
  if (e.target === cardModal) closeCardModal();
});

function populateModal(card) {
  modalTitleInput.value = card.text;
  modalStartDate.value = card.startDate || "";
  modalDueDate.value = card.dueDate || "";
  modalPriority.value = card.priority || "";
  modalNotes.value = card.notes || "";
  renderMembers(card.members || []);
  renderComments(card.comments || []);
  renderAttachments(card.attachments || []);
  pendingCommentFile = null;
  renderPendingFile();
}

function renderAttachments(attachments) {
  modalAttachmentsEl.innerHTML = "";
  (attachments || []).forEach((att) => {
    const chip = buildAttachmentChip(att, () => {
      if (!activeCardRef) return;
      const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
      if (!found) return;
      found.card.attachments = (found.card.attachments || []).filter((a) => a.id !== att.id);
      saveState();
      renderAttachments(found.card.attachments);
      if (att.path) {
        storage
          .ref()
          .child(att.path)
          .delete()
          .catch(() => {});
      }
    });
    modalAttachmentsEl.appendChild(chip);
  });
}

function renderPendingFile() {
  pendingFileEl.innerHTML = "";
  if (!pendingCommentFile) {
    pendingFileEl.classList.add("hidden");
    return;
  }
  pendingFileEl.classList.remove("hidden");

  const label = document.createElement("span");
  label.textContent =
    "📎 " + pendingCommentFile.name + " (" + formatFileSize(pendingCommentFile.size) + ")";

  const rm = document.createElement("button");
  rm.textContent = "✕";
  rm.addEventListener("click", () => {
    pendingCommentFile = null;
    renderPendingFile();
  });

  pendingFileEl.appendChild(label);
  pendingFileEl.appendChild(rm);
}

modalAttachmentInput.addEventListener("change", async () => {
  const file = modalAttachmentInput.files[0];
  modalAttachmentInput.value = "";
  if (!file || !activeCardRef) return;
  if (file.size > MAX_FILE_SIZE) {
    alert("ファイルサイズは5MBまでです。");
    return;
  }
  const targetColumnId = activeCardRef.columnId;
  const targetCardId = activeCardRef.cardId;

  setAttachmentUploading(true);
  try {
    const attachment = await uploadFile(file, `kanban/cards/${targetCardId}`);
    const found = findCard(targetColumnId, targetCardId);
    if (!found) return;
    found.card.attachments = found.card.attachments || [];
    found.card.attachments.push(attachment);
    saveState();
    if (activeCardRef && activeCardRef.cardId === targetCardId) {
      renderAttachments(found.card.attachments);
    }
  } catch (err) {
    console.error("upload failed", err);
    alert("ファイルのアップロードに失敗しました: " + err.message);
  } finally {
    setAttachmentUploading(false);
  }
});

modalCommentFileInput.addEventListener("change", () => {
  const file = modalCommentFileInput.files[0];
  modalCommentFileInput.value = "";
  if (!file) return;
  if (file.size > MAX_FILE_SIZE) {
    alert("ファイルサイズは5MBまでです。");
    return;
  }
  pendingCommentFile = file;
  renderPendingFile();
});

function renderMembers(members) {
  modalMembersEl.innerHTML = "";
  members.forEach((name, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = name;

    const rm = document.createElement("button");
    rm.textContent = "✕";
    rm.addEventListener("click", () => {
      const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
      if (!found) return;
      found.card.members.splice(idx, 1);
      saveState();
      renderMembers(found.card.members);
    });

    chip.appendChild(rm);
    modalMembersEl.appendChild(chip);
  });
}

function renderComments(comments) {
  modalCommentsEl.innerHTML = "";
  comments.forEach((c) => {
    const item = document.createElement("div");
    item.className = "comment-item";

    const meta = document.createElement("div");
    meta.className = "comment-meta";
    const date = new Date(c.createdAt);
    meta.textContent = `${c.author} ・ ${date.toLocaleString("ja-JP")}`;

    const text = document.createElement("div");
    text.className = "comment-text";
    text.textContent = c.text;

    item.appendChild(meta);
    if (c.text) item.appendChild(text);

    if (c.attachment) {
      const attWrap = document.createElement("div");
      attWrap.className = "comment-attachment";
      attWrap.appendChild(buildAttachmentChip(c.attachment));
      item.appendChild(attWrap);
    }

    modalCommentsEl.appendChild(item);
  });
  modalCommentsEl.scrollTop = modalCommentsEl.scrollHeight;
}

modalTitleInput.addEventListener("change", () => {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.text = modalTitleInput.value.trim() || found.card.text;
  saveState();
});

modalStartDate.addEventListener("change", () => {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.startDate = modalStartDate.value || null;
  saveState();
});

modalDueDate.addEventListener("change", () => {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.dueDate = modalDueDate.value || null;
  saveState();
});

modalPriority.addEventListener("change", () => {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.priority = modalPriority.value || null;
  saveState();
});

modalNotes.addEventListener("change", () => {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.notes = modalNotes.value;
  saveState();
});

modalMemberInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (!activeCardRef) return;
  const name = modalMemberInput.value.trim();
  if (!name) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.members = found.card.members || [];
  found.card.members.push(name);
  saveState();
  renderMembers(found.card.members);
  modalMemberInput.value = "";
});

modalCommentInput.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (!activeCardRef) return;
  const text = modalCommentInput.value.trim();
  if (!text && !pendingCommentFile) return;
  if (!currentUser) return;

  const targetColumnId = activeCardRef.columnId;
  const targetCardId = activeCardRef.cardId;
  const fileToUpload = pendingCommentFile;

  modalCommentInput.value = "";
  modalCommentInput.disabled = true;

  let attachment = null;
  if (fileToUpload) {
    showPendingFileUploading(fileToUpload);
    try {
      attachment = await uploadFile(fileToUpload, `kanban/comments/${targetCardId}`);
    } catch (err) {
      console.error("upload failed", err);
      alert("ファイルのアップロードに失敗しました: " + err.message);
      modalCommentInput.disabled = false;
      pendingCommentFile = fileToUpload;
      renderPendingFile();
      return;
    }
  }

  pendingCommentFile = null;
  renderPendingFile();
  modalCommentInput.disabled = false;

  const found = findCard(targetColumnId, targetCardId);
  if (!found) return;
  found.card.comments = found.card.comments || [];
  const comment = {
    id: uid(),
    author: currentUser.displayName || currentUser.email || "匿名",
    text,
    createdAt: new Date().toISOString(),
  };
  if (attachment) comment.attachment = attachment;
  found.card.comments.push(comment);
  saveState();
  if (activeCardRef && activeCardRef.cardId === targetCardId) {
    renderComments(found.card.comments);
  }
});

function syncModalIfOpen() {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) {
    closeCardModal();
    return;
  }
  // Only refresh the parts that are safe to update live (avoids wiping focused inputs)
  renderComments(found.card.comments || []);
  renderMembers(found.card.members || []);
  renderAttachments(found.card.attachments || []);
}

// ---------- generic confirm modal ----------
const confirmModal = document.getElementById("confirm-modal");
const confirmModalTitle = document.getElementById("confirm-modal-title");
const confirmModalMessage = document.getElementById("confirm-modal-message");
const confirmModalCancelBtn = document.getElementById("confirm-modal-cancel-btn");
const confirmModalOkBtn = document.getElementById("confirm-modal-ok-btn");

let confirmModalAction = null;

function openConfirmModal({ title, message, okLabel, onConfirm }) {
  confirmModalTitle.textContent = title || "削除しますか？";
  confirmModalMessage.textContent = message || "";
  confirmModalOkBtn.textContent = okLabel || "削除する";
  confirmModalAction = onConfirm;
  confirmModal.classList.remove("hidden");
}

function closeConfirmModal() {
  confirmModal.classList.add("hidden");
  confirmModalAction = null;
}

confirmModalCancelBtn.addEventListener("click", closeConfirmModal);
confirmModalOkBtn.addEventListener("click", () => {
  const action = confirmModalAction;
  closeConfirmModal();
  if (action) action();
});
confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) closeConfirmModal();
});

// ---------- trash ----------
const trashModal = document.getElementById("trash-modal");
const trashCloseBtn = document.getElementById("trash-close-btn");
const trashListEl = document.getElementById("trash-list");
const trashEmptyBtn = document.getElementById("trash-empty-btn");
const trashCountBadge = document.getElementById("trash-count");

function moveCardToTrash(columnId, cardId) {
  const project = getActiveProject();
  if (!project) return;
  const column = project.columns.find((c) => c.id === columnId);
  if (!column) return;
  const idx = column.cards.findIndex((c) => c.id === cardId);
  if (idx === -1) return;
  const [removedCard] = column.cards.splice(idx, 1);
  state.trash = state.trash || [];
  state.trash.unshift({
    id: uid(),
    projectId: project.id,
    card: removedCard,
    fromColumnId: columnId,
    deletedAt: new Date().toISOString(),
  });
  if (activeCardRef && activeCardRef.cardId === cardId) closeCardModal();
  saveState();
}

function restoreFromTrash(trashItemId) {
  const trash = state.trash || [];
  const idx = trash.findIndex((t) => t.id === trashItemId);
  if (idx === -1) return;
  const [item] = trash.splice(idx, 1);
  const targetProject =
    state.projects.find((p) => p.id === item.projectId) || getActiveProject();
  if (!targetProject) return;
  const targetColumn =
    targetProject.columns.find((c) => c.id === item.fromColumnId) || targetProject.columns[0];
  if (targetColumn) {
    targetColumn.cards.push(item.card);
  }
  saveState();
}

function permanentlyDeleteTrashItem(trashItemId) {
  state.trash = (state.trash || []).filter((t) => t.id !== trashItemId);
  saveState();
}

function updateTrashBadge() {
  const count = (state.trash || []).length;
  if (count > 0) {
    trashCountBadge.textContent = count > 99 ? "99+" : String(count);
    trashCountBadge.classList.remove("hidden");
  } else {
    trashCountBadge.classList.add("hidden");
  }
}

function renderTrash() {
  const trash = state.trash || [];
  trashListEl.innerHTML = "";

  if (!trash.length) {
    trashListEl.innerHTML = '<p class="trash-empty">ゴミ箱は空です</p>';
    return;
  }

  trash.forEach((item) => {
    const row = document.createElement("div");
    row.className = "trash-item";

    const info = document.createElement("div");
    info.className = "trash-item-info";

    const title = document.createElement("div");
    title.className = "trash-item-title";
    title.textContent = item.card.text;

    const meta = document.createElement("div");
    meta.className = "trash-item-meta";
    const proj = state.projects.find((p) => p.id === item.projectId);
    const col = proj ? proj.columns.find((c) => c.id === item.fromColumnId) : null;
    meta.textContent =
      (proj ? proj.name : "不明なプロジェクト") +
      " / " +
      (col ? col.title : "不明なリスト") +
      " ・ " +
      new Date(item.deletedAt).toLocaleString("ja-JP");

    info.appendChild(title);
    info.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "trash-item-actions";

    const restoreBtn = document.createElement("button");
    restoreBtn.className = "restore-btn";
    restoreBtn.textContent = "元に戻す";
    restoreBtn.addEventListener("click", () => restoreFromTrash(item.id));

    const delBtn = document.createElement("button");
    delBtn.className = "danger-btn small";
    delBtn.textContent = "完全に削除";
    delBtn.addEventListener("click", () => {
      openConfirmModal({
        title: "完全に削除しますか？",
        message: "この操作は元に戻せません。",
        okLabel: "完全に削除",
        onConfirm: () => permanentlyDeleteTrashItem(item.id),
      });
    });

    actions.appendChild(restoreBtn);
    actions.appendChild(delBtn);

    row.appendChild(info);
    row.appendChild(actions);
    trashListEl.appendChild(row);
  });
}

trashBtn.addEventListener("click", () => {
  renderTrash();
  trashModal.classList.remove("hidden");
});

trashCloseBtn.addEventListener("click", () => {
  trashModal.classList.add("hidden");
});

trashModal.addEventListener("click", (e) => {
  if (e.target === trashModal) trashModal.classList.add("hidden");
});

trashEmptyBtn.addEventListener("click", () => {
  const count = (state.trash || []).length;
  if (!count) return;
  openConfirmModal({
    title: "ゴミ箱を空にしますか？",
    message: `ゴミ箱内の${count}件のカードをすべて完全に削除します。この操作は元に戻せません。`,
    okLabel: "すべて完全に削除",
    onConfirm: () => {
      state.trash = [];
      saveState();
    },
  });
});
