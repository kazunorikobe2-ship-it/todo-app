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
    cover: null,
  };
}

const COVER_COLORS = [
  "#4bce97",
  "#f5cd47",
  "#fea362",
  "#f87462",
  "#9f8fef",
  "#579dff",
  "#6cc3e0",
  "#94c748",
  "#e774bb",
  "#8590a2",
];

function makeColumn(title, cards) {
  return { id: uid(), title, cards: cards || [] };
}

function makeProject(name, seedSampleData) {
  const columns = seedSampleData
    ? [
        makeColumn("To Do", [
          makeCard("カードをクリックすると詳細を編集できます"),
          makeCard("「+ カードを追加」で新規作成"),
        ]),
        makeColumn("In Progress"),
        makeColumn("Done"),
      ]
    : [makeColumn("To Do"), makeColumn("In Progress"), makeColumn("Done")];

  return {
    id: uid(),
    name,
    ownerUid: null,
    ownerEmail: null,
    ownerPlan: "free",
    publicShareEnabled: false,
    editors: [],
    viewers: [],
    memberEmails: [],
    columns,
    trash: [],
  };
}

function buildMemberEmails(project) {
  const set = new Set(
    [project.ownerEmail, ...(project.editors || []), ...(project.viewers || [])].filter(Boolean)
  );
  return Array.from(set);
}

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB (Free plan's per-file cap)

// ---------- plans ----------
// Plan is a per-project concept: it follows the PROJECT OWNER's plan (like
// Trello, where the board's plan gates features for everyone on the board),
// denormalized onto the project document as `ownerPlan` so members/viewers
// don't need permission to read the owner's private user profile.
//
// kazunorikobe2@gmail.com is a fixed "admin" identity: whenever THEY are the
// project owner, that project always behaves as if on the top tier,
// regardless of whatever plan value happens to be stored. This is about
// this app's own operator having unrestricted access, not about them
// managing other people's projects/members.
const ADMIN_EMAIL = "kazunorikobe2@gmail.com";

// Fixed per-file cap, the same for every plan — only the TOTAL storage quota
// (sum of every attachment/cover/comment-file across all of an owner's
// projects) differs by plan. See maxTotalMB below.
const PER_FILE_MAX_MB = 5;

// Once an owner's remaining total-storage headroom drops to this many MB or
// below, a warning banner is shown in the header.
const STORAGE_ALERT_THRESHOLD_MB = 10;

const PLAN_LIMITS = {
  free: {
    label: "Free",
    maxProjects: 10,
    views: ["board", "table"],
    maxTotalMB: 5,
    publicShare: false,
  },
  pro: {
    label: "Pro",
    maxProjects: Infinity,
    views: ["board", "table", "calendar", "timeline", "dashboard"],
    maxTotalMB: 150,
    publicShare: false,
  },
  business: {
    label: "Business",
    maxProjects: Infinity,
    views: ["board", "table", "calendar", "timeline", "dashboard"],
    maxTotalMB: Infinity,
    publicShare: true,
  },
};

function isAdminUser(user) {
  return !!(user && user.email === ADMIN_EMAIL);
}

function planLimitsFor(planKey) {
  return PLAN_LIMITS[planKey] || PLAN_LIMITS.free;
}

// The plan that governs a given PROJECT's available features (view locks,
// total storage quota, public share eligibility) — based on its owner.
function effectivePlanForProject(project) {
  if (!project) return "free";
  if (project.ownerEmail === ADMIN_EMAIL) return "business";
  return project.ownerPlan || "free";
}

// The plan that governs the CURRENTLY SIGNED-IN user's own account-level
// actions (e.g. how many projects they're allowed to own/create).
function effectivePlanForCurrentUser() {
  if (isAdminUser(currentUser)) return "business";
  return (userProfile && userProfile.plan) || "free";
}

// Per-file cap is fixed regardless of plan (admin is still unrestricted).
function maxFileSizeBytesForProject(project) {
  if (project && project.ownerEmail === ADMIN_EMAIL) return Infinity;
  return PER_FILE_MAX_MB * 1024 * 1024;
}

// Total attachment storage quota across every project a given owner owns.
function maxTotalAttachmentBytesForProject(project) {
  if (project && project.ownerEmail === ADMIN_EMAIL) return Infinity;
  const mb = planLimitsFor(effectivePlanForProject(project)).maxTotalMB;
  return mb === Infinity ? Infinity : mb * 1024 * 1024;
}

// Sums the size of every attachment on a card: file attachments, the single
// attachment a comment can carry, and an image cover (color covers have no
// file). Used to compute an owner's total storage usage.
function attachmentBytesForCard(card) {
  let total = 0;
  (card.attachments || []).forEach((a) => {
    total += a.size || 0;
  });
  (card.comments || []).forEach((c) => {
    if (c && c.attachment) total += c.attachment.size || 0;
  });
  if (card.cover && card.cover.type === "image" && card.cover.size) {
    total += card.cover.size;
  }
  return total;
}

// Total bytes currently used across every project owned by `ownerEmail` that
// this client has loaded (live cards + trash, since trashed files still
// occupy Storage until permanently deleted). Only counts projects the
// current signed-in user can see — see the "known limitation" note in
// updateStorageAlert().
function totalAttachmentBytesForOwner(ownerEmail) {
  if (!ownerEmail) return 0;
  let total = 0;
  state.projects.forEach((p) => {
    if (p.ownerEmail !== ownerEmail) return;
    (p.columns || []).forEach((column) => {
      (column.cards || []).forEach((card) => {
        total += attachmentBytesForCard(card);
      });
    });
    (p.trash || []).forEach((item) => {
      if (item && item.card) total += attachmentBytesForCard(item.card);
    });
  });
  return total;
}

// Blocks an upload that would push the project owner's total attachment
// storage past their plan's quota (instead of silently deleting old files to
// make room). Shows an alert and returns false if blocked.
function blockedByTotalQuota(project, fileSize) {
  if (!project) return false;
  const totalLimit = maxTotalAttachmentBytesForProject(project);
  if (totalLimit === Infinity) return false;
  const used = totalAttachmentBytesForOwner(project.ownerEmail);
  if (used + fileSize <= totalLimit) return false;
  alert(
    `保存容量の上限(合計${formatMaxSize(totalLimit)})に達するため、これ以上ファイルを追加できません。不要な添付ファイルを削除するか、プランをアップグレードしてください。`
  );
  return true;
}

function formatMaxSize(bytes) {
  if (bytes === Infinity) return "無制限";
  return formatFileSize(bytes);
}

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

// ---------- avatars ----------
const AVATAR_COLORS = [
  "#5067c5",
  "#0079bf",
  "#61bd4f",
  "#ff9f1a",
  "#eb5a46",
  "#c377e0",
  "#00c2e0",
  "#51e898",
  "#ff78cb",
  "#344563",
];

function avatarColorFor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function buildAvatar(email, sizeClass) {
  const el = document.createElement("div");
  el.className = "avatar-circle" + (sizeClass ? " " + sizeClass : "");
  el.style.background = avatarColorFor(email || "?");
  el.textContent = (email || "?").trim().charAt(0).toUpperCase();
  el.title = email || "";
  return el;
}

function priorityLabel(p) {
  if (p === "high") return "高";
  if (p === "medium") return "中";
  if (p === "low") return "低";
  return "";
}

// ---------- state & firestore ----------
// Each project is its own Firestore document under `projects`, tagged with
// ownerEmail / editors / viewers / memberEmails so security rules can scope
// access per user. `state.projects` only ever holds projects the signed-in
// user actually has access to (driven by the query below).
const projectsCollection = db.collection("projects");
const legacyBoardRef = db.collection("kanban").doc("board");

let state = { projects: [] };
let unsubscribeProjects = null;
let defaultProjectCreationAttempted = false;
let migrationAttempted = false;

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

// ---------- public share (read-only, no login required) ----------
// A Business-plan project owner can flip `publicShareEnabled` on a project
// (see the members modal), which generates a `?share=<projectId>` URL.
// Anyone opening that URL — logged in or not — gets dropped straight into
// a stripped-down, read-only view of just that one project, bypassing the
// normal per-user login gate entirely. Firestore's security rules allow
// unauthenticated reads of a project doc specifically when
// publicShareEnabled == true, so this works without any auth.
const shareProjectId = new URLSearchParams(location.search).get("share");
const isPublicShareMode = !!shareProjectId;
let publicShareUnsub = null;

function getActiveProject() {
  return state.projects.find((p) => p.id === currentProjectId) || state.projects[0];
}

function ensureActiveProject() {
  if (!state.projects.find((p) => p.id === currentProjectId)) {
    currentProjectId = state.projects.length ? state.projects[0].id : null;
    if (currentProjectId) localStorage.setItem(CURRENT_PROJECT_KEY, currentProjectId);
  }
}

function getRole(project) {
  if (!currentUser || !project) return null;
  const email = currentUser.email;
  if (project.ownerEmail === email) return "owner";
  if ((project.editors || []).includes(email)) return "editor";
  if ((project.viewers || []).includes(email)) return "viewer";
  return null;
}

function canEditProject(project) {
  const role = getRole(project);
  return role === "owner" || role === "editor";
}

function isOwnerOfProject(project) {
  return getRole(project) === "owner";
}

function saveProject(project) {
  projectsCollection
    .doc(project.id)
    .set(project)
    .catch((err) => {
      console.error("Firestore write failed", err);
      alert("保存に失敗しました。このプロジェクトへの編集権限があるか確認してください。");
    });
}

function createDefaultProjectForCurrentUser() {
  if (defaultProjectCreationAttempted) return;
  defaultProjectCreationAttempted = true;
  const project = makeProject("マイプロジェクト", true);
  project.ownerUid = currentUser.uid;
  project.ownerEmail = currentUser.email;
  project.ownerPlan = effectivePlanForCurrentUser();
  project.memberEmails = buildMemberEmails(project);
  projectsCollection
    .doc(project.id)
    .set(project)
    .catch((err) => console.error("failed to create default project", err));
}

// One-time migration of the old single-document board (from before the
// project/user concept existed) into the new per-project documents, owned
// by whoever happens to run this first after the update. Returns a promise
// so the caller can wait for it before starting the live query listener
// (otherwise the listener can race the migration and create a duplicate
// blank default project).
function migrateLegacyDataIfNeeded() {
  return legacyBoardRef
    .get()
    .then((snap) => {
      if (!snap.exists) return;
      const data = snap.data();
      if (!data || data.migrated || !Array.isArray(data.projects) || !data.projects.length) return;

      const email = currentUser.email;
      const writes = data.projects.map((p) => {
        const newProject = {
          id: uid(),
          name: p.name || "マイプロジェクト",
          ownerUid: currentUser.uid,
          ownerEmail: email,
          ownerPlan: effectivePlanForCurrentUser(),
          publicShareEnabled: false,
          editors: [],
          viewers: [],
          memberEmails: [email],
          columns: Array.isArray(p.columns) ? p.columns : [],
          trash: [],
        };
        return projectsCollection.doc(newProject.id).set(newProject);
      });

      return Promise.all(writes).then(() => legacyBoardRef.set({ migrated: true }, { merge: true }));
    })
    .catch((err) => console.error("legacy migration failed", err));
}

function startProjectsListener() {
  if (unsubscribeProjects || !currentUser) return;
  unsubscribeProjects = projectsCollection
    .where("memberEmails", "array-contains", currentUser.email)
    .onSnapshot(handleProjectsSnapshot, handleProjectsError);
}

function stopProjectsListener() {
  if (unsubscribeProjects) {
    unsubscribeProjects();
    unsubscribeProjects = null;
  }
}

function handleProjectsSnapshot(querySnap) {
  const projects = [];
  querySnap.forEach((doc) => {
    const data = doc.data() || {};
    projects.push({
      id: doc.id,
      name: data.name || "無題のプロジェクト",
      ownerUid: data.ownerUid || null,
      ownerEmail: data.ownerEmail || null,
      ownerPlan: data.ownerPlan || "free",
      publicShareEnabled: !!data.publicShareEnabled,
      editors: Array.isArray(data.editors) ? data.editors : [],
      viewers: Array.isArray(data.viewers) ? data.viewers : [],
      memberEmails: Array.isArray(data.memberEmails) ? data.memberEmails : [],
      columns: Array.isArray(data.columns) ? data.columns : [],
      trash: Array.isArray(data.trash) ? data.trash : [],
    });
  });

  if (!projects.length) {
    createDefaultProjectForCurrentUser();
    return;
  }

  state.projects = projects;
  ensureActiveProject();
  renderAll();
  syncModalIfOpen();
  updateTrashBadge();
  if (!trashModal.classList.contains("hidden")) renderTrash();
  if (!membersModal.classList.contains("hidden")) renderMembersModal();
}

function handleProjectsError(err) {
  console.error("Firestore projects listen failed", err);
}

function startPublicShareView(projectId) {
  if (publicShareUnsub) return;
  const banner = document.getElementById("public-share-banner");
  if (banner) banner.classList.remove("hidden");

  publicShareUnsub = projectsCollection.doc(projectId).onSnapshot(
    (snap) => {
      if (!snap.exists || !snap.data().publicShareEnabled) {
        renderPublicShareError();
        return;
      }
      const data = snap.data();
      const project = {
        id: snap.id,
        name: data.name || "無題のプロジェクト",
        ownerUid: data.ownerUid || null,
        ownerEmail: data.ownerEmail || null,
        ownerPlan: data.ownerPlan || "free",
        publicShareEnabled: true,
        editors: Array.isArray(data.editors) ? data.editors : [],
        viewers: Array.isArray(data.viewers) ? data.viewers : [],
        memberEmails: Array.isArray(data.memberEmails) ? data.memberEmails : [],
        columns: Array.isArray(data.columns) ? data.columns : [],
        trash: [],
      };
      state.projects = [project];
      currentProjectId = project.id;
      renderAll();
    },
    (err) => {
      console.error("public share listen failed", err);
      renderPublicShareError();
    }
  );
}

function renderPublicShareError() {
  board.innerHTML =
    '<p class="table-empty" style="width:100%">このリンクは無効です。共有が解除されたか、URLが間違っている可能性があります。</p>';
  projectTitleEl.textContent = "📋 Kanban Board";
}

function renderAll() {
  renderProjectList();
  updatePlanNote();
  updateStorageAlert();
  const project = getActiveProject();
  projectTitleEl.textContent = "📋 " + (project ? project.name : "Kanban Board");
  applyDrawerState();

  // If the active project's plan doesn't allow the currently-selected view
  // (e.g. switching into a Free-plan project while on Calendar), fall back
  // to Board rather than showing a blank/locked panel.
  const planViews = planLimitsFor(effectivePlanForProject(project)).views;
  if (!planViews.includes(currentView)) {
    currentView = "board";
  }
  applyViewState();

  const editable = canEditProject(project);
  addColumnBtn.classList.toggle("hidden", !editable);
  trashBtn.classList.toggle("hidden", !currentUser || !editable);
  renderMemberAvatars();

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
const memberAvatarsEl = document.getElementById("member-avatars");

memberAvatarsEl.addEventListener("click", () => {
  const project = getActiveProject();
  if (project) openMembersModal(project.id);
});

function renderMemberAvatars() {
  const project = getActiveProject();
  memberAvatarsEl.innerHTML = "";
  if (!currentUser || !project) {
    memberAvatarsEl.classList.add("hidden");
    return;
  }
  memberAvatarsEl.classList.remove("hidden");

  const ordered = [project.ownerEmail, ...(project.editors || []), ...(project.viewers || [])].filter(
    (email, idx, arr) => email && arr.indexOf(email) === idx
  );

  const maxShown = 5;
  ordered.slice(0, maxShown).forEach((email) => {
    memberAvatarsEl.appendChild(buildAvatar(email));
  });
  if (ordered.length > maxShown) {
    const more = document.createElement("div");
    more.className = "avatar-circle avatar-more";
    more.textContent = "+" + (ordered.length - maxShown);
    memberAvatarsEl.appendChild(more);
  }
}

googleLoginBtn.addEventListener("click", () => {
  auth.signInWithPopup(provider).catch((err) => {
    console.error("Google sign-in failed", err);
    alert("ログインに失敗しました: " + err.message);
  });
});

// ---------- email/password authentication ----------
const emailAuthEmailInput = document.getElementById("email-auth-email");
const emailAuthPasswordInput = document.getElementById("email-auth-password");
const emailAuthErrorEl = document.getElementById("email-auth-error");
const emailAuthSubmitBtn = document.getElementById("email-auth-submit-btn");
const emailAuthToggleBtn = document.getElementById("email-auth-toggle-btn");
const emailAuthToggleText = document.getElementById("email-auth-toggle-text");
const emailAuthForgotBtn = document.getElementById("email-auth-forgot-btn");

let emailAuthMode = "login"; // "login" | "signup"

function updateEmailAuthUI() {
  if (emailAuthMode === "login") {
    emailAuthSubmitBtn.textContent = "ログイン";
    emailAuthToggleText.textContent = "アカウントをお持ちでないですか？";
    emailAuthToggleBtn.textContent = "新規登録";
  } else {
    emailAuthSubmitBtn.textContent = "アカウント作成";
    emailAuthToggleText.textContent = "すでにアカウントをお持ちですか？";
    emailAuthToggleBtn.textContent = "ログイン";
  }
  emailAuthErrorEl.classList.add("hidden");
}
updateEmailAuthUI();

function showEmailAuthError(message) {
  emailAuthErrorEl.textContent = message;
  emailAuthErrorEl.classList.remove("hidden");
}

function translateAuthError(err) {
  const map = {
    "auth/email-already-in-use": "このメールアドレスは既に登録されています。",
    "auth/invalid-email": "メールアドレスの形式が正しくありません。",
    "auth/weak-password": "パスワードは6文字以上にしてください。",
    "auth/user-not-found": "該当するアカウントが見つかりません。",
    "auth/wrong-password": "パスワードが違います。",
    "auth/invalid-credential": "メールアドレスまたはパスワードが違います。",
    "auth/missing-password": "パスワードを入力してください。",
    "auth/too-many-requests": "試行回数が多すぎます。しばらくしてから再試行してください。",
  };
  return map[err.code] || err.message;
}

emailAuthToggleBtn.addEventListener("click", () => {
  emailAuthMode = emailAuthMode === "login" ? "signup" : "login";
  updateEmailAuthUI();
});

emailAuthSubmitBtn.addEventListener("click", () => {
  const email = emailAuthEmailInput.value.trim();
  const password = emailAuthPasswordInput.value;
  if (!email || !password) {
    showEmailAuthError("メールアドレスとパスワードを入力してください。");
    return;
  }

  emailAuthSubmitBtn.disabled = true;
  const action =
    emailAuthMode === "login"
      ? auth.signInWithEmailAndPassword(email, password)
      : auth.createUserWithEmailAndPassword(email, password);

  action
    .catch((err) => {
      console.error("email auth failed", err);
      showEmailAuthError(translateAuthError(err));
    })
    .finally(() => {
      emailAuthSubmitBtn.disabled = false;
    });
});

emailAuthForgotBtn.addEventListener("click", () => {
  const email = emailAuthEmailInput.value.trim();
  if (!email) {
    showEmailAuthError("パスワード再設定にはメールアドレスを入力してください。");
    return;
  }
  auth
    .sendPasswordResetEmail(email)
    .then(() => {
      alert("パスワード再設定メールを送信しました。メールを確認してください。");
    })
    .catch((err) => {
      console.error("password reset failed", err);
      showEmailAuthError(translateAuthError(err));
    });
});

logoutBtn.addEventListener("click", () => {
  openConfirmModal({
    title: "ログアウトしますか？",
    message: "",
    okLabel: "ログアウトする",
    onConfirm: () => auth.signOut(),
  });
});

auth.onAuthStateChanged((user) => {
  currentUser = user;

  if (isPublicShareMode) {
    // Public read-only mode: never show the login gate, never start the
    // normal per-user project listener — just load the one shared project.
    document.body.classList.add("public-share-mode");
    authModal.classList.add("hidden");
    if (user) ensureUserProfile();
    startPublicShareView(shareProjectId);
    return;
  }

  if (user) {
    authModal.classList.add("hidden");
    userInfoEl.textContent = "👤 " + (user.displayName || user.email || "ログイン中");
    userInfoEl.classList.remove("hidden");
    logoutBtn.classList.remove("hidden");
    emailAuthEmailInput.value = "";
    emailAuthPasswordInput.value = "";

    ensureUserProfile();

    if (!migrationAttempted) {
      migrationAttempted = true;
      migrateLegacyDataIfNeeded().finally(() => startProjectsListener());
    } else {
      startProjectsListener();
    }
  } else {
    authModal.classList.remove("hidden");
    userInfoEl.classList.add("hidden");
    logoutBtn.classList.add("hidden");
    trashBtn.classList.add("hidden");
    trashModal.classList.add("hidden");
    membersModal.classList.add("hidden");
    profileModal.classList.add("hidden");
    memberAvatarsEl.classList.add("hidden");
    closeCardModal();
    board.innerHTML = "";
    state.projects = [];
    userProfile = null;
    defaultProjectCreationAttempted = false;
    migrationAttempted = false;

    if (userProfileUnsub) {
      userProfileUnsub();
      userProfileUnsub = null;
    }

    stopProjectsListener();
  }
});

// ---------- project drawer ----------
const projectDrawer = document.getElementById("project-drawer");
const drawerToggleBtn = document.getElementById("drawer-toggle-btn");
const projectTitleEl = document.getElementById("project-title");
const projectListEl = document.getElementById("project-list");
const addProjectBtn = document.getElementById("add-project-btn");
const planNoteEl = document.getElementById("plan-note");
const planNoteLinkBtn = document.getElementById("plan-note-link");

function applyDrawerState() {
  projectDrawer.classList.toggle("closed", !drawerOpen);
}

function updatePlanNote() {
  const plan = effectivePlanForCurrentUser();
  const limits = planLimitsFor(plan);
  const shouldShow = !!currentUser && plan === "free";
  planNoteEl.classList.toggle("hidden", !shouldShow);
  if (shouldShow) {
    planNoteEl.querySelector("span").textContent =
      `🔒 Freeプランでは最大${limits.maxProjects}プロジェクトまで`;
  }
}

planNoteEl.addEventListener("click", () => openPlansModal());

// ---------- storage quota header alert ----------
const storageAlertBannerEl = document.getElementById("storage-alert-banner");
const storageAlertTextEl = document.getElementById("storage-alert-text");
const storageAlertLinkBtn = document.getElementById("storage-alert-link");

// Shows a header warning once the signed-in user's total attachment storage
// (as OWNER, summed across every project they own) gets within
// STORAGE_ALERT_THRESHOLD_MB of their plan's total quota. Admin and
// Business (unlimited quota) never trigger this.
function updateStorageAlert() {
  if (!currentUser) {
    storageAlertBannerEl.classList.add("hidden");
    return;
  }
  const limitBytes = maxTotalAttachmentBytesForProject({ ownerEmail: currentUser.email });
  if (limitBytes === Infinity) {
    storageAlertBannerEl.classList.add("hidden");
    return;
  }
  const usedBytes = totalAttachmentBytesForOwner(currentUser.email);
  const remainingBytes = limitBytes - usedBytes;
  const thresholdBytes = STORAGE_ALERT_THRESHOLD_MB * 1024 * 1024;

  if (remainingBytes <= thresholdBytes) {
    storageAlertTextEl.textContent =
      `添付ファイルの容量が残り${formatMaxSize(Math.max(0, remainingBytes))}です(上限${formatMaxSize(limitBytes)})。上限に達すると新しい添付ができなくなります。`;
    storageAlertBannerEl.classList.remove("hidden");
  } else {
    storageAlertBannerEl.classList.add("hidden");
  }
}

storageAlertLinkBtn.addEventListener("click", () => openPlansModal());

drawerToggleBtn.addEventListener("click", () => {
  drawerOpen = !drawerOpen;
  localStorage.setItem(DRAWER_OPEN_KEY, String(drawerOpen));
  applyDrawerState();
});

// Groups the project list into "自分のプロジェクト" (owned) and "共有された
// プロジェクト" (invited as editor/viewer) so it's clear at a glance which
// projects the signed-in user actually created versus was invited into,
// instead of a single undifferentiated list.
function renderProjectList() {
  projectListEl.innerHTML = "";

  const owned = state.projects.filter((p) => isOwnerOfProject(p));
  const shared = state.projects.filter((p) => !isOwnerOfProject(p));

  function appendGroup(projects, label) {
    if (!projects.length) return;
    const heading = document.createElement("div");
    heading.className = "project-group-heading";
    heading.textContent = label;
    projectListEl.appendChild(heading);
    projects.forEach((project) => projectListEl.appendChild(buildProjectRow(project)));
  }

  appendGroup(owned, "自分のプロジェクト");
  appendGroup(shared, "共有されたプロジェクト");
}

function buildProjectRow(project) {
  const row = document.createElement("div");
  row.className = "project-item" + (project.id === currentProjectId ? " active" : "");
  row.addEventListener("click", () => {
    currentProjectId = project.id;
    localStorage.setItem(CURRENT_PROJECT_KEY, currentProjectId);
    renderAll();
  });

  const isOwner = isOwnerOfProject(project);
  const editable = canEditProject(project);
  const role = getRole(project);

  const nameInput = document.createElement("input");
  nameInput.className = "project-name-input";
  nameInput.value = project.name;
  nameInput.disabled = !editable;
  nameInput.addEventListener("click", (e) => e.stopPropagation());
  nameInput.addEventListener("change", () => {
    project.name = nameInput.value.trim() || project.name;
    saveProject(project);
  });
  row.appendChild(nameInput);

  if (!isOwner) {
    const roleBadge = document.createElement("span");
    roleBadge.className = "project-role-badge";
    roleBadge.textContent = role === "editor" ? "編集者" : "閲覧のみ";
    roleBadge.title = role === "editor" ? "共同編集者として招待されています" : "閲覧のみの権限で招待されています";
    row.appendChild(roleBadge);
  }

  const membersBtn = document.createElement("button");
  membersBtn.className = "project-members-btn";
  membersBtn.textContent = "👥";
  membersBtn.title = "メンバー";
  membersBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openMembersModal(project.id);
  });
  row.appendChild(membersBtn);

  if (isOwner) {
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
          (project.columns || []).forEach((col) => (col.cards || []).forEach((c) => deleteCardStorageFiles(c)));
          (project.trash || []).forEach((item) => deleteCardStorageFiles(item.card));
          projectsCollection
            .doc(project.id)
            .delete()
            .catch((err) => {
              console.error("delete failed", err);
              alert("削除に失敗しました。");
            });
        },
      });
    });
    row.appendChild(delBtn);
  }

  return row;
}

