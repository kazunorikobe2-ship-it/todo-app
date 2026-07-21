// ---------- helpers ----------
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function makeCard(text) {
  return {
    id: uid(),
    text,
    dueDate: null,
    priority: null,
    notes: "",
    members: [],
    comments: [],
  };
}

function defaultState() {
  return {
    columns: [
      {
        id: uid(),
        title: "To Do",
        cards: [
          makeCard("カードをクリックすると詳細を編集できます"),
          makeCard("「+ カードを追加」で新規作成"),
        ],
      },
      { id: uid(), title: "In Progress", cards: [] },
      { id: uid(), title: "Done", cards: [] },
    ],
  };
}

// ---------- firestore ----------
const boardRef = db.collection("kanban").doc("board");

let state = { columns: [] };

function saveState() {
  boardRef.set(state).catch((err) => {
    console.error("Firestore write failed", err);
    alert(
      "保存に失敗しました。Firestoreのセキュリティルールで読み書きが許可されているか確認してください。"
    );
  });
}

boardRef.onSnapshot(
  (snap) => {
    if (snap.exists) {
      const data = snap.data();
      state = data && Array.isArray(data.columns) ? data : defaultState();
    } else {
      state = defaultState();
      boardRef.set(state);
    }
    renderBoard();
    syncModalIfOpen();
  },
  (err) => {
    console.error("Firestore listen failed", err);
  }
);

// ---------- user name (for comment attribution) ----------
const NAME_KEY = "kanban-user-name";
let currentUserName = localStorage.getItem(NAME_KEY) || "";

const nameModal = document.getElementById("name-modal");
const nameInput = document.getElementById("name-input");
const nameSaveBtn = document.getElementById("name-save-btn");

function ensureUserName() {
  if (!currentUserName) {
    nameModal.classList.remove("hidden");
    nameInput.focus();
  } else {
    nameModal.classList.add("hidden");
  }
}

nameSaveBtn.addEventListener("click", saveName);
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveName();
});

function saveName() {
  const val = nameInput.value.trim();
  if (val) {
    currentUserName = val;
    localStorage.setItem(NAME_KEY, val);
    nameModal.classList.add("hidden");
  }
}

ensureUserName();

// ---------- board rendering ----------
const board = document.getElementById("board");
const addColumnBtn = document.getElementById("add-column-btn");

addColumnBtn.addEventListener("click", () => {
  state.columns.push({ id: uid(), title: "新しいリスト", cards: [] });
  saveState();
});

function priorityLabel(p) {
  if (p === "high") return "高";
  if (p === "medium") return "中";
  if (p === "low") return "低";
  return "";
}

function renderBoard() {
  board.innerHTML = "";

  state.columns.forEach((column) => {
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
        state.columns = state.columns.filter((c) => c.id !== column.id);
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
      if (badges.children.length) cardEl.appendChild(badges);

      const delBtn = document.createElement("button");
      delBtn.className = "card-delete";
      delBtn.textContent = "✕";
      delBtn.title = "カードを削除";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        column.cards = column.cards.filter((c) => c.id !== card.id);
        saveState();
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
      const fromColumn = state.columns.find((c) => c.id === data.fromColumnId);
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

// ---------- card detail modal ----------
const cardModal = document.getElementById("card-modal");
const modalTitleInput = document.getElementById("modal-title");
const modalCloseBtn = document.getElementById("modal-close-btn");
const modalDueDate = document.getElementById("modal-due-date");
const modalPriority = document.getElementById("modal-priority");
const modalMembersEl = document.getElementById("modal-members");
const modalMemberInput = document.getElementById("modal-member-input");
const modalNotes = document.getElementById("modal-notes");
const modalCommentsEl = document.getElementById("modal-comments");
const modalCommentInput = document.getElementById("modal-comment-input");

let activeCardRef = null; // { columnId, cardId }

function findCard(columnId, cardId) {
  const column = state.columns.find((c) => c.id === columnId);
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
  modalDueDate.value = card.dueDate || "";
  modalPriority.value = card.priority || "";
  modalNotes.value = card.notes || "";
  renderMembers(card.members || []);
  renderComments(card.comments || []);
}

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
    item.appendChild(text);
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

modalCommentInput.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  if (!activeCardRef) return;
  const text = modalCommentInput.value.trim();
  if (!text) return;
  if (!currentUserName) {
    ensureUserName();
    return;
  }
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.comments = found.card.comments || [];
  found.card.comments.push({
    id: uid(),
    author: currentUserName,
    text,
    createdAt: new Date().toISOString(),
  });
  saveState();
  renderComments(found.card.comments);
  modalCommentInput.value = "";
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
}
