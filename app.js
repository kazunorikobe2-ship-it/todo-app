const STORAGE_KEY = "kanban-board-state-v1";

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      // fall through to default
    }
  }
  return {
    columns: [
      {
        id: uid(),
        title: "To Do",
        cards: [
          { id: uid(), text: "カードをドラッグして移動できます" },
          { id: uid(), text: "「+ カードを追加」で新規作成" },
        ],
      },
      { id: uid(), title: "In Progress", cards: [] },
      { id: uid(), title: "Done", cards: [] },
    ],
  };
}

let state = loadState();

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

const board = document.getElementById("board");
const addColumnBtn = document.getElementById("add-column-btn");

addColumnBtn.addEventListener("click", () => {
  state.columns.push({ id: uid(), title: "新しいリスト", cards: [] });
  saveState();
  render();
});

function render() {
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
        render();
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

      const textSpan = document.createElement("span");
      textSpan.textContent = card.text;
      textSpan.addEventListener("dblclick", () => {
        const newText = prompt("カードの内容を編集", card.text);
        if (newText !== null) {
          card.text = newText.trim() || card.text;
          saveState();
          render();
        }
      });

      const delBtn = document.createElement("button");
      delBtn.className = "card-delete";
      delBtn.textContent = "✕";
      delBtn.title = "カードを削除";
      delBtn.addEventListener("click", () => {
        column.cards = column.cards.filter((c) => c.id !== card.id);
        saveState();
        render();
      });

      cardEl.appendChild(textSpan);
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
          column.cards.push({ id: uid(), text });
          saveState();
          render();
        }
      });

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "cancel-add";
      cancelBtn.textContent = "キャンセル";
      cancelBtn.addEventListener("click", () => {
        render();
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
      render();
    });

    board.appendChild(columnEl);
  });
}

render();