addProjectBtn.addEventListener("click", () => {
  if (!currentUser) return;
  const plan = effectivePlanForCurrentUser();
  const limits = planLimitsFor(plan);
  const ownedCount = state.projects.filter((p) => p.ownerEmail === currentUser.email).length;
  if (ownedCount >= limits.maxProjects) {
    openPlansModal();
    return;
  }
  const project = makeProject("新しいプロジェクト", false);
  project.ownerUid = currentUser.uid;
  project.ownerEmail = currentUser.email;
  project.ownerPlan = plan;
  project.memberEmails = buildMemberEmails(project);
  currentProjectId = project.id;
  localStorage.setItem(CURRENT_PROJECT_KEY, currentProjectId);
  saveProject(project);
});

// ---------- members / invite modal ----------
const membersModal = document.getElementById("members-modal");
const membersCloseBtn = document.getElementById("members-close-btn");
const membersModalTitle = document.getElementById("members-modal-title");
const membersListEl = document.getElementById("members-list");
const inviteForm = document.getElementById("invite-form");
const inviteNote = document.getElementById("invite-note");
const inviteEmailInput = document.getElementById("invite-email-input");
const inviteRoleSelect = document.getElementById("invite-role-select");
const inviteSubmitBtn = document.getElementById("invite-submit-btn");
const publicShareSection = document.getElementById("public-share-section");
const publicShareToggle = document.getElementById("public-share-toggle");
const publicShareLinkRow = document.getElementById("public-share-link-row");
const publicShareUrlInput = document.getElementById("public-share-url");
const publicShareCopyBtn = document.getElementById("public-share-copy-btn");

function buildShareUrl(projectId) {
  return location.origin + location.pathname + "?share=" + projectId;
}

let membersModalProjectId = null;

function openMembersModal(projectId) {
  membersModalProjectId = projectId;
  renderMembersModal();
  membersModal.classList.remove("hidden");
}

function memberRow(email, roleLabel, onRemove) {
  const row = document.createElement("div");
  row.className = "member-row";

  row.appendChild(buildAvatar(email, "small"));

  const label = document.createElement("span");
  label.textContent = email;

  const role = document.createElement("span");
  role.className = "member-role-badge";
  role.textContent = roleLabel;

  row.appendChild(label);
  row.appendChild(role);

  if (onRemove) {
    const rm = document.createElement("button");
    rm.className = "member-remove-btn";
    rm.textContent = "削除";
    rm.addEventListener("click", onRemove);
    row.appendChild(rm);
  }

  return row;
}

function memberGroupLabel(text) {
  const label = document.createElement("div");
  label.className = "member-group-label";
  label.textContent = text;
  return label;
}

function renderMembersModal() {
  const project = state.projects.find((p) => p.id === membersModalProjectId);
  if (!project) {
    membersModal.classList.add("hidden");
    return;
  }
  const isOwner = isOwnerOfProject(project);

  membersModalTitle.textContent = "👥 " + project.name + " のメンバー";
  membersListEl.innerHTML = "";

  membersListEl.appendChild(memberGroupLabel("オーナー"));
  membersListEl.appendChild(memberRow(project.ownerEmail || "(不明)", "オーナー", null));

  if ((project.editors || []).length) {
    membersListEl.appendChild(memberGroupLabel("共同編集"));
    project.editors.forEach((email) => {
      membersListEl.appendChild(
        memberRow(
          email,
          "共同編集",
          isOwner
            ? () => {
                project.editors = project.editors.filter((e) => e !== email);
                project.memberEmails = buildMemberEmails(project);
                saveProject(project);
              }
            : null
        )
      );
    });
  }

  if ((project.viewers || []).length) {
    membersListEl.appendChild(memberGroupLabel("閲覧者"));
    project.viewers.forEach((email) => {
      membersListEl.appendChild(
        memberRow(
          email,
          "閲覧のみ",
          isOwner
            ? () => {
                project.viewers = project.viewers.filter((e) => e !== email);
                project.memberEmails = buildMemberEmails(project);
                saveProject(project);
              }
            : null
        )
      );
    });
  }

  inviteForm.classList.toggle("hidden", !isOwner);
  inviteNote.classList.toggle("hidden", !isOwner);

  const canManageShare = isOwner && effectivePlanForProject(project) === "business";
  publicShareSection.classList.toggle("hidden", !canManageShare);
  if (canManageShare) {
    publicShareToggle.checked = !!project.publicShareEnabled;
    publicShareLinkRow.classList.toggle("hidden", !project.publicShareEnabled);
    if (project.publicShareEnabled) {
      publicShareUrlInput.value = buildShareUrl(project.id);
    }
  }
}

publicShareToggle.addEventListener("change", () => {
  const project = state.projects.find((p) => p.id === membersModalProjectId);
  if (!project || !isOwnerOfProject(project) || effectivePlanForProject(project) !== "business") {
    publicShareToggle.checked = false;
    return;
  }
  project.publicShareEnabled = publicShareToggle.checked;
  saveProject(project);
  renderMembersModal();
});

publicShareCopyBtn.addEventListener("click", () => {
  const value = publicShareUrlInput.value;
  if (!value) return;
  const done = () => {
    publicShareCopyBtn.textContent = "コピーしました";
    setTimeout(() => {
      publicShareCopyBtn.textContent = "コピー";
    }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(done).catch(() => {
      publicShareUrlInput.select();
    });
  } else {
    publicShareUrlInput.select();
    document.execCommand("copy");
    done();
  }
});

inviteSubmitBtn.addEventListener("click", () => {
  const project = state.projects.find((p) => p.id === membersModalProjectId);
  if (!project) return;
  const email = inviteEmailInput.value.trim().toLowerCase();
  const role = inviteRoleSelect.value;

  if (!email || !email.includes("@")) {
    alert("正しいメールアドレスを入力してください。");
    return;
  }
  if (email === (project.ownerEmail || "").toLowerCase()) {
    alert("オーナー自身は招待できません。");
    return;
  }

  project.editors = (project.editors || []).filter((e) => e !== email);
  project.viewers = (project.viewers || []).filter((e) => e !== email);
  if (role === "editor") project.editors.push(email);
  else project.viewers.push(email);
  project.memberEmails = buildMemberEmails(project);

  saveProject(project);
  inviteEmailInput.value = "";
  renderMembersModal();
});

membersCloseBtn.addEventListener("click", () => membersModal.classList.add("hidden"));
membersModal.addEventListener("click", (e) => {
  if (e.target === membersModal) membersModal.classList.add("hidden");
});

// ---------- user profile ----------
// A lightweight per-user profile document, separate from the project/member
// data above. Holds a display name, optional photo, and the user's billing
// plan/subscription state, which is written by the Stripe webhook (see
// api/stripe-webhook.js) — the client only ever reads these fields.
const usersCollection = db.collection("users");
let userProfile = null;

const profileModal = document.getElementById("profile-modal");
const profileCloseBtn = document.getElementById("profile-close-btn");
const profileAvatarEl = document.getElementById("profile-avatar");
const profileEmailDisplay = document.getElementById("profile-email-display");
const profileNameInput = document.getElementById("profile-name-input");
const profilePlanInfoEl = document.getElementById("profile-plan-info");
const profileChangePlanBtn = document.getElementById("profile-change-plan-btn");
const profileManageBillingBtn = document.getElementById("profile-manage-billing-btn");
const profileSaveBtn = document.getElementById("profile-save-btn");

let userProfileUnsub = null;

// Live-listens to the user's profile doc (instead of a one-time get()) so
// that a plan change written server-side by the Stripe webhook — which can
// happen at any moment after a checkout completes or a subscription renews —
// shows up immediately in the UI without needing a page reload.
function ensureUserProfile() {
  if (!currentUser) return;
  if (userProfileUnsub) {
    userProfileUnsub();
    userProfileUnsub = null;
  }

  const ref = usersCollection.doc(currentUser.uid);
  userProfileUnsub = ref.onSnapshot(
    (snap) => {
      if (snap.exists) {
        userProfile = snap.data();
      } else {
        userProfile = {
          displayName: currentUser.displayName || (currentUser.email || "").split("@")[0],
          email: currentUser.email || "",
          photoURL: currentUser.photoURL || null,
          plan: "free",
          createdAt: new Date().toISOString(),
        };
        ref.set(userProfile).catch((err) => console.error("failed to create user profile", err));
      }
      updateUserInfoDisplay();
      updatePlanNote();
      applyViewState();
      if (!plansModal.classList.contains("hidden")) refreshPlansModalState();
      if (!profileModal.classList.contains("hidden")) refreshProfileModalPlanInfo();
    },
    (err) => console.error("failed to load user profile", err)
  );
}

function updateUserInfoDisplay() {
  if (!currentUser) return;
  const name = (userProfile && userProfile.displayName) || currentUser.displayName || currentUser.email;
  userInfoEl.textContent = "👤 " + name;
}

function openProfileModal() {
  if (!currentUser) return;
  const name = (userProfile && userProfile.displayName) || currentUser.displayName || currentUser.email || "?";
  const photoURL = (userProfile && userProfile.photoURL) || currentUser.photoURL || null;

  profileAvatarEl.textContent = "";
  profileAvatarEl.style.backgroundImage = "";
  if (photoURL) {
    profileAvatarEl.style.backgroundImage = `url(${photoURL})`;
  } else {
    profileAvatarEl.style.background = avatarColorFor(currentUser.email || name);
    profileAvatarEl.textContent = name.trim().charAt(0).toUpperCase();
  }

  profileEmailDisplay.textContent = currentUser.email || "";
  profileNameInput.value = name;
  refreshProfileModalPlanInfo();
  profileModal.classList.remove("hidden");
}

function formatDateJP(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// Plan changes are no longer something the client can just write to
// Firestore directly (see the users/{uid} security rule) — they only ever
// come from the Stripe webhook. This just renders whatever userProfile
// currently holds.
function refreshProfileModalPlanInfo() {
  const plan = effectivePlanForCurrentUser();
  const label = planLimitsFor(plan).label;
  let text = `現在のプラン: ${label}`;

  if (isAdminUser(currentUser)) {
    text += "(管理者・制限なし)";
  } else if (userProfile && userProfile.planCancelAtPeriodEnd && userProfile.currentPeriodEnd) {
    text += ` ・ ${formatDateJP(userProfile.currentPeriodEnd)}にFreeプランへ変更予定`;
  } else if (plan !== "free" && userProfile && userProfile.currentPeriodEnd) {
    text += ` ・ 次回更新日: ${formatDateJP(userProfile.currentPeriodEnd)}`;
  }

  profilePlanInfoEl.textContent = text;
  profileManageBillingBtn.classList.toggle("hidden", !(userProfile && userProfile.stripeCustomerId));
}

userInfoEl.addEventListener("click", openProfileModal);
profileCloseBtn.addEventListener("click", () => profileModal.classList.add("hidden"));
profileModal.addEventListener("click", (e) => {
  if (e.target === profileModal) profileModal.classList.add("hidden");
});

profileSaveBtn.addEventListener("click", () => {
  if (!currentUser) return;
  const name = profileNameInput.value.trim() || (userProfile && userProfile.displayName) || currentUser.email;

  usersCollection
    .doc(currentUser.uid)
    .set({ displayName: name }, { merge: true })
    .then(() => {
      updateUserInfoDisplay();
      profileModal.classList.add("hidden");
    })
    .catch((err) => {
      console.error("failed to save profile", err);
      alert("プロフィールの保存に失敗しました。");
    });
});

profileChangePlanBtn.addEventListener("click", () => {
  profileModal.classList.add("hidden");
  openPlansModal();
});

profileManageBillingBtn.addEventListener("click", () => {
  profileManageBillingBtn.disabled = true;
  callBillingApi("/api/create-portal-session")
    .then((data) => {
      window.location.href = data.url;
    })
    .catch((err) => {
      alert(err.message || "お支払い管理ページを開けませんでした。");
      profileManageBillingBtn.disabled = false;
    });
});

// ---------- billing: Firebase ID token + API helper ----------
async function getIdToken() {
  if (!auth.currentUser) throw new Error("ログインしていません。");
  return auth.currentUser.getIdToken();
}

async function callBillingApi(path, body) {
  const token = await getIdToken();
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `リクエストに失敗しました (${res.status})`);
  }
  return data;
}

// ---------- billing: checkout redirect banner ----------
const billingToastEl = document.getElementById("billing-toast");

function showBillingToast(message, isError) {
  if (!billingToastEl) return;
  billingToastEl.textContent = message;
  billingToastEl.classList.toggle("error", !!isError);
  billingToastEl.classList.remove("hidden");
  setTimeout(() => billingToastEl.classList.add("hidden"), 8000);
}

(function handleCheckoutRedirect() {
  const params = new URLSearchParams(window.location.search);
  const checkout = params.get("checkout");
  if (!checkout) return;

  if (checkout === "success") {
    showBillingToast("✅ お支払いが完了しました。反映まで数秒お待ちください。");
  } else if (checkout === "cancel") {
    showBillingToast("決済がキャンセルされました。", true);
  }

  params.delete("checkout");
  const newSearch = params.toString();
  const newUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "") + window.location.hash;
  window.history.replaceState({}, "", newUrl);
})();

// ---------- plans / upgrade modal ----------
const plansModal = document.getElementById("plans-modal");
const plansCloseBtn = document.getElementById("plans-close-btn");
const plansPendingNoteEl = document.getElementById("plans-pending-note");

function openPlansModal() {
  if (!currentUser) return;
  refreshPlansModalState();
  plansModal.classList.remove("hidden");
}

function refreshPlansModalState() {
  const current = effectivePlanForCurrentUser();
  const admin = isAdminUser(currentUser);

  document.querySelectorAll(".plan-column").forEach((col) => {
    const colPlan = col.dataset.plan;
    const isCurrent = colPlan === current;
    col.classList.toggle("current", isCurrent);
    const btn = col.querySelector(".plan-select-btn");
    if (!btn) return;
    btn.disabled = false;
    btn.dataset.action = "";

    if (admin) {
      btn.disabled = true;
      btn.textContent = isCurrent ? "現在のプラン" : "管理者は対象外";
      return;
    }

    if (isCurrent) {
      btn.disabled = true;
      btn.textContent = "現在のプラン";
    } else if (colPlan === "free") {
      if (userProfile && userProfile.planCancelAtPeriodEnd) {
        btn.textContent = "ダウングレード予定を取消す";
        btn.dataset.action = "resume";
      } else {
        btn.textContent = "ダウングレードする";
        btn.dataset.action = "downgrade";
      }
    } else if (current === "free") {
      btn.textContent = "このプランにする";
      btn.dataset.action = "checkout";
    } else {
      btn.textContent = "このプランに切り替える";
      btn.dataset.action = "portal";
    }
  });

  if (plansPendingNoteEl) {
    if (!admin && userProfile && userProfile.planCancelAtPeriodEnd && userProfile.currentPeriodEnd) {
      plansPendingNoteEl.textContent = `⚠️ ${formatDateJP(
        userProfile.currentPeriodEnd
      )}にFreeプランへ自動的に切り替わります。`;
      plansPendingNoteEl.classList.remove("hidden");
    } else {
      plansPendingNoteEl.classList.add("hidden");
    }
  }
}

document.querySelectorAll(".plan-select-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const plan = btn.dataset.plan;
    const action = btn.dataset.action;
    if (!action) return;

    if (action === "checkout") {
      btn.disabled = true;
      btn.textContent = "リダイレクト中…";
      callBillingApi("/api/create-checkout-session", { plan })
        .then((data) => {
          window.location.href = data.url;
        })
        .catch((err) => {
          alert(err.message || "決済ページを開けませんでした。");
          refreshPlansModalState();
        });
    } else if (action === "portal") {
      btn.disabled = true;
      btn.textContent = "リダイレクト中…";
      callBillingApi("/api/create-portal-session")
        .then((data) => {
          window.location.href = data.url;
        })
        .catch((err) => {
          alert(err.message || "お支払い管理ページを開けませんでした。");
          refreshPlansModalState();
        });
    } else if (action === "downgrade") {
      openConfirmModal({
        title: "Freeプランにダウングレードしますか？",
        message: "現在の請求期間の終了時に反映されます。それまでは今のプランの機能を引き続きご利用いただけます。",
        okLabel: "ダウングレードする",
        onConfirm: () => {
          callBillingApi("/api/cancel-subscription", { resume: false })
            .then(() => refreshPlansModalState())
            .catch((err) => alert(err.message || "処理に失敗しました。"));
        },
      });
    } else if (action === "resume") {
      callBillingApi("/api/cancel-subscription", { resume: true })
        .then(() => refreshPlansModalState())
        .catch((err) => alert(err.message || "処理に失敗しました。"));
    }
  });
});

plansCloseBtn.addEventListener("click", () => plansModal.classList.add("hidden"));
plansModal.addEventListener("click", (e) => {
  if (e.target === plansModal) plansModal.classList.add("hidden");
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
  const project = getActiveProject();
  const planViews = planLimitsFor(effectivePlanForProject(project)).views;
  viewTabButtons.forEach((tab) => {
    const allowed = planViews.includes(tab.dataset.view);
    tab.classList.toggle("active", tab.dataset.view === currentView && allowed);
    tab.classList.toggle("locked", !allowed);
  });
  Object.keys(viewPanels).forEach((key) => {
    viewPanels[key].classList.toggle("hidden", key !== currentView);
  });
}

viewTabButtons.forEach((tab) => {
  tab.addEventListener("click", () => {
    const project = getActiveProject();
    const planViews = planLimitsFor(effectivePlanForProject(project)).views;
    if (!planViews.includes(tab.dataset.view)) {
      openPlansModal();
      return;
    }
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
  if (!project || !canEditProject(project)) return;
  project.columns.push(makeColumn("新しいリスト"));
  saveProject(project);
});

// Tracks the card currently being dragged so dragover/drop handlers know
// what's moving without relying on dataTransfer.getData() (unreliable to
// read during dragover in some browsers). Cleared on dragend.
let draggingCardInfo = null;

// Returns the card element the dragged card should be inserted BEFORE,
// based on vertical mouse position (compares against each card's vertical
// midpoint). Returns null if the card should go at the very end of the list.
function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll(".card:not(.dragging)")];
  return els.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function ensureDropPlaceholder(height) {
  let placeholder = document.querySelector(".card-drop-placeholder");
  if (!placeholder) {
    placeholder = document.createElement("div");
    placeholder.className = "card-drop-placeholder";
  }
  placeholder.style.height = (height || 56) + "px";
  return placeholder;
}

function clearDragVisuals() {
  document.querySelectorAll(".card-drop-placeholder").forEach((el) => el.remove());
  document.querySelectorAll(".column.drag-over").forEach((el) => el.classList.remove("drag-over"));
}

function renderBoard() {
  const project = getActiveProject();
  board.innerHTML = "";
  if (!project) return;
  const editable = canEditProject(project);

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
    titleInput.disabled = !editable;
    titleInput.addEventListener("change", () => {
      column.title = titleInput.value || "リスト";
      saveProject(project);
    });
    header.appendChild(titleInput);

    if (editable) {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete-column-btn";
      deleteBtn.textContent = "✕";
      deleteBtn.title = "リストを削除";
      deleteBtn.addEventListener("click", () => {
        if (confirm(`「${column.title}」を削除しますか？`)) {
          project.columns = project.columns.filter((c) => c.id !== column.id);
          saveProject(project);
        }
      });
      header.appendChild(deleteBtn);
    }

    columnEl.appendChild(header);

    // card list
    const cardList = document.createElement("div");
    cardList.className = "card-list";

    column.cards.forEach((card) => {
      const cardEl = document.createElement("div");
      cardEl.className = "card";
      cardEl.draggable = editable;
      cardEl.dataset.cardId = card.id;

      cardEl.addEventListener("dragstart", (e) => {
        cardEl.classList.add("dragging");
        draggingCardInfo = { cardId: card.id, fromColumnId: column.id, height: cardEl.offsetHeight };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(
          "text/plain",
          JSON.stringify({ cardId: card.id, fromColumnId: column.id })
        );
      });
      cardEl.addEventListener("dragend", () => {
        cardEl.classList.remove("dragging");
        draggingCardInfo = null;
        clearDragVisuals();
      });
      cardEl.addEventListener("click", () => openCardModal(column.id, card.id));

      if (card.cover) {
        const coverEl = document.createElement("div");
        coverEl.className = "card-cover " + (card.cover.type === "image" ? "image-cover" : "color-cover");
        if (card.cover.type === "image" && card.cover.url) {
          coverEl.style.backgroundImage = `url(${card.cover.url})`;
        } else if (card.cover.type === "color" && card.cover.color) {
          coverEl.style.background = card.cover.color;
        }
        cardEl.appendChild(coverEl);
      }

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

      if (editable) {
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
      }

      cardList.appendChild(cardEl);
    });

    columnEl.appendChild(cardList);

    // add card control
    if (editable) {
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
            saveProject(project);
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
    }

    // drop handling — dragover shows a placeholder at the exact spot the
    // card would land (based on cursor position among the existing cards),
    // and drop inserts the card at that same spot instead of always
    // appending to the end. Handles both cross-column moves and reordering
    // within the same list.
    cardList.addEventListener("dragover", (e) => {
      if (!editable || !draggingCardInfo) return;
      e.preventDefault();
      e.stopPropagation();
      columnEl.classList.add("drag-over");
      const placeholder = ensureDropPlaceholder(draggingCardInfo.height);
      const afterElement = getDragAfterElement(cardList, e.clientY);
      if (afterElement == null) {
        cardList.appendChild(placeholder);
      } else {
        cardList.insertBefore(placeholder, afterElement);
      }
    });

    cardList.addEventListener("dragleave", (e) => {
      if (cardList.contains(e.relatedTarget)) return;
      columnEl.classList.remove("drag-over");
      const placeholder = cardList.querySelector(".card-drop-placeholder");
      if (placeholder) placeholder.remove();
    });

    cardList.addEventListener("drop", (e) => {
      if (!editable || !draggingCardInfo) return;
      e.preventDefault();
      e.stopPropagation();
      columnEl.classList.remove("drag-over");

      const afterElement = getDragAfterElement(cardList, e.clientY);
      clearDragVisuals();

      const { cardId, fromColumnId } = draggingCardInfo;
      const fromColumn = project.columns.find((c) => c.id === fromColumnId);
      if (!fromColumn) return;
      const cardIndex = fromColumn.cards.findIndex((c) => c.id === cardId);
      if (cardIndex === -1) return;
      const [movedCard] = fromColumn.cards.splice(cardIndex, 1);

      let insertIndex = column.cards.length;
      if (afterElement) {
        const idx = column.cards.findIndex((c) => c.id === afterElement.dataset.cardId);
        if (idx !== -1) insertIndex = idx;
      }
      column.cards.splice(insertIndex, 0, movedCard);
      saveProject(project);
    });

    board.appendChild(columnEl);
  });
}

// ---------- table view ----------
const PRIORITY_RANK = { none: 0, low: 1, medium: 2, high: 3 };
let tableSortKey = null;
let tableSortDir = 1; // 1 = ascending, -1 = descending

function tableRowSortValue(row, key) {
  switch (key) {
    case "list":
      return row.column.title || "";
    case "start":
      return row.card.startDate || "";
    case "due":
      return row.card.dueDate || "";
    case "priority":
      return PRIORITY_RANK[row.card.priority || "none"];
    case "members":
      return (row.card.members || []).slice().sort().join(", ");
    default:
      return "";
  }
}

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

  if (tableSortKey) {
    rows.sort((a, b) => {
      const av = tableRowSortValue(a, tableSortKey);
      const bv = tableRowSortValue(b, tableSortKey);
      if (av < bv) return -1 * tableSortDir;
      if (av > bv) return 1 * tableSortDir;
      return 0;
    });
  }

  const table = document.createElement("table");
  table.className = "kanban-table";

  const thead = document.createElement("thead");
  const headTr = document.createElement("tr");
  [
    { label: "タイトル", key: null },
    { label: "リスト", key: "list" },
    { label: "開始日", key: "start" },
    { label: "期日", key: "due" },
    { label: "重要度", key: "priority" },
    { label: "メンバー", key: "members" },
    { label: "💬", key: null },
    { label: "📎", key: null },
  ].forEach(({ label, key }) => {
    const th = document.createElement("th");
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    th.appendChild(labelSpan);
    if (key) {
      th.classList.add("sortable-th");
      if (tableSortKey === key) {
        const arrow = document.createElement("span");
        arrow.className = "sort-arrow";
        arrow.textContent = tableSortDir === 1 ? " ▲" : " ▼";
        th.appendChild(arrow);
      }
      th.addEventListener("click", () => {
        if (tableSortKey === key) {
          tableSortDir = -tableSortDir;
        } else {
          tableSortKey = key;
          tableSortDir = 1;
        }
        renderTableView();
      });
    }
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
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

  // Multi-day cards (both startDate and dueDate set, different days) become
  // a single continuous bar spanning the days, instead of one chip repeated
  // in every day cell. Single-day cards (only one date, or a same-day
  // start/due) still render as a small chip inside their one day cell.
  const rangeEvents = [];
  const singleDayCardsByDate = {};

  project.columns.forEach((column) => {
    column.cards.forEach((card) => {
      if (!card.dueDate && !card.startDate) return;
      const startStr = card.startDate || card.dueDate;
      const endStr = card.dueDate || card.startDate;
      const isRange = !!(card.startDate && card.dueDate && card.startDate !== card.dueDate);

      if (isRange) {
        rangeEvents.push({
          card,
          column,
          start: new Date(startStr + "T00:00:00"),
          end: new Date(endStr + "T00:00:00"),
        });
      } else {
        (singleDayCardsByDate[endStr] = singleDayCardsByDate[endStr] || []).push({ card, column });
      }
    });
  });

  // Assign each range event a vertical "lane" once for the whole visible
  // month (classic greedy interval-scheduling), so a multi-week card keeps
  // the same lane in every week row it passes through instead of jumping
  // up/down between rows.
  rangeEvents.sort((a, b) => a.start - b.start);
  const laneEndDates = [];
  rangeEvents.forEach((ev) => {
    let lane = laneEndDates.findIndex((endDate) => endDate < ev.start);
    if (lane === -1) {
      lane = laneEndDates.length;
      laneEndDates.push(ev.end);
    } else {
      laneEndDates[lane] = ev.end;
    }
    ev.lane = lane;
  });

  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);
  const totalCells = startOffset + daysInMonth;
  const totalWeeks = Math.ceil(totalCells / 7);
  const LANE_HEIGHT = 20; // px per stacked range-bar lane

  const gridWrap = document.createElement("div");
  gridWrap.className = "calendar-grid-wrap";

  const weekdayRow = document.createElement("div");
  weekdayRow.className = "calendar-weekday-row";
  ["日", "月", "火", "水", "木", "金", "土"].forEach((d) => {
    const el = document.createElement("div");
    el.className = "calendar-weekday";
    el.textContent = d;
    weekdayRow.appendChild(el);
  });
  gridWrap.appendChild(weekdayRow);

  for (let w = 0; w < totalWeeks; w++) {
    const weekStartCellIndex = w * 7;
    const colDate = (i) => new Date(year, month, weekStartCellIndex + i - startOffset + 1);
    const weekStartDate = colDate(0);
    const weekEndDate = colDate(6);

    const weekEl = document.createElement("div");
    weekEl.className = "calendar-week";

    const daysGrid = document.createElement("div");
    daysGrid.className = "calendar-week-days";

    for (let i = 0; i < 7; i++) {
      const dayNum = weekStartCellIndex + i - startOffset + 1;
      const cell = document.createElement("div");

      if (dayNum < 1 || dayNum > daysInMonth) {
        cell.className = "calendar-cell empty";
      } else {
        const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
        cell.className = "calendar-cell" + (dateStr === todayStr ? " today" : "");

        const num = document.createElement("div");
        num.className = "calendar-date-num";
        num.textContent = String(dayNum);
        cell.appendChild(num);

        const spacer = document.createElement("div");
        spacer.className = "calendar-range-spacer";
        cell.appendChild(spacer);

        (singleDayCardsByDate[dateStr] || []).forEach(({ card, column }) => {
          const chip = document.createElement("div");
          chip.className = "calendar-card-chip";
          if (card.priority) chip.classList.add(`priority-${card.priority}`);
          chip.textContent = card.text;
          chip.title = column.title + (card.dueDate ? `\n${card.dueDate}` : "");
          chip.addEventListener("click", () => openCardModal(column.id, card.id));
          cell.appendChild(chip);
        });
      }

      daysGrid.appendChild(cell);
    }
    weekEl.appendChild(daysGrid);

    const weekEvents = rangeEvents.filter((ev) => ev.end >= weekStartDate && ev.start <= weekEndDate);
    const laneCount = weekEvents.length ? Math.max(...weekEvents.map((ev) => ev.lane)) + 1 : 0;
    weekEl.style.setProperty("--lane-count", String(laneCount));

    const barsLayer = document.createElement("div");
    barsLayer.className = "calendar-week-bars";

    weekEvents.forEach((ev) => {
      const clippedStartCol = Math.max(0, Math.round((ev.start - weekStartDate) / 86400000));
      const clippedEndCol = Math.min(6, Math.round((ev.end - weekStartDate) / 86400000));

      const bar = document.createElement("div");
      bar.className = "calendar-range-bar";
      if (ev.card.priority) bar.classList.add(`priority-${ev.card.priority}`);
      if (ev.start < weekStartDate) bar.classList.add("continues-before");
      if (ev.end > weekEndDate) bar.classList.add("continues-after");
      bar.style.left = (clippedStartCol / 7) * 100 + "%";
      bar.style.width = ((clippedEndCol - clippedStartCol + 1) / 7) * 100 + "%";
      bar.style.top = ev.lane * LANE_HEIGHT + "px";
      bar.textContent = ev.card.text;
      bar.title = `${ev.column.title}\n${ev.card.startDate} 〜 ${ev.card.dueDate}`;
      bar.addEventListener("click", () => openCardModal(ev.column.id, ev.card.id));
      barsLayer.appendChild(bar);
    });

    weekEl.appendChild(barsLayer);
    gridWrap.appendChild(weekEl);
  }

  panel.appendChild(gridWrap);
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

  // ---- attachments across all cards (including per-comment attachments) ----
  const attachmentEntries = [];
  project.columns.forEach((column) => {
    column.cards.forEach((card) => {
      (card.attachments || []).forEach((att) => {
        attachmentEntries.push({ att, card, column });
      });
      (card.comments || []).forEach((c) => {
        if (c && c.attachment) attachmentEntries.push({ att: c.attachment, card, column });
      });
    });
  });

  const attachmentsSection = document.createElement("div");
  attachmentsSection.className = "dashboard-section";
  const attachmentsTitle = document.createElement("h3");
  attachmentsTitle.textContent = `添付ファイル一覧 (${attachmentEntries.length})`;
  attachmentsSection.appendChild(attachmentsTitle);

  if (!attachmentEntries.length) {
    const p = document.createElement("p");
    p.className = "table-empty";
    p.textContent = "添付ファイルはありません";
    attachmentsSection.appendChild(p);
  } else {
    attachmentEntries.forEach(({ att, card, column }) => {
      const row = document.createElement("div");
      row.className = "dashboard-attachment-row";
      row.addEventListener("click", () => openCardModal(column.id, card.id));

      const icon = document.createElement("span");
      icon.className = "dashboard-attachment-icon";
      icon.textContent = "📎";
      row.appendChild(icon);

      const nameEl = document.createElement("span");
      nameEl.className = "dashboard-attachment-name";
      nameEl.textContent = att.name || "";
      row.appendChild(nameEl);

      const sizeEl = document.createElement("span");
      sizeEl.className = "dashboard-attachment-size";
      sizeEl.textContent = formatFileSize(att.size);
      row.appendChild(sizeEl);

      const cardEl = document.createElement("span");
      cardEl.className = "dashboard-attachment-card";
      cardEl.textContent = `${card.text} (${column.title})`;
      row.appendChild(cardEl);

      attachmentsSection.appendChild(row);
    });
  }
  panel.appendChild(attachmentsSection);

  // ---- assigned members and how many cards each is assigned to ----
  const memberCounts = {};
  project.columns.forEach((column) => {
    column.cards.forEach((card) => {
      (card.members || []).forEach((m) => {
        memberCounts[m] = (memberCounts[m] || 0) + 1;
      });
    });
  });
  const memberStats = Object.entries(memberCounts)
    .map(([email, count]) => ({ email, count }))
    .sort((a, b) => b.count - a.count);

  const membersSection = document.createElement("div");
  membersSection.className = "dashboard-section";
  const membersTitle = document.createElement("h3");
  membersTitle.textContent = "メンバーごとの担当カード数";
  membersSection.appendChild(membersTitle);

  if (!memberStats.length) {
    const p = document.createElement("p");
    p.className = "table-empty";
    p.textContent = "アサインされたメンバーはいません";
    membersSection.appendChild(p);
  } else {
    const maxMemberCount = Math.max(1, ...memberStats.map((m) => m.count));
    memberStats.forEach(({ email, count }) => {
      const barRow = document.createElement("div");
      barRow.className = "dashboard-bar-row";

      const label = document.createElement("div");
      label.className = "dashboard-bar-label";
      label.textContent = `${email} (${count})`;

      const barWrap = document.createElement("div");
      barWrap.className = "dashboard-bar-wrap";
      const bar = document.createElement("div");
      bar.className = "dashboard-bar";
      bar.style.width = (count / maxMemberCount) * 100 + "%";
      barWrap.appendChild(bar);

      barRow.appendChild(label);
      barRow.appendChild(barWrap);
      membersSection.appendChild(barRow);
    });
  }
  panel.appendChild(membersSection);
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
const modalCoverBanner = document.getElementById("modal-cover-banner");
const modalCoverControls = document.getElementById("modal-cover-controls");
const modalCoverSwatchesEl = document.getElementById("modal-cover-swatches");
const modalCoverImageInput = document.getElementById("modal-cover-image-input");
const modalCoverImageLabel = document.getElementById("modal-cover-image-label");
const modalCoverRemoveBtn = document.getElementById("modal-cover-remove-btn");
const modalCoverUploadingEl = document.getElementById("modal-cover-uploading");
const modalAttachmentHintEl = document.getElementById("modal-attachment-hint");

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
  return card ? { project, column, card } : null;
}

function applyModalEditability(editable) {
  cardModal.classList.toggle("read-only", !editable);
  modalTitleInput.disabled = !editable;
  modalStartDate.disabled = !editable;
  modalDueDate.disabled = !editable;
  modalPriority.disabled = !editable;
  modalNotes.disabled = !editable;
  modalMemberInput.disabled = !editable;
  modalCommentInput.disabled = !editable;
  modalAttachmentLabel.classList.toggle("hidden", !editable);
  modalCommentFileInput.disabled = !editable;
  document.querySelector(".attach-icon-btn").classList.toggle("hidden", !editable);
  modalCoverControls.classList.toggle("hidden", !editable);
  modalCoverImageInput.disabled = !editable;
}

// ---------- card cover (color or image) ----------
function renderCoverBanner(cover) {
  if (!cover) {
    modalCoverBanner.classList.add("hidden");
    modalCoverBanner.style.backgroundImage = "";
    modalCoverBanner.style.backgroundColor = "";
    modalCoverRemoveBtn.classList.add("hidden");
    return;
  }
  modalCoverBanner.classList.remove("hidden");
  modalCoverRemoveBtn.classList.remove("hidden");
  if (cover.type === "image" && cover.url) {
    modalCoverBanner.style.backgroundImage = `url(${cover.url})`;
    modalCoverBanner.style.backgroundColor = "";
  } else if (cover.type === "color" && cover.color) {
    modalCoverBanner.style.backgroundImage = "";
    modalCoverBanner.style.backgroundColor = cover.color;
  }
}

function renderCoverSwatches(cover) {
  modalCoverSwatchesEl.innerHTML = "";
  COVER_COLORS.forEach((color) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "cover-swatch" + (cover && cover.type === "color" && cover.color === color ? " active" : "");
    btn.style.background = color;
    btn.title = "この色をカバーに設定";
    btn.addEventListener("click", () => setCardCover({ type: "color", color }));
    modalCoverSwatchesEl.appendChild(btn);
  });
}

function setCardCover(cover) {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found || !canEditProject(found.project)) return;

  const oldCover = found.card.cover;
  found.card.cover = cover;
  saveProject(found.project);
  renderCoverBanner(found.card.cover);
  renderCoverSwatches(found.card.cover);

  if (oldCover && oldCover.type === "image" && oldCover.path && (!cover || cover.path !== oldCover.path)) {
    storage
      .ref()
      .child(oldCover.path)
      .delete()
      .catch(() => {});
  }
}

modalCoverImageInput.addEventListener("change", async () => {
  const file = modalCoverImageInput.files[0];
  modalCoverImageInput.value = "";
  if (!file || !activeCardRef) return;
  const coverProject = findCard(activeCardRef.columnId, activeCardRef.cardId)?.project;
  const coverLimit = maxFileSizeBytesForProject(coverProject);
  if (coverLimit !== Infinity && file.size > coverLimit) {
    alert(`ファイルサイズは${formatMaxSize(coverLimit)}までです。`);
    return;
  }
  if (blockedByTotalQuota(coverProject, file.size)) return;
  const targetColumnId = activeCardRef.columnId;
  const targetCardId = activeCardRef.cardId;

  modalCoverUploadingEl.classList.remove("hidden");
  modalCoverImageLabel.classList.add("disabled");
  try {
    const uploaded = await uploadFile(file, `kanban/covers/${targetCardId}`);
    const found = findCard(targetColumnId, targetCardId);
    if (!found) return;
    const oldCover = found.card.cover;
    found.card.cover = { type: "image", url: uploaded.url, path: uploaded.path, size: uploaded.size };
    saveProject(found.project);
    if (activeCardRef && activeCardRef.cardId === targetCardId) {
      renderCoverBanner(found.card.cover);
      renderCoverSwatches(found.card.cover);
    }
    if (oldCover && oldCover.type === "image" && oldCover.path) {
      storage
        .ref()
        .child(oldCover.path)
        .delete()
        .catch(() => {});
    }
  } catch (err) {
    console.error("cover upload failed", err);
    alert("カバー画像のアップロードに失敗しました: " + err.message);
  } finally {
    modalCoverUploadingEl.classList.add("hidden");
    modalCoverImageLabel.classList.remove("disabled");
  }
});

modalCoverRemoveBtn.addEventListener("click", () => setCardCover(null));

function openCardModal(columnId, cardId) {
  const found = findCard(columnId, cardId);
  if (!found) return;
  activeCardRef = { columnId, cardId };
  populateModal(found.card);
  applyModalEditability(canEditProject(found.project));
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
  renderCoverBanner(card.cover || null);
  renderCoverSwatches(card.cover || null);
  pendingCommentFile = null;
  renderPendingFile();

  updateAttachmentHint();
}

// Formats a byte count as a whole-number MB string (no decimal place) —
// used for the "remaining capacity" figure, where sub-MB precision isn't
// useful and just adds visual noise.
function formatWholeMB(bytes) {
  if (bytes === Infinity) return "無制限";
  return Math.max(0, Math.round(bytes / (1024 * 1024))) + "MB";
}

// Refreshes the "1ファイルあたり◯MBまで(残り◯MB)" hint under the attachment
// button. Called both when the modal first opens and whenever the modal's
// live Firestore sync fires (so the remaining figure stays accurate as
// files are added/removed without needing to reopen the card).
function updateAttachmentHint() {
  const project = getActiveProject();
  const totalLimit = maxTotalAttachmentBytesForProject(project);
  let hint = "1ファイルあたり" + formatMaxSize(maxFileSizeBytesForProject(project)) + "まで";
  if (totalLimit !== Infinity) {
    const used = totalAttachmentBytesForOwner(project.ownerEmail);
    const remaining = Math.max(0, totalLimit - used);
    hint += `(残り${formatWholeMB(remaining)})`;
  }
  modalAttachmentHintEl.textContent = hint;
}

function renderAttachments(attachments) {
  modalAttachmentsEl.innerHTML = "";
  const editable = activeCardRef ? canEditProject(findCard(activeCardRef.columnId, activeCardRef.cardId)?.project) : false;
  (attachments || []).forEach((att) => {
    const chip = buildAttachmentChip(
      att,
      editable
        ? () => {
            if (!activeCardRef) return;
            const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
            if (!found) return;
            found.card.attachments = (found.card.attachments || []).filter((a) => a.id !== att.id);
            saveProject(found.project);
            renderAttachments(found.card.attachments);
            if (att.path) {
              storage
                .ref()
                .child(att.path)
                .delete()
                .catch(() => {});
            }
          }
        : null
    );
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
  const attachProject = findCard(activeCardRef.columnId, activeCardRef.cardId)?.project;
  const attachLimit = maxFileSizeBytesForProject(attachProject);
  if (attachLimit !== Infinity && file.size > attachLimit) {
    alert(`ファイルサイズは${formatMaxSize(attachLimit)}までです。`);
    return;
  }
  if (blockedByTotalQuota(attachProject, file.size)) return;
  const targetColumnId = activeCardRef.columnId;
  const targetCardId = activeCardRef.cardId;

  setAttachmentUploading(true);
  try {
    const attachment = await uploadFile(file, `kanban/cards/${targetCardId}`);
    const found = findCard(targetColumnId, targetCardId);
    if (!found) return;
    found.card.attachments = found.card.attachments || [];
    found.card.attachments.push(attachment);
    saveProject(found.project);
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
  const commentProject = activeCardRef
    ? findCard(activeCardRef.columnId, activeCardRef.cardId)?.project
    : getActiveProject();
  const commentLimit = maxFileSizeBytesForProject(commentProject);
  if (commentLimit !== Infinity && file.size > commentLimit) {
    alert(`ファイルサイズは${formatMaxSize(commentLimit)}までです。`);
    return;
  }
  if (blockedByTotalQuota(commentProject, file.size)) return;
  pendingCommentFile = file;
  renderPendingFile();
});

function renderMembers(members) {
  modalMembersEl.innerHTML = "";
  const editable = activeCardRef ? canEditProject(findCard(activeCardRef.columnId, activeCardRef.cardId)?.project) : false;
  members.forEach((name, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = name;

    if (editable) {
      const rm = document.createElement("button");
      rm.textContent = "✕";
      rm.addEventListener("click", () => {
        const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
        if (!found) return;
        found.card.members.splice(idx, 1);
        saveProject(found.project);
        renderMembers(found.card.members);
      });
      chip.appendChild(rm);
    }

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
  saveProject(found.project);
});

modalStartDate.addEventListener("change", () => {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.startDate = modalStartDate.value || null;
  saveProject(found.project);
});

modalDueDate.addEventListener("change", () => {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.dueDate = modalDueDate.value || null;
  saveProject(found.project);
});

modalPriority.addEventListener("change", () => {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.priority = modalPriority.value || null;
  saveProject(found.project);
});

modalNotes.addEventListener("change", () => {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.notes = modalNotes.value;
  saveProject(found.project);
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
  saveProject(found.project);
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
    author:
      (userProfile && userProfile.displayName) || currentUser.displayName || currentUser.email || "匿名",
    text,
    createdAt: new Date().toISOString(),
  };
  if (attachment) comment.attachment = attachment;
  found.card.comments.push(comment);
  saveProject(found.project);
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
  renderCoverBanner(found.card.cover || null);
  renderCoverSwatches(found.card.cover || null);
  updateAttachmentHint();
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

// ---------- trash (per project) ----------
const trashModal = document.getElementById("trash-modal");
const trashCloseBtn = document.getElementById("trash-close-btn");
const trashListEl = document.getElementById("trash-list");
const trashEmptyBtn = document.getElementById("trash-empty-btn");
const trashCountBadge = document.getElementById("trash-count");

function moveCardToTrash(columnId, cardId) {
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;
  const column = project.columns.find((c) => c.id === columnId);
  if (!column) return;
  const idx = column.cards.findIndex((c) => c.id === cardId);
  if (idx === -1) return;
  const [removedCard] = column.cards.splice(idx, 1);
  project.trash = project.trash || [];
  project.trash.unshift({
    id: uid(),
    card: removedCard,
    fromColumnId: columnId,
    deletedAt: new Date().toISOString(),
  });
  if (activeCardRef && activeCardRef.cardId === cardId) closeCardModal();
  saveProject(project);
}

function restoreFromTrash(trashItemId) {
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;
  const trash = project.trash || [];
  const idx = trash.findIndex((t) => t.id === trashItemId);
  if (idx === -1) return;
  const [item] = trash.splice(idx, 1);
  const targetColumn = project.columns.find((c) => c.id === item.fromColumnId) || project.columns[0];
  if (targetColumn) targetColumn.cards.push(item.card);
  saveProject(project);
}

// Collects every Storage path referenced by a card (card attachments, cover
// image, and comment attachments) and deletes them from Firebase Storage.
// Called when a card is permanently removed from the trash so files don't
// linger as orphaned storage usage after the card itself is gone.
function deleteCardStorageFiles(card) {
  if (!card) return;
  const paths = [];

  (card.attachments || []).forEach((att) => {
    if (att && att.path) paths.push(att.path);
  });
  if (card.cover && card.cover.type === "image" && card.cover.path) {
    paths.push(card.cover.path);
  }
  (card.comments || []).forEach((c) => {
    if (c && c.attachment && c.attachment.path) paths.push(c.attachment.path);
  });

  paths.forEach((path) => {
    storage
      .ref()
      .child(path)
      .delete()
      .catch(() => {});
  });
}

function permanentlyDeleteTrashItem(trashItemId) {
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;
  const item = (project.trash || []).find((t) => t.id === trashItemId);
  if (item) deleteCardStorageFiles(item.card);
  project.trash = (project.trash || []).filter((t) => t.id !== trashItemId);
  saveProject(project);
}

function updateTrashBadge() {
  const project = getActiveProject();
  const count = project && project.trash ? project.trash.length : 0;
  if (count > 0) {
    trashCountBadge.textContent = count > 99 ? "99+" : String(count);
    trashCountBadge.classList.remove("hidden");
  } else {
    trashCountBadge.classList.add("hidden");
  }
}

function renderTrash() {
  const project = getActiveProject();
  const trash = (project && project.trash) || [];
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
    const col = project.columns.find((c) => c.id === item.fromColumnId);
    meta.textContent =
      (col ? col.title : "不明なリスト") + " ・ " + new Date(item.deletedAt).toLocaleString("ja-JP");

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
  const project = getActiveProject();
  const count = project && project.trash ? project.trash.length : 0;
  if (!count) return;
  openConfirmModal({
    title: "ゴミ箱を空にしますか？",
    message: `ゴミ箱内の${count}件のカードをすべて完全に削除します。この操作は元に戻せません。`,
    okLabel: "すべて完全に削除",
    onConfirm: () => {
      (project.trash || []).forEach((item) => deleteCardStorageFiles(item.card));
      project.trash = [];
      saveProject(project);
    },
  });
});
