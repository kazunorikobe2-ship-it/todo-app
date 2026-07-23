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
    customFieldValues: {},
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
    priorityOptions: null,
    customFields: [],
    syncedCalendarEventIds: [],
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
    maxTotalMB: 300,
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

function isImageAttachment(att) {
  return !!(att && att.type && att.type.startsWith("image/"));
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

// Minimal public collection (keyed by email, not uid) so that anyone can
// look up ANY project member's uploaded profile photo — even members they
// don't otherwise have permission to read the private `users/{uid}` doc for
// — without exposing plan/billing info. Each user can only write their own
// entry (see the userAvatars/{email} security rule).
const avatarsCollection = db.collection("userAvatars");

// email -> photoURL string | null (resolved) | Promise (lookup in flight).
// Memoizes lookups so re-rendering the same avatars repeatedly doesn't
// re-query Firestore every time.
const avatarPhotoCache = {};

function getAvatarPhotoURL(email) {
  if (!email) return Promise.resolve(null);
  if (currentUser && email === currentUser.email && userProfile && userProfile.photoURL) {
    return Promise.resolve(userProfile.photoURL);
  }
  const cached = avatarPhotoCache[email];
  if (cached !== undefined) return Promise.resolve(cached);

  const lookup = avatarsCollection
    .doc(email)
    .get()
    .then((snap) => {
      const url = (snap.exists && snap.data().photoURL) || null;
      avatarPhotoCache[email] = url;
      return url;
    })
    .catch(() => null);
  avatarPhotoCache[email] = lookup;
  return lookup;
}

function buildAvatar(email, sizeClass) {
  const el = document.createElement("div");
  el.className = "avatar-circle" + (sizeClass ? " " + sizeClass : "");
  el.style.background = avatarColorFor(email || "?");
  el.textContent = (email || "?").trim().charAt(0).toUpperCase();
  el.title = email || "";

  // The initials circle above renders immediately/synchronously; if this
  // member has uploaded (or signed in with) a profile photo, swap it in
  // once the (async) lookup resolves.
  getAvatarPhotoURL(email).then((url) => {
    if (!url) return;
    el.style.backgroundImage = `url(${url})`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.textContent = "";
  });

  return el;
}

// ---------- priority (重要度) options: per-project, user-editable ----------
// Historically this was a fixed 3-tier high/medium/low enum. It's now a
// per-project list of { id, label, color } that owners/editors can add to,
// remove from, and rename via the project settings modal. Projects that
// haven't customized it yet just fall back to this default list (and only
// get their own `priorityOptions` array written to Firestore the first time
// someone actually edits it — see ensurePriorityOptions).
const DEFAULT_PRIORITY_OPTIONS = [
  { id: "high", label: "高", color: "#eb5a46" },
  { id: "medium", label: "中", color: "#f2a94e" },
  { id: "low", label: "低", color: "#4bce97" },
];

function getPriorityOptions(project) {
  project = project || getActiveProject();
  if (project && Array.isArray(project.priorityOptions) && project.priorityOptions.length) {
    return project.priorityOptions;
  }
  return DEFAULT_PRIORITY_OPTIONS;
}

// Mutates `project` to give it its own real priorityOptions array (seeded
// from the defaults) if it doesn't have one yet — call this before adding /
// removing / renaming an option, since you can't persist a change into a
// shared constant array.
function ensurePriorityOptions(project) {
  if (!project.priorityOptions || !project.priorityOptions.length) {
    project.priorityOptions = DEFAULT_PRIORITY_OPTIONS.map((o) => ({ ...o }));
  }
  return project.priorityOptions;
}

function findPriorityOption(priorityId, project) {
  if (!priorityId) return null;
  return getPriorityOptions(project).find((o) => o.id === priorityId) || null;
}

function priorityLabel(priorityId, project) {
  const opt = findPriorityOption(priorityId, project);
  return opt ? opt.label : "";
}

function priorityColor(priorityId, project) {
  const opt = findPriorityOption(priorityId, project);
  return opt ? opt.color : "#8590a2";
}

// Rank used for sorting the table view: earlier entries in the options list
// are treated as more severe/important (matching the original high > medium
// > low > none ordering), so index 0 gets the highest rank.
function priorityRank(priorityId, project) {
  if (!priorityId) return 0;
  const options = getPriorityOptions(project);
  const idx = options.findIndex((o) => o.id === priorityId);
  return idx === -1 ? 0 : options.length - idx;
}

function hexToRgba(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return hex || "#8590a2";
  const num = parseInt(m[1], 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Applies a priority's color to a small badge element (light tint
// background + solid text color), used everywhere a priority badge is
// rendered (board cards, table rows) instead of the old fixed
// .priority-high/.priority-medium/.priority-low CSS classes, since colors
// are now arbitrary per-project data rather than 3 fixed values.
function applyPriorityBadgeStyle(el, priorityId, project) {
  const color = priorityColor(priorityId, project);
  el.style.background = hexToRgba(color, 0.18);
  el.style.color = color;
}

// ---------- custom field badges (board card front) ----------
// A palette deliberately disjoint (in hue) from the fixed badge colors used
// elsewhere on the card front (due date = blue, members = blue, comments =
// grey, actual-time = green, plus whatever hex colors a project's priority
// options happen to use) so a custom-field tag never blends in with those.
const CUSTOM_FIELD_BADGE_COLORS = [
  "#8e44ad", // purple
  "#12766b", // teal
  "#c2255c", // pink/magenta
  "#b8860b", // dark goldenrod
  "#3d5a80", // indigo/navy
  "#a0522d", // sienna/brown
  "#5f6caf", // slate blue
  "#6b8f00", // olive
];

// One consistent color per custom field (not per value) — hashed from the
// field's id so it stays stable across renders/reorders.
function customFieldBadgeColor(fieldId) {
  const str = fieldId || "?";
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return CUSTOM_FIELD_BADGE_COLORS[Math.abs(hash) % CUSTOM_FIELD_BADGE_COLORS.length];
}

function applyCustomFieldBadgeStyle(el, fieldId) {
  const color = customFieldBadgeColor(fieldId);
  el.style.background = hexToRgba(color, 0.18);
  el.style.color = color;
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
      priorityOptions: Array.isArray(data.priorityOptions) ? data.priorityOptions : null,
      customFields: Array.isArray(data.customFields) ? data.customFields : [],
      syncedCalendarEventIds: Array.isArray(data.syncedCalendarEventIds) ? data.syncedCalendarEventIds : [],
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
        priorityOptions: Array.isArray(data.priorityOptions) ? data.priorityOptions : null,
        customFields: Array.isArray(data.customFields) ? data.customFields : [],
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
  projectTitleInput.value = "Kanban Board";
  projectTitleInput.disabled = true;
}

function renderAll() {
  renderProjectList();
  updatePlanNote();
  updateDrawerPlanStatus();
  updateStorageAlert();
  const project = getActiveProject();
  projectTitleInput.value = project ? project.name : "Kanban Board";
  projectTitleInput.disabled = !project || !canEditProject(project);
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
  publicShareBtn.classList.toggle("hidden", !currentUser || !project || !isOwnerOfProject(project));
  projectSettingsBtn.classList.toggle("hidden", !currentUser || !project || !editable);
  calendarSyncBtn.classList.toggle("hidden", !currentUser || !project || !editable);
  renderMemberAvatars();

  if (currentView === "board") renderBoard();
  else if (currentView === "table") renderTableView();
  else if (currentView === "calendar") renderCalendarView();
  else if (currentView === "timeline") renderTimelineView();
  else if (currentView === "dashboard") renderDashboardView();

  // The comments drawer floats above whichever view is active above, so it
  // is refreshed independently rather than through the view dispatch.
  if (commentsDrawerOpen) renderCommentsView();
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

// ---------- Google Calendar sync (実績時間の反映) ----------
// Requesting an *additional* OAuth scope for an already-signed-in Firebase
// user via signInWithPopup(provider-with-extra-scope) turned out to be
// unreliable in practice (observed both "credential without accessToken" and
// "no credential at all" across repeated attempts, with no code change in
// between — a known flaky pattern with Firebase's incremental-auth-via-popup
// approach). Instead we get the Calendar access token directly through
// Google Identity Services (GIS, accounts.google.com/gsi/client), completely
// decoupled from Firebase Auth's own sign-in state. This is Google's
// recommended approach for grabbing extra API scopes that aren't needed for
// authentication itself, and it sidesteps the flakiness entirely.
const GOOGLE_OAUTH_CLIENT_ID = "210201939866-7ur89mumpagh4u4lt54lgci5eg8c8s2t.apps.googleusercontent.com";
const CALENDAR_READONLY_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

const calendarSyncBtn = document.getElementById("calendar-sync-btn");

let calendarAccessToken = null;
let calendarAccessTokenExpiresAt = 0;
let calendarTokenClient = null;

// How far back to look for completed calendar events on each sync. Wide
// enough that the user doesn't have to sync every single day, small enough
// to keep each Calendar API call cheap and fast.
const CALENDAR_SYNC_LOOKBACK_HOURS = 24 * 14;

function getCalendarTokenClient() {
  if (calendarTokenClient) return calendarTokenClient;
  if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
    throw new Error("Google連携の読み込みに失敗しました。ページを再読み込みしてから、もう一度お試しください。");
  }
  calendarTokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    scope: CALENDAR_READONLY_SCOPE,
    callback: () => {}, // overridden per-request in getCalendarAccessToken()
  });
  return calendarTokenClient;
}

async function getCalendarAccessToken() {
  const now = Date.now();
  if (calendarAccessToken && now < calendarAccessTokenExpiresAt) return calendarAccessToken;

  const tokenClient = getCalendarTokenClient();

  const accessToken = await new Promise((resolve, reject) => {
    tokenClient.callback = (tokenResponse) => {
      if (!tokenResponse || tokenResponse.error) {
        console.error("Googleカレンダーの認可に失敗しました:", tokenResponse);
        reject(
          new Error(
            "Googleカレンダーへのアクセス許可を取得できませんでした(再度お試しください)"
          )
        );
        return;
      }
      resolve(tokenResponse.access_token);
    };
    tokenClient.error_callback = (err) => {
      console.error("Googleカレンダーの認可でエラーが発生しました:", err);
      reject(
        new Error(
          "Googleカレンダーへのアクセス許可を取得できませんでした(再度お試しください)"
        )
      );
    };
    tokenClient.requestAccessToken({ prompt: "" });
  });

  if (!accessToken) {
    throw new Error("Googleカレンダーへのアクセス許可を取得できませんでした(再度お試しください)");
  }

  calendarAccessToken = accessToken;
  // Google's OAuth access tokens are typically valid ~1 hour; cache
  // conservatively for 50 minutes and just re-prompt after that rather than
  // risk using a stale token.
  calendarAccessTokenExpiresAt = now + 50 * 60 * 1000;
  return calendarAccessToken;
}

async function fetchRecentCalendarEvents(accessToken) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - CALENDAR_SYNC_LOOKBACK_HOURS * 60 * 60 * 1000);
  const params = new URLSearchParams({
    timeMin: windowStart.toISOString(),
    timeMax: now.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = (body.error && body.error.message) || `Googleカレンダーの取得に失敗しました(${res.status})`;
    throw new Error(message);
  }
  const data = await res.json();
  return data.items || [];
}

function minutesBetween(startIso, endIso) {
  const ms = new Date(endIso) - new Date(startIso);
  return Math.max(0, Math.round(ms / 60000));
}

function formatMinutesJP(totalMinutes) {
  const mins = Math.max(0, Math.round(totalMinutes || 0));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}時間${m}分`;
  if (h) return `${h}時間`;
  return `${m}分`;
}

// Pulls completed events (end time already in the past) from the signed-in
// user's primary Google Calendar and, for each one not already applied,
// looks for a card in the active project whose title exactly matches the
// event's title. Exactly one match → that duration gets added to the
// card's 実績 (actual time). No match, or more than one same-titled card →
// skipped (so an ambiguous title never silently attaches to the wrong
// card). Every processed event id is remembered on the project so re-
// syncing never double-counts it.
async function syncGoogleCalendar() {
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;

  calendarSyncBtn.disabled = true;
  const originalLabel = calendarSyncBtn.textContent;
  calendarSyncBtn.textContent = "同期中...";

  try {
    const accessToken = await getCalendarAccessToken();
    const events = await fetchRecentCalendarEvents(accessToken);

    project.syncedCalendarEventIds = project.syncedCalendarEventIds || [];
    const alreadySynced = new Set(project.syncedCalendarEventIds);
    const now = new Date();

    let appliedCount = 0;
    let ambiguousCount = 0;

    events.forEach((ev) => {
      if (!ev.id || alreadySynced.has(ev.id)) return;

      const start = ev.start && (ev.start.dateTime || ev.start.date);
      const end = ev.end && (ev.end.dateTime || ev.end.date);
      if (!start || !end) return;
      if (new Date(end) > now) return; // still ongoing / in the future — wait until it's actually over

      const title = (ev.summary || "").trim();
      if (!title) return;

      const matches = [];
      project.columns.forEach((column) => {
        column.cards.forEach((card) => {
          if ((card.text || "").trim() === title) matches.push(card);
        });
      });

      alreadySynced.add(ev.id);
      project.syncedCalendarEventIds.push(ev.id);

      if (matches.length === 1) {
        matches[0].actualMinutes = (matches[0].actualMinutes || 0) + minutesBetween(start, end);
        appliedCount++;
      } else if (matches.length > 1) {
        ambiguousCount++;
      }
    });

    if (appliedCount || ambiguousCount) {
      saveProject(project);
      syncModalIfOpen();
    }

    if (appliedCount) {
      let msg = `✅ ${appliedCount}件の予定を実績としてカードに反映しました。`;
      if (ambiguousCount) msg += ` (同名カードが複数あり${ambiguousCount}件はスキップしました)`;
      showBillingToast(msg);
    } else if (ambiguousCount) {
      showBillingToast(
        `⚠️ 同名のカードが複数あり、${ambiguousCount}件の予定はどのカードか特定できずスキップしました。`,
        true
      );
    } else {
      showBillingToast("反映できる新しい予定は見つかりませんでした。");
    }
  } catch (err) {
    console.error("calendar sync failed", err);
    showBillingToast("Googleカレンダーとの同期に失敗しました: " + err.message, true);
  } finally {
    calendarSyncBtn.disabled = false;
    calendarSyncBtn.textContent = originalLabel;
  }
}

calendarSyncBtn.addEventListener("click", syncGoogleCalendar);

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
    publicShareBtn.classList.add("hidden");
    projectSettingsBtn.classList.add("hidden");
    calendarSyncBtn.classList.add("hidden");
    drawerPlanStatusEl.classList.add("hidden");
    trashModal.classList.add("hidden");
    membersModal.classList.add("hidden");
    publicShareModal.classList.add("hidden");
    projectSettingsModal.classList.add("hidden");
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
const projectTitleInput = document.getElementById("project-title-input");
const projectListEl = document.getElementById("project-list");
const addProjectBtn = document.getElementById("add-project-btn");
const planNoteEl = document.getElementById("plan-note");
const planNoteLinkBtn = document.getElementById("plan-note-link");

// Renaming now happens here in the header (the currently active project),
// rather than inline in the drawer list — that made it too easy to
// accidentally rename a project while just clicking over to switch to it.
projectTitleInput.addEventListener("change", () => {
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;
  project.name = projectTitleInput.value.trim() || project.name;
  saveProject(project);
  projectTitleInput.value = project.name;
});

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

// ---------- drawer plan status (bottom of project list) ----------
const drawerPlanStatusEl = document.getElementById("drawer-plan-status");
const drawerPlanLabelEl = document.getElementById("drawer-plan-label");
const drawerPlanRemainingEl = document.getElementById("drawer-plan-remaining");
const drawerPlanChangeBtn = document.getElementById("drawer-plan-change-btn");

// Whole-days remaining until the given ISO date, compared at the
// calendar-day level (not a raw ms diff) so "today" never reads as -1.
function daysRemainingUntil(isoStr) {
  if (!isoStr) return null;
  const target = new Date(isoStr);
  if (isNaN(target.getTime())) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.round((startOfTarget - startOfToday) / (24 * 60 * 60 * 1000));
}

// Shows the signed-in user's current plan + remaining period at the very
// bottom of the project drawer, with a button that opens the plan
// comparison modal so upgrading/downgrading is reachable from anywhere.
function updateDrawerPlanStatus() {
  const shouldShow = !!currentUser && !isPublicShareMode;
  drawerPlanStatusEl.classList.toggle("hidden", !shouldShow);
  if (!shouldShow) return;

  const plan = effectivePlanForCurrentUser();
  drawerPlanLabelEl.textContent = `現在のプラン: ${planLimitsFor(plan).label}`;

  let remainingText = "";
  if (isAdminUser(currentUser)) {
    remainingText = "管理者・制限なし";
  } else if (userProfile && userProfile.planCancelAtPeriodEnd && userProfile.currentPeriodEnd) {
    const days = daysRemainingUntil(userProfile.currentPeriodEnd);
    remainingText =
      days !== null && days >= 0
        ? `あと${days}日でFreeへ変更(${formatDateJP(userProfile.currentPeriodEnd)})`
        : `${formatDateJP(userProfile.currentPeriodEnd)}にFreeへ変更`;
  } else if (plan !== "free" && userProfile && userProfile.currentPeriodEnd) {
    const days = daysRemainingUntil(userProfile.currentPeriodEnd);
    remainingText =
      days !== null && days >= 0
        ? `次回更新まであと${days}日(${formatDateJP(userProfile.currentPeriodEnd)})`
        : `次回更新日: ${formatDateJP(userProfile.currentPeriodEnd)}`;
  } else if (plan === "free") {
    remainingText = "期間の定めなし";
  }
  drawerPlanRemainingEl.textContent = remainingText;
}

drawerPlanChangeBtn.addEventListener("click", () => openPlansModal());

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
  const role = getRole(project);

  // Plain (non-editable) label — this used to be an <input> so the name
  // could be renamed inline, but that made it too easy to accidentally
  // rename a project while just trying to click over and switch to it.
  const nameLabel = document.createElement("span");
  nameLabel.className = "project-name-label";
  nameLabel.textContent = project.name;
  row.appendChild(nameLabel);

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
const publicShareBtn = document.getElementById("public-share-btn");
const publicShareModal = document.getElementById("public-share-modal");
const publicShareCloseBtn = document.getElementById("public-share-close-btn");
const publicShareToggleRow = document.getElementById("public-share-toggle-row");
const publicShareToggle = document.getElementById("public-share-toggle");
const publicShareUpgradeNote = document.getElementById("public-share-upgrade-note");
const publicShareUpgradeLink = document.getElementById("public-share-upgrade-link");
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

// Masks the 4 characters right after "@" in an email address (e.g.
// "kazunorikobe@yahoo.co.jp" -> "kazunorikobe@****o.co.jp"), so the members
// modal doesn't expose other people's full email addresses at a glance. The
// signed-in user's own row is always shown in full, since there's no privacy
// concern in a user seeing their own address.
function maskEmailForDisplay(email) {
  if (!email) return email;
  const atIdx = email.indexOf("@");
  if (atIdx === -1) return email;
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1);

  // Mask up to the last 5 characters of the local part (right before "@")...
  const localMaskLen = Math.min(5, local.length);
  const maskedLocal = local.slice(0, local.length - localMaskLen) + "*".repeat(localMaskLen);

  // ...and up to the first 4 characters of the domain (right after "@").
  const domainMaskLen = Math.min(4, domain.length);
  const maskedDomain = "*".repeat(domainMaskLen) + domain.slice(domainMaskLen);

  return maskedLocal + "@" + maskedDomain;
}

function memberRow(email, roleLabel, onRemove) {
  const row = document.createElement("div");
  row.className = "member-row";

  row.appendChild(buildAvatar(email, "small"));

  const isSelf = !!(currentUser && currentUser.email && email === currentUser.email);
  const label = document.createElement("span");
  label.textContent = isSelf ? email : maskEmailForDisplay(email);

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
}

// ---------- public share modal (header 🔗 icon, Business-plan only) ----------
// Free/Pro owners can still open this modal (so they can see what the
// feature is and how to unlock it), but the checkbox itself is disabled and
// greyed out for them rather than swapping in the plans-comparison modal.
function openPublicShareModal() {
  const project = getActiveProject();
  if (!project || !isOwnerOfProject(project)) return;
  renderPublicShareModal();
  publicShareModal.classList.remove("hidden");
}

function renderPublicShareModal() {
  const project = getActiveProject();
  if (!project) return;
  const isBusiness = effectivePlanForProject(project) === "business";

  publicShareToggle.checked = !!project.publicShareEnabled;
  publicShareToggle.disabled = !isBusiness;
  publicShareToggleRow.classList.toggle("disabled", !isBusiness);
  publicShareUpgradeNote.classList.toggle("hidden", isBusiness);
  publicShareLinkRow.classList.toggle("hidden", !project.publicShareEnabled);
  if (project.publicShareEnabled) {
    publicShareUrlInput.value = buildShareUrl(project.id);
  }
}

publicShareBtn.addEventListener("click", openPublicShareModal);
publicShareCloseBtn.addEventListener("click", () => publicShareModal.classList.add("hidden"));
publicShareModal.addEventListener("click", (e) => {
  if (e.target === publicShareModal) publicShareModal.classList.add("hidden");
});

publicShareUpgradeLink.addEventListener("click", () => {
  publicShareModal.classList.add("hidden");
  openPlansModal();
});

publicShareToggle.addEventListener("change", () => {
  const project = getActiveProject();
  if (!project || !isOwnerOfProject(project) || effectivePlanForProject(project) !== "business") {
    publicShareToggle.checked = false;
    return;
  }
  project.publicShareEnabled = publicShareToggle.checked;
  saveProject(project);
  renderPublicShareModal();
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

// ---------- project settings modal (⚙️ icon: priority options + custom fields) ----------
const projectSettingsBtn = document.getElementById("project-settings-btn");
const projectSettingsModal = document.getElementById("project-settings-modal");
const projectSettingsCloseBtn = document.getElementById("project-settings-close-btn");
const priorityOptionsListEl = document.getElementById("priority-options-list");
const addPriorityBtn = document.getElementById("add-priority-btn");
const customFieldsSettingsListEl = document.getElementById("custom-fields-settings-list");
const addCustomFieldBtn = document.getElementById("add-custom-field-btn");

function openProjectSettingsModal() {
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;
  renderProjectSettingsModal();
  projectSettingsModal.classList.remove("hidden");
}

function renderProjectSettingsModal() {
  const project = getActiveProject();
  if (!project) return;

  // ---- priority options ----
  priorityOptionsListEl.innerHTML = "";
  getPriorityOptions(project).forEach((opt) => {
    const row = document.createElement("div");
    row.className = "priority-option-row";

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "priority-color-input";
    colorInput.value = opt.color || "#8590a2";
    colorInput.addEventListener("change", () => {
      const options = ensurePriorityOptions(project);
      const target = options.find((o) => o.id === opt.id);
      if (target) target.color = colorInput.value;
      saveProject(project);
    });
    row.appendChild(colorInput);

    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "priority-label-input";
    labelInput.value = opt.label;
    labelInput.addEventListener("change", () => {
      const options = ensurePriorityOptions(project);
      const target = options.find((o) => o.id === opt.id);
      if (target) target.label = labelInput.value.trim() || target.label;
      saveProject(project);
      renderProjectSettingsModal();
    });
    row.appendChild(labelInput);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "priority-delete-btn";
    deleteBtn.title = "この重要度を削除";
    deleteBtn.textContent = "✕";
    deleteBtn.addEventListener("click", () => {
      const options = ensurePriorityOptions(project);
      project.priorityOptions = options.filter((o) => o.id !== opt.id);
      saveProject(project);
      renderProjectSettingsModal();
    });
    row.appendChild(deleteBtn);

    priorityOptionsListEl.appendChild(row);
  });

  // ---- custom fields ----
  customFieldsSettingsListEl.innerHTML = "";
  (project.customFields || []).forEach((field) => {
    const row = document.createElement("div");
    row.className = "custom-field-row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "custom-field-name-input";
    nameInput.placeholder = "項目名";
    nameInput.value = field.name;
    nameInput.addEventListener("change", () => {
      field.name = nameInput.value.trim() || field.name;
      saveProject(project);
    });
    row.appendChild(nameInput);

    const typeSelect = document.createElement("select");
    typeSelect.className = "custom-field-type-select";
    [
      { value: "text", label: "テキスト" },
      { value: "select", label: "プルダウン" },
    ].forEach(({ value, label }) => {
      const optionEl = document.createElement("option");
      optionEl.value = value;
      optionEl.textContent = label;
      typeSelect.appendChild(optionEl);
    });
    typeSelect.value = field.type === "select" ? "select" : "text";
    typeSelect.addEventListener("change", () => {
      field.type = typeSelect.value;
      if (field.type === "select" && !Array.isArray(field.options)) field.options = [];
      saveProject(project);
      renderProjectSettingsModal();
    });
    row.appendChild(typeSelect);

    if (field.type === "select") {
      const optionsInput = document.createElement("input");
      optionsInput.type = "text";
      optionsInput.className = "custom-field-options-input";
      optionsInput.placeholder = "選択肢をカンマ区切りで入力(例: 未着手,進行中,完了)";
      optionsInput.value = (field.options || []).join(",");
      optionsInput.addEventListener("change", () => {
        field.options = optionsInput.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        saveProject(project);
      });
      row.appendChild(optionsInput);
    }

    const showOnCardLabel = document.createElement("label");
    showOnCardLabel.className = "custom-field-show-on-card";
    const showOnCardCheckbox = document.createElement("input");
    showOnCardCheckbox.type = "checkbox";
    // Default to true for fields created before this option existed, so
    // existing behavior doesn't silently change for them.
    showOnCardCheckbox.checked = field.showOnCard !== false;
    showOnCardCheckbox.addEventListener("change", () => {
      field.showOnCard = showOnCardCheckbox.checked;
      saveProject(project);
    });
    showOnCardLabel.appendChild(showOnCardCheckbox);
    showOnCardLabel.appendChild(document.createTextNode("カードに表示"));
    row.appendChild(showOnCardLabel);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "custom-field-delete-btn";
    deleteBtn.title = "この管理項目を削除";
    deleteBtn.textContent = "✕";
    deleteBtn.addEventListener("click", () => {
      project.customFields = (project.customFields || []).filter((f) => f.id !== field.id);
      saveProject(project);
      renderProjectSettingsModal();
    });
    row.appendChild(deleteBtn);

    customFieldsSettingsListEl.appendChild(row);
  });
}

projectSettingsBtn.addEventListener("click", openProjectSettingsModal);
projectSettingsCloseBtn.addEventListener("click", () => projectSettingsModal.classList.add("hidden"));
projectSettingsModal.addEventListener("click", (e) => {
  if (e.target === projectSettingsModal) projectSettingsModal.classList.add("hidden");
});

addPriorityBtn.addEventListener("click", () => {
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;
  const options = ensurePriorityOptions(project);
  options.push({ id: uid(), label: "新しい重要度", color: "#8590a2" });
  saveProject(project);
  renderProjectSettingsModal();
});

addCustomFieldBtn.addEventListener("click", () => {
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;
  project.customFields = project.customFields || [];
  project.customFields.push({ id: uid(), name: "新しい項目", type: "text" });
  saveProject(project);
  renderProjectSettingsModal();
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
let lastSyncedAvatarPhotoURL; // avoids redundant writes every time the profile snapshot fires

// Keeps the public userAvatars/{email} lookup doc in sync with whatever
// photoURL is on this user's (private) profile — whether that came from a
// Google-account photo at signup or a manually-uploaded/cropped one — so
// other project members can resolve this user's avatar image (see
// getAvatarPhotoURL / buildAvatar).
function syncOwnAvatarPhoto() {
  if (!currentUser || !currentUser.email || !userProfile) return;
  const url = userProfile.photoURL || null;
  if (url === lastSyncedAvatarPhotoURL) return;
  lastSyncedAvatarPhotoURL = url;
  avatarsCollection
    .doc(currentUser.email)
    .set({ photoURL: url }, { merge: true })
    .catch((err) => console.error("failed to sync avatar photo", err));
}

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
      syncOwnAvatarPhoto();
      updateUserInfoDisplay();
      updatePlanNote();
      updateDrawerPlanStatus();
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

// ---------- profile avatar upload + crop ----------
const AVATAR_MAX_FILE_SIZE = 1 * 1024 * 1024; // 1MB
const AVATAR_CROP_STAGE_SIZE = 240; // px, matches .avatar-crop-stage in CSS
const AVATAR_OUTPUT_SIZE = 400; // px, final square photo rendered to canvas

const profileAvatarUploadBtn = document.getElementById("profile-avatar-upload-btn");
const profileAvatarFileInput = document.getElementById("profile-avatar-file-input");
const avatarCropModal = document.getElementById("avatar-crop-modal");
const avatarCropCloseBtn = document.getElementById("avatar-crop-close-btn");
const avatarCropStage = document.getElementById("avatar-crop-stage");
const avatarCropImg = document.getElementById("avatar-crop-img");
const avatarCropZoom = document.getElementById("avatar-crop-zoom");
const avatarCropCancelBtn = document.getElementById("avatar-crop-cancel-btn");
const avatarCropConfirmBtn = document.getElementById("avatar-crop-confirm-btn");

// Pan/zoom state for the crop tool. baseScale is whatever scale makes the
// image just barely cover the (square) crop stage; the zoom slider applies
// an additional multiplier on top of that, and offsetX/offsetY are drag
// offsets (in on-screen px at the current scale) from dead-center.
const avatarCrop = {
  naturalWidth: 0,
  naturalHeight: 0,
  baseScale: 1,
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  startOffsetX: 0,
  startOffsetY: 0,
};

function avatarCropDisplayScale() {
  return avatarCrop.baseScale * (Number(avatarCropZoom.value) / 100);
}

function clampAvatarCropOffsets() {
  const scale = avatarCropDisplayScale();
  const displayWidth = avatarCrop.naturalWidth * scale;
  const displayHeight = avatarCrop.naturalHeight * scale;
  const maxX = Math.max(0, (displayWidth - AVATAR_CROP_STAGE_SIZE) / 2);
  const maxY = Math.max(0, (displayHeight - AVATAR_CROP_STAGE_SIZE) / 2);
  avatarCrop.offsetX = Math.min(maxX, Math.max(-maxX, avatarCrop.offsetX));
  avatarCrop.offsetY = Math.min(maxY, Math.max(-maxY, avatarCrop.offsetY));
}

function renderAvatarCropTransform() {
  clampAvatarCropOffsets();
  const scale = avatarCropDisplayScale();
  const displayWidth = avatarCrop.naturalWidth * scale;
  const displayHeight = avatarCrop.naturalHeight * scale;
  avatarCropImg.style.width = displayWidth + "px";
  avatarCropImg.style.height = displayHeight + "px";
  avatarCropImg.style.transform = `translate(-50%, -50%) translate(${avatarCrop.offsetX}px, ${avatarCrop.offsetY}px)`;
}

function openAvatarCropModal(dataUrl) {
  avatarCropImg.onload = () => {
    avatarCrop.naturalWidth = avatarCropImg.naturalWidth;
    avatarCrop.naturalHeight = avatarCropImg.naturalHeight;
    avatarCrop.baseScale = Math.max(
      AVATAR_CROP_STAGE_SIZE / avatarCrop.naturalWidth,
      AVATAR_CROP_STAGE_SIZE / avatarCrop.naturalHeight
    );
    avatarCrop.offsetX = 0;
    avatarCrop.offsetY = 0;
    avatarCropZoom.value = 100;
    renderAvatarCropTransform();
  };
  avatarCropImg.src = dataUrl;
  avatarCropModal.classList.remove("hidden");
}

function closeAvatarCropModal() {
  avatarCropModal.classList.add("hidden");
  avatarCropImg.src = "";
  profileAvatarFileInput.value = "";
}

profileAvatarUploadBtn.addEventListener("click", () => profileAvatarFileInput.click());

profileAvatarFileInput.addEventListener("change", () => {
  const file = profileAvatarFileInput.files && profileAvatarFileInput.files[0];
  if (!file) return;
  if (!file.type || !file.type.startsWith("image/")) {
    alert("画像ファイルを選択してください。");
    profileAvatarFileInput.value = "";
    return;
  }
  if (file.size > AVATAR_MAX_FILE_SIZE) {
    alert("画像は1MBまでのファイルを選択してください。");
    profileAvatarFileInput.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => openAvatarCropModal(reader.result);
  reader.readAsDataURL(file);
});

avatarCropCloseBtn.addEventListener("click", closeAvatarCropModal);
avatarCropCancelBtn.addEventListener("click", closeAvatarCropModal);
avatarCropModal.addEventListener("click", (e) => {
  if (e.target === avatarCropModal) closeAvatarCropModal();
});

avatarCropZoom.addEventListener("input", renderAvatarCropTransform);

function avatarCropPointerDown(clientX, clientY) {
  avatarCrop.dragging = true;
  avatarCrop.dragStartX = clientX;
  avatarCrop.dragStartY = clientY;
  avatarCrop.startOffsetX = avatarCrop.offsetX;
  avatarCrop.startOffsetY = avatarCrop.offsetY;
}
function avatarCropPointerMove(clientX, clientY) {
  if (!avatarCrop.dragging) return;
  avatarCrop.offsetX = avatarCrop.startOffsetX + (clientX - avatarCrop.dragStartX);
  avatarCrop.offsetY = avatarCrop.startOffsetY + (clientY - avatarCrop.dragStartY);
  renderAvatarCropTransform();
}
function avatarCropPointerUp() {
  avatarCrop.dragging = false;
}

avatarCropStage.addEventListener("mousedown", (e) => {
  e.preventDefault();
  avatarCropPointerDown(e.clientX, e.clientY);
});
window.addEventListener("mousemove", (e) => avatarCropPointerMove(e.clientX, e.clientY));
window.addEventListener("mouseup", avatarCropPointerUp);

avatarCropStage.addEventListener(
  "touchstart",
  (e) => {
    const t = e.touches[0];
    if (t) avatarCropPointerDown(t.clientX, t.clientY);
  },
  { passive: true }
);
window.addEventListener(
  "touchmove",
  (e) => {
    const t = e.touches[0];
    if (t) avatarCropPointerMove(t.clientX, t.clientY);
  },
  { passive: true }
);
window.addEventListener("touchend", avatarCropPointerUp);

avatarCropConfirmBtn.addEventListener("click", async () => {
  if (!currentUser) return;
  avatarCropConfirmBtn.disabled = true;
  const originalLabel = avatarCropConfirmBtn.textContent;
  avatarCropConfirmBtn.textContent = "アップロード中...";
  try {
    const scale = avatarCropDisplayScale();
    const displayWidth = avatarCrop.naturalWidth * scale;
    const displayHeight = avatarCrop.naturalHeight * scale;
    const imgLeft = AVATAR_CROP_STAGE_SIZE / 2 - displayWidth / 2 + avatarCrop.offsetX;
    const imgTop = AVATAR_CROP_STAGE_SIZE / 2 - displayHeight / 2 + avatarCrop.offsetY;
    const srcX = -imgLeft / scale;
    const srcY = -imgTop / scale;
    const srcSize = AVATAR_CROP_STAGE_SIZE / scale;

    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_OUTPUT_SIZE;
    canvas.height = AVATAR_OUTPUT_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(avatarCropImg, srcX, srcY, srcSize, srcSize, 0, 0, AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("画像の生成に失敗しました。");
    // uploadFile() expects a File-like object with a .name; a bare Blob from
    // canvas.toBlob() doesn't have one, so wrap it.
    const avatarFile = new File([blob], "avatar.jpg", { type: "image/jpeg" });

    const attachment = await uploadFile(avatarFile, `kanban/avatars/${currentUser.uid}`);
    await usersCollection.doc(currentUser.uid).set({ photoURL: attachment.url }, { merge: true });

    userProfile = userProfile || {};
    userProfile.photoURL = attachment.url;
    profileAvatarEl.textContent = "";
    profileAvatarEl.style.backgroundImage = `url(${attachment.url})`;
    updateUserInfoDisplay();

    closeAvatarCropModal();
  } catch (err) {
    console.error("failed to upload avatar", err);
    alert("画像のアップロードに失敗しました。もう一度お試しください。");
  } finally {
    avatarCropConfirmBtn.disabled = false;
    avatarCropConfirmBtn.textContent = originalLabel;
  }
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
    // The "コメント" tab no longer switches the main view — it toggles the
    // comments drawer instead (see below), and is available on every plan,
    // so it's excluded from the plan-gating / active-view logic here.
    if (tab.dataset.view === "comments") {
      tab.classList.remove("locked");
      tab.classList.toggle("active", commentsDrawerOpen);
      return;
    }
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
    if (tab.dataset.view === "comments") {
      toggleCommentsDrawer();
      return;
    }
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

// Tracks the card(s) currently being dragged so dragover/drop handlers know
// what's moving without relying on dataTransfer.getData() (unreliable to
// read during dragover in some browsers). Cleared on dragend. `cardIds` is
// always an array — length 1 for an ordinary single-card drag, length 2+
// when dragging a multi-card range selection (see selectedCardIds below).
let draggingCardInfo = null;

// ---------- multi-card range selection (shift/ctrl+click) ----------
// Lets the user select several cards within one list (shift+click extends a
// range from the last anchor, ctrl/cmd+click toggles individual cards) and
// then drag them all together in one go. Selection is local UI state only
// (never persisted), and is scoped to a single column at a time since a
// "range" only makes sense within one ordered list.
let selectedCardIds = new Set();
let selectionColumnId = null;
let selectionAnchorId = null;

function clearCardSelection(rerender) {
  if (!selectedCardIds.size) return;
  selectedCardIds = new Set();
  selectionColumnId = null;
  selectionAnchorId = null;
  if (rerender) renderBoard();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") clearCardSelection(true);
});

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

// ---------- column (list) reordering via drag handle ----------
// Cards live nested inside each column object, so reordering `project.columns`
// naturally carries a list's cards along with it — nothing extra needed there.
let draggingColumnInfo = null;

function getColumnDragAfterElement(container, x) {
  const els = [...container.querySelectorAll(".column:not(.dragging-column)")];
  return els.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = x - box.left - box.width / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function ensureColumnDropPlaceholder(width) {
  let placeholder = document.querySelector(".column-drop-placeholder");
  if (!placeholder) {
    placeholder = document.createElement("div");
    placeholder.className = "column-drop-placeholder";
  }
  placeholder.style.width = (width || 260) + "px";
  return placeholder;
}

function clearColumnDragVisuals() {
  document.querySelectorAll(".column-drop-placeholder").forEach((el) => el.remove());
}

// Attached once to the persistent #board element (rather than inside
// renderBoard(), which would otherwise stack up duplicate listeners on every
// re-render since board.innerHTML="" only clears its children, not board
// itself). Always reads the live project/columns at drop-time instead of
// closing over a stale reference.
board.addEventListener("dragover", (e) => {
  if (!draggingColumnInfo) return;
  e.preventDefault();
  const placeholder = ensureColumnDropPlaceholder(draggingColumnInfo.width);
  const afterElement = getColumnDragAfterElement(board, e.clientX);
  if (afterElement == null) {
    board.appendChild(placeholder);
  } else {
    board.insertBefore(placeholder, afterElement);
  }
});

board.addEventListener("dragleave", (e) => {
  if (!draggingColumnInfo) return;
  if (board.contains(e.relatedTarget)) return;
  clearColumnDragVisuals();
});

board.addEventListener("drop", (e) => {
  if (!draggingColumnInfo) return;
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;
  e.preventDefault();
  const afterElement = getColumnDragAfterElement(board, e.clientX);
  clearColumnDragVisuals();

  const { columnId } = draggingColumnInfo;
  const fromIndex = project.columns.findIndex((c) => c.id === columnId);
  if (fromIndex === -1) return;
  const [movedColumn] = project.columns.splice(fromIndex, 1);

  let insertIndex = project.columns.length;
  if (afterElement) {
    const idx = project.columns.findIndex((c) => c.id === afterElement.dataset.columnId);
    if (idx !== -1) insertIndex = idx;
  }
  project.columns.splice(insertIndex, 0, movedColumn);
  saveProject(project);
});

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

    if (editable) {
      const dragHandle = document.createElement("span");
      dragHandle.className = "column-drag-handle";
      dragHandle.textContent = "⠿";
      dragHandle.title = "ドラッグしてリストを並び替え";
      dragHandle.draggable = true;
      dragHandle.addEventListener("dragstart", (e) => {
        e.stopPropagation();
        columnEl.classList.add("dragging-column");
        draggingColumnInfo = { columnId: column.id, width: columnEl.offsetWidth };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", JSON.stringify({ columnId: column.id }));
        try {
          e.dataTransfer.setDragImage(columnEl, 20, 20);
        } catch (err) {
          // setDragImage can throw in some older browsers; the default drag
          // image (just the handle) still works fine without it.
        }
      });
      dragHandle.addEventListener("dragend", () => {
        columnEl.classList.remove("dragging-column");
        draggingColumnInfo = null;
        clearColumnDragVisuals();
      });
      header.appendChild(dragHandle);
    }

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
        const cardCount = column.cards.length;
        openConfirmModal({
          title: `「${column.title}」を削除しますか？`,
          message: cardCount
            ? `このリストに含まれる${cardCount}件のカードも同時にゴミ箱へ移動します。ゴミ箱からいつでも復元できます。`
            : "このリストを削除します。",
          okLabel: "削除する",
          onConfirm: () => deleteColumnAndTrashCards(project, column.id),
        });
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

      if (selectionColumnId === column.id && selectedCardIds.has(card.id)) {
        cardEl.classList.add("selected");
      }

      cardEl.addEventListener("dragstart", (e) => {
        const isMultiDrag = selectionColumnId === column.id && selectedCardIds.size > 1 && selectedCardIds.has(card.id);

        if (!isMultiDrag) {
          // Starting a drag on a card outside the current selection (or with
          // no multi-selection active) just drags that one card, same as
          // before — dropping any stale selection so it doesn't linger.
          clearCardSelection(false);
        }

        const orderedIds = isMultiDrag
          ? column.cards.map((c) => c.id).filter((id) => selectedCardIds.has(id))
          : [card.id];

        let totalHeight = 0;
        orderedIds.forEach((id) => {
          const el = cardList.querySelector(`.card[data-card-id="${id}"]`);
          if (el) {
            el.classList.add("dragging");
            totalHeight += el.offsetHeight;
          }
        });

        draggingCardInfo = { cardIds: orderedIds, fromColumnId: column.id, height: totalHeight };
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", JSON.stringify({ cardIds: orderedIds, fromColumnId: column.id }));
      });
      cardEl.addEventListener("dragend", () => {
        document.querySelectorAll(".card.dragging").forEach((el) => el.classList.remove("dragging"));
        draggingCardInfo = null;
        clearDragVisuals();
        clearCardSelection(true);
      });
      cardEl.addEventListener("click", (e) => {
        if (!editable) {
          openCardModal(column.id, card.id);
          return;
        }
        if (e.shiftKey) {
          e.preventDefault();
          if (selectionColumnId !== column.id || !selectionAnchorId) {
            // No existing anchor in this column — start a fresh single-card
            // selection anchored on the card just clicked.
            selectionColumnId = column.id;
            selectionAnchorId = card.id;
            selectedCardIds = new Set([card.id]);
          } else {
            const ids = column.cards.map((c) => c.id);
            const anchorIdx = ids.indexOf(selectionAnchorId);
            const clickIdx = ids.indexOf(card.id);
            if (anchorIdx !== -1 && clickIdx !== -1) {
              const [start, end] = anchorIdx < clickIdx ? [anchorIdx, clickIdx] : [clickIdx, anchorIdx];
              selectedCardIds = new Set(ids.slice(start, end + 1));
            }
          }
          renderBoard();
          return;
        }
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (selectionColumnId !== column.id) {
            selectedCardIds = new Set();
            selectionColumnId = column.id;
          }
          if (selectedCardIds.has(card.id)) {
            selectedCardIds.delete(card.id);
          } else {
            selectedCardIds.add(card.id);
          }
          selectionAnchorId = card.id;
          if (!selectedCardIds.size) selectionColumnId = null;
          renderBoard();
          return;
        }
        // Plain click: clear any lingering multi-selection and open the
        // card as usual.
        clearCardSelection(false);
        openCardModal(column.id, card.id);
      });

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
        b.className = "badge";
        applyPriorityBadgeStyle(b, card.priority, project);
        b.textContent = priorityLabel(card.priority, project);
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
      if (card.actualMinutes) {
        const b = document.createElement("span");
        b.className = "badge actual-time-badge";
        b.textContent = "⏱ " + formatMinutesJP(card.actualMinutes);
        badges.appendChild(b);
      }
      (project.customFields || []).forEach((field) => {
        if (field.showOnCard === false) return;
        const value = card.customFieldValues && card.customFieldValues[field.id];
        if (!value) return;
        const b = document.createElement("span");
        b.className = "badge custom-field-badge";
        applyCustomFieldBadgeStyle(b, field.id);
        b.textContent = value;
        b.title = `${field.name}: ${value}`;
        badges.appendChild(b);
      });
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

      const { cardIds, fromColumnId } = draggingCardInfo;
      const fromColumn = project.columns.find((c) => c.id === fromColumnId);
      if (!fromColumn) return;

      // Pull every dragged card out of the source list together (cardIds is
      // already in original relative order — see dragstart above), then drop
      // them back in as one contiguous block at the target position. For an
      // ordinary single-card drag this is exactly the old splice-one behavior.
      const movedCards = [];
      cardIds.forEach((id) => {
        const idx = fromColumn.cards.findIndex((c) => c.id === id);
        if (idx !== -1) movedCards.push(...fromColumn.cards.splice(idx, 1));
      });
      if (!movedCards.length) return;

      let insertIndex = column.cards.length;
      if (afterElement) {
        const idx = column.cards.findIndex((c) => c.id === afterElement.dataset.cardId);
        if (idx !== -1) insertIndex = idx;
      }
      column.cards.splice(insertIndex, 0, ...movedCards);
      saveProject(project);
    });

    board.appendChild(columnEl);
  });
}

// ---------- table view ----------
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
      return priorityRank(row.card.priority);
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
      b.className = "badge";
      applyPriorityBadgeStyle(b, card.priority, project);
      b.textContent = priorityLabel(card.priority, project);
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
          if (card.priority) chip.style.background = priorityColor(card.priority, project);
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
      if (ev.card.priority) bar.style.background = priorityColor(ev.card.priority, project);
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
// Width (px) of a single day column in the Gantt-style timeline grid. Fixed
// per-day sizing (rather than the old percentage-of-range positioning) is
// what lets the grid be drawn with crisp, exactly-aligned ruled lines.
const GANTT_DAY_WIDTH = 32;

function gttStartOfDay(d) {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function gttDayIndex(dateStr, minDate) {
  const d = gttStartOfDay(new Date(dateStr));
  return Math.round((d - minDate) / 86400000);
}

function gttFormatMonthLabel(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

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
  const today = gttStartOfDay(new Date());
  const rawMin = gttStartOfDay(new Date(allDates.reduce((a, b) => (a < b ? a : b))));
  const rawMax = gttStartOfDay(new Date(allDates.reduce((a, b) => (a > b ? a : b))));
  // Pad a few days on either side, and always make sure "today" falls
  // somewhere within the visible range so the today-marker is reachable.
  const minDate = new Date(Math.min(rawMin.getTime(), today.getTime()));
  minDate.setDate(minDate.getDate() - 2);
  const maxDate = new Date(Math.max(rawMax.getTime(), today.getTime()));
  maxDate.setDate(maxDate.getDate() + 2);
  const totalDays = Math.round((maxDate - minDate) / 86400000) + 1;
  const todayIndex = gttDayIndex(today, minDate);

  // ---- toolbar ----
  const toolbar = document.createElement("div");
  toolbar.className = "gantt-toolbar";
  const todayBtn = document.createElement("button");
  todayBtn.type = "button";
  todayBtn.className = "gantt-today-btn";
  todayBtn.textContent = "📍 今日";
  toolbar.appendChild(todayBtn);
  panel.appendChild(toolbar);

  // ---- scroll wrapper (sticky label column lives inside this) ----
  const scrollWrap = document.createElement("div");
  scrollWrap.className = "gantt-scroll";

  const grid = document.createElement("div");
  grid.className = "gantt-grid";
  grid.style.width = 220 + totalDays * GANTT_DAY_WIDTH + "px";

  // ---- header: sticky label header + month row + day-number row ----
  const header = document.createElement("div");
  header.className = "gantt-header";

  const labelHeader = document.createElement("div");
  labelHeader.className = "gantt-col-label gantt-sticky";
  const titleHead = document.createElement("div");
  titleHead.className = "gantt-col-label-title";
  titleHead.textContent = "件名";
  const assigneeHead = document.createElement("div");
  assigneeHead.className = "gantt-col-label-assignee";
  assigneeHead.textContent = "担当者";
  labelHeader.appendChild(titleHead);
  labelHeader.appendChild(assigneeHead);
  header.appendChild(labelHeader);

  const daysHeader = document.createElement("div");
  daysHeader.className = "gantt-col-days";
  daysHeader.style.width = totalDays * GANTT_DAY_WIDTH + "px";

  const monthRow = document.createElement("div");
  monthRow.className = "gantt-month-row";
  let monthCursor = 0;
  while (monthCursor < totalDays) {
    const cursorDate = new Date(minDate);
    cursorDate.setDate(cursorDate.getDate() + monthCursor);
    const y = cursorDate.getFullYear();
    const m = cursorDate.getMonth();
    let span = 0;
    while (monthCursor + span < totalDays) {
      const d = new Date(minDate);
      d.setDate(d.getDate() + monthCursor + span);
      if (d.getFullYear() !== y || d.getMonth() !== m) break;
      span++;
    }
    const seg = document.createElement("div");
    seg.className = "gantt-month-seg";
    seg.style.width = span * GANTT_DAY_WIDTH + "px";
    seg.textContent = gttFormatMonthLabel(cursorDate);
    monthRow.appendChild(seg);
    monthCursor += span;
  }
  daysHeader.appendChild(monthRow);

  const dayRow = document.createElement("div");
  dayRow.className = "gantt-day-row";
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(minDate);
    d.setDate(d.getDate() + i);
    const cell = document.createElement("div");
    const dow = d.getDay();
    cell.className =
      "gantt-day-cell" +
      (dow === 0 ? " gantt-day-sun" : dow === 6 ? " gantt-day-sat" : "") +
      (i === todayIndex ? " gantt-day-today" : "");
    cell.style.width = GANTT_DAY_WIDTH + "px";
    cell.textContent = String(d.getDate());
    dayRow.appendChild(cell);
  }
  daysHeader.appendChild(dayRow);
  header.appendChild(daysHeader);
  grid.appendChild(header);

  // ---- body rows ----
  const body = document.createElement("div");
  body.className = "gantt-body";

  items.forEach(({ card, column }) => {
    const row = document.createElement("div");
    row.className = "gantt-row";

    const labelCell = document.createElement("div");
    labelCell.className = "gantt-col-label gantt-sticky";
    const titleEl = document.createElement("div");
    titleEl.className = "gantt-row-title";
    titleEl.textContent = card.text;
    titleEl.title = column.title;
    const assigneeEl = document.createElement("div");
    assigneeEl.className = "gantt-row-assignee";
    if (card.members && card.members.length) {
      card.members.slice(0, 3).forEach((email) => {
        assigneeEl.appendChild(buildAvatar(email, "tiny"));
      });
      if (card.members.length > 3) {
        const more = document.createElement("span");
        more.className = "gantt-assignee-more";
        more.textContent = "+" + (card.members.length - 3);
        assigneeEl.appendChild(more);
      }
    } else {
      assigneeEl.textContent = "-";
    }
    labelCell.appendChild(titleEl);
    labelCell.appendChild(assigneeEl);
    row.appendChild(labelCell);

    const track = document.createElement("div");
    track.className = "gantt-col-days gantt-track";
    track.style.width = totalDays * GANTT_DAY_WIDTH + "px";

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(minDate);
      d.setDate(d.getDate() + i);
      const dow = d.getDay();
      const bg = document.createElement("div");
      bg.className =
        "gantt-day-cell-bg" +
        (dow === 0 ? " gantt-day-sun" : dow === 6 ? " gantt-day-sat" : "") +
        (i === todayIndex ? " gantt-day-today" : "");
      bg.style.width = GANTT_DAY_WIDTH + "px";
      track.appendChild(bg);
    }

    const startStr = card.startDate || card.dueDate;
    const endStr = card.dueDate || card.startDate;
    const startIdx = gttDayIndex(startStr, minDate);
    const endIdx = Math.max(gttDayIndex(endStr, minDate), startIdx);
    const bar = document.createElement("div");
    bar.className = "gantt-bar";
    if (card.priority) bar.style.background = priorityColor(card.priority, project);
    bar.style.left = startIdx * GANTT_DAY_WIDTH + 2 + "px";
    bar.style.width = (endIdx - startIdx + 1) * GANTT_DAY_WIDTH - 4 + "px";
    bar.title = `${startStr} 〜 ${endStr}`;
    bar.addEventListener("click", () => openCardModal(column.id, card.id));
    const barLabel = document.createElement("span");
    barLabel.className = "gantt-bar-label";
    barLabel.textContent = card.text;
    bar.appendChild(barLabel);

    track.appendChild(bar);
    row.appendChild(track);
    body.appendChild(row);
  });

  grid.appendChild(body);
  scrollWrap.appendChild(grid);
  panel.appendChild(scrollWrap);

  todayBtn.addEventListener("click", () => {
    scrollWrap.scrollLeft = Math.max(0, todayIndex * GANTT_DAY_WIDTH - scrollWrap.clientWidth / 2);
  });
  // Land on "today" by default rather than the far-left edge.
  scrollWrap.scrollLeft = Math.max(0, todayIndex * GANTT_DAY_WIDTH - scrollWrap.clientWidth / 2);
}

// ---------- comments drawer (all cards' comments, newest first, paginated) ----------
// A Notion-style side peek panel: available on every plan (unlike
// calendar/timeline/dashboard — see PLAN_LIMITS above), and slides in from
// the right WITHOUT switching away from whatever view (board/table/etc.)
// is currently showing.
let commentsViewPage = 1;
const COMMENTS_VIEW_PAGE_SIZE = 10;
let commentsDrawerOpen = false;
const commentsDrawerEl = document.getElementById("comments-drawer");
const commentsDrawerBackdrop = document.getElementById("comments-drawer-backdrop");
const commentsDrawerCloseBtn = document.getElementById("comments-drawer-close-btn");

function openCommentsDrawer() {
  commentsDrawerOpen = true;
  commentsViewPage = 1;
  commentsDrawerEl.classList.add("open");
  commentsDrawerBackdrop.classList.add("open");
  // Let the tab reflect the open state, then paint the drawer's contents.
  viewTabButtons.forEach((tab) => {
    if (tab.dataset.view === "comments") tab.classList.add("active");
  });
  renderCommentsView();
}

function closeCommentsDrawer() {
  commentsDrawerOpen = false;
  commentsDrawerEl.classList.remove("open");
  commentsDrawerBackdrop.classList.remove("open");
  viewTabButtons.forEach((tab) => {
    if (tab.dataset.view === "comments") tab.classList.remove("active");
  });
}

function toggleCommentsDrawer() {
  if (commentsDrawerOpen) closeCommentsDrawer();
  else openCommentsDrawer();
}

commentsDrawerCloseBtn.addEventListener("click", closeCommentsDrawer);
commentsDrawerBackdrop.addEventListener("click", closeCommentsDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && commentsDrawerOpen) closeCommentsDrawer();
});

function renderCommentsView() {
  const project = getActiveProject();
  const panel = document.getElementById("comments-view");
  panel.innerHTML = "";
  if (!project) return;

  const items = [];
  project.columns.forEach((column) => {
    column.cards.forEach((card) => {
      (card.comments || []).forEach((comment) => {
        items.push({ comment, card, column });
      });
    });
  });

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "table-empty";
    empty.textContent = "コメントがまだありません";
    panel.appendChild(empty);
    return;
  }

  // Newest first.
  items.sort((a, b) => (a.comment.createdAt < b.comment.createdAt ? 1 : a.comment.createdAt > b.comment.createdAt ? -1 : 0));

  const totalPages = Math.max(1, Math.ceil(items.length / COMMENTS_VIEW_PAGE_SIZE));
  commentsViewPage = Math.min(Math.max(commentsViewPage, 1), totalPages);

  const startIdx = (commentsViewPage - 1) * COMMENTS_VIEW_PAGE_SIZE;
  const pageItems = items.slice(startIdx, startIdx + COMMENTS_VIEW_PAGE_SIZE);

  const list = document.createElement("div");
  list.className = "comments-view-list";

  pageItems.forEach(({ comment, card, column }) => {
    const row = document.createElement("div");
    row.className = "comments-view-row";

    const meta = document.createElement("div");
    meta.className = "comments-view-meta";

    // Clicking the CARD TITLE (not the comment) opens that card's modal —
    // the comment itself is plain, non-interactive text.
    const cardLink = document.createElement("button");
    cardLink.type = "button";
    cardLink.className = "comments-view-card-link";
    cardLink.textContent = card.text;
    cardLink.title = column.title;
    cardLink.addEventListener("click", () => openCardModal(column.id, card.id));
    meta.appendChild(cardLink);

    const dateEl = document.createElement("span");
    dateEl.className = "comments-view-date";
    const date = new Date(comment.createdAt);
    dateEl.textContent = `${comment.author || "匿名"} ・ ${date.toLocaleString("ja-JP")}`;
    meta.appendChild(dateEl);

    row.appendChild(meta);

    const textEl = document.createElement("div");
    textEl.className = "comments-view-text";
    textEl.textContent = comment.text;
    row.appendChild(textEl);

    list.appendChild(row);
  });

  panel.appendChild(list);

  if (totalPages > 1) {
    const pager = document.createElement("div");
    pager.className = "comments-view-pager";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "link-btn small";
    prevBtn.textContent = "← 前へ";
    prevBtn.disabled = commentsViewPage <= 1;
    prevBtn.addEventListener("click", () => {
      commentsViewPage--;
      renderCommentsView();
    });
    pager.appendChild(prevBtn);

    const pageLabel = document.createElement("span");
    pageLabel.className = "comments-view-page-label";
    pageLabel.textContent = `${commentsViewPage} / ${totalPages}`;
    pager.appendChild(pageLabel);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "link-btn small";
    nextBtn.textContent = "次へ →";
    nextBtn.disabled = commentsViewPage >= totalPages;
    nextBtn.addEventListener("click", () => {
      commentsViewPage++;
      renderCommentsView();
    });
    pager.appendChild(nextBtn);

    panel.appendChild(pager);
  }
}

// ---------- dashboard view ----------
function renderDashboardView() {
  const project = getActiveProject();
  const panel = viewPanels.dashboard;
  panel.innerHTML = "";
  if (!project) return;

  let total = 0;
  // Keyed by priority option id (dynamic, since priority options are now
  // per-project and user-editable) rather than a fixed high/medium/low enum.
  const byPriority = {};
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
      const key = card.priority || "none";
      byPriority[key] = (byPriority[key] || 0) + 1;
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
  // The "top" priority tile tracks whichever option is first in the
  // project's priority list (matching the high/medium/low ordering
  // convention), so it keeps working after options are renamed/added/removed.
  const topPriorityOption = getPriorityOptions(project)[0];
  statsRow.appendChild(
    statTile(
      topPriorityOption ? `${topPriorityOption.label}重要度` : "重要度(最上位)",
      topPriorityOption ? byPriority[topPriorityOption.id] || 0 : 0
    )
  );
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

  // Image attachments get their own list (in display order) so clicking one
  // opens the full-screen slideshow and can page through the others via
  // prev/next, rather than jumping between unrelated file types.
  const imageAttachmentEntries = attachmentEntries.filter((entry) => isImageAttachment(entry.att));

  if (!attachmentEntries.length) {
    const p = document.createElement("p");
    p.className = "table-empty";
    p.textContent = "添付ファイルはありません";
    attachmentsSection.appendChild(p);
  } else {
    attachmentEntries.forEach(({ att, card, column }) => {
      const row = document.createElement("div");
      row.className = "dashboard-attachment-row";
      // Clicking an attachment opens the file itself (not the linked card):
      // images open in the full-screen slideshow (with prev/next across the
      // other image attachments), everything else opens the raw file URL in
      // a new tab.
      row.addEventListener("click", () => {
        if (isImageAttachment(att)) {
          const idx = imageAttachmentEntries.findIndex((entry) => entry.att === att);
          openAttachmentSlideshow(imageAttachmentEntries, idx >= 0 ? idx : 0);
        } else if (att.url) {
          window.open(att.url, "_blank", "noopener,noreferrer");
        }
      });

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

// ---------- attachment slideshow (full-screen image viewer, dashboard) ----------
// Clicking an image attachment in the dashboard's attachment list opens this
// full-screen overlay instead of the raw image URL, and lets you page
// through every other image attachment in that same list via prev/next.
const slideshowModal = document.getElementById("attachment-slideshow-modal");
const slideshowImageEl = document.getElementById("slideshow-image");
const slideshowCaptionEl = document.getElementById("slideshow-caption");
const slideshowCloseBtn = document.getElementById("slideshow-close-btn");
const slideshowPrevBtn = document.getElementById("slideshow-prev-btn");
const slideshowNextBtn = document.getElementById("slideshow-next-btn");

let slideshowEntries = [];
let slideshowIndex = 0;

function renderSlideshowFrame() {
  const entry = slideshowEntries[slideshowIndex];
  if (!entry) return;
  slideshowImageEl.src = entry.att.url;
  slideshowImageEl.alt = entry.att.name || "";
  slideshowCaptionEl.textContent = `${entry.att.name || ""} ・ ${entry.card.text} (${entry.column.title}) ・ ${
    slideshowIndex + 1
  } / ${slideshowEntries.length}`;
  const multiple = slideshowEntries.length > 1;
  slideshowPrevBtn.classList.toggle("hidden", !multiple);
  slideshowNextBtn.classList.toggle("hidden", !multiple);
}

function openAttachmentSlideshow(entries, startIndex) {
  if (!entries || !entries.length) return;
  slideshowEntries = entries;
  slideshowIndex = ((startIndex % entries.length) + entries.length) % entries.length;
  renderSlideshowFrame();
  slideshowModal.classList.remove("hidden");
}

function closeAttachmentSlideshow() {
  slideshowModal.classList.add("hidden");
  slideshowImageEl.src = "";
  slideshowEntries = [];
}

function slideshowStep(delta) {
  if (!slideshowEntries.length) return;
  slideshowIndex = (slideshowIndex + delta + slideshowEntries.length) % slideshowEntries.length;
  renderSlideshowFrame();
}

slideshowCloseBtn.addEventListener("click", closeAttachmentSlideshow);
slideshowPrevBtn.addEventListener("click", () => slideshowStep(-1));
slideshowNextBtn.addEventListener("click", () => slideshowStep(1));
slideshowModal.addEventListener("click", (e) => {
  if (e.target === slideshowModal) closeAttachmentSlideshow();
});
document.addEventListener("keydown", (e) => {
  if (slideshowModal.classList.contains("hidden")) return;
  if (e.key === "Escape") closeAttachmentSlideshow();
  else if (e.key === "ArrowLeft") slideshowStep(-1);
  else if (e.key === "ArrowRight") slideshowStep(1);
});

// ---------- card detail modal ----------
const cardModal = document.getElementById("card-modal");
const modalTitleInput = document.getElementById("modal-title");
const modalCloseBtn = document.getElementById("modal-close-btn");
const modalDuplicateBtn = document.getElementById("modal-duplicate-btn");
const modalDeleteBtn = document.getElementById("modal-delete-btn");
const modalMoveListSelect = document.getElementById("modal-move-list-select");
const modalStartDate = document.getElementById("modal-start-date");
const modalDueDate = document.getElementById("modal-due-date");
const modalPriority = document.getElementById("modal-priority");
const modalCustomFieldsEl = document.getElementById("modal-custom-fields");
const modalMembersEl = document.getElementById("modal-members");
const modalMemberInput = document.getElementById("modal-member-input");
const modalNotes = document.getElementById("modal-notes");
const modalNotesToolbar = document.getElementById("modal-notes-toolbar");
const modalCommentsEl = document.getElementById("modal-comments");
const modalCommentInput = document.getElementById("modal-comment-input");
const modalCommentSendBtn = document.getElementById("modal-comment-send-btn");
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
const modalActualTimeEl = document.getElementById("modal-actual-time");

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
  modalDuplicateBtn.classList.toggle("hidden", !editable);
  modalDeleteBtn.classList.toggle("hidden", !editable);
  modalMoveListSelect.disabled = !editable;
  modalStartDate.disabled = !editable;
  modalDueDate.disabled = !editable;
  modalPriority.disabled = !editable;
  modalNotes.contentEditable = editable ? "true" : "false";
  modalNotesToolbar.classList.toggle("hidden", !editable);
  modalMemberInput.disabled = !editable;
  modalCommentInput.disabled = !editable;
  modalCommentSendBtn.disabled = !editable;
  modalAttachmentLabel.classList.toggle("hidden", !editable);
  modalCommentFileInput.disabled = !editable;
  document.querySelector(".attach-icon-btn").classList.toggle("hidden", !editable);
  modalCoverControls.classList.toggle("hidden", !editable);
  modalCoverImageInput.disabled = !editable;
  Array.from(modalCustomFieldsEl.querySelectorAll("input, select")).forEach((el) => {
    el.disabled = !editable;
  });
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
  populateModal(found.card, found.project);
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

// Rebuilds the <select id="modal-priority"> options from the active
// project's priority list every time the modal opens (or the project's
// options change), since these are no longer a fixed high/medium/low enum.
function renderModalPriorityOptions(project, currentPriorityId) {
  modalPriority.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "未設定";
  modalPriority.appendChild(blank);

  const options = getPriorityOptions(project);
  options.forEach((opt) => {
    const optionEl = document.createElement("option");
    optionEl.value = opt.id;
    optionEl.textContent = opt.label;
    modalPriority.appendChild(optionEl);
  });

  // If the card references a priority option that's since been deleted,
  // keep it selectable/visible (as its id) rather than silently reverting
  // to blank, so the value isn't lost until the user actively changes it.
  if (currentPriorityId && !options.some((o) => o.id === currentPriorityId)) {
    const staleOption = document.createElement("option");
    staleOption.value = currentPriorityId;
    staleOption.textContent = `${currentPriorityId}(削除済み)`;
    modalPriority.appendChild(staleOption);
  }

  modalPriority.value = currentPriorityId || "";
}

// Renders one input per custom field defined on the project (text or
// select/dropdown), pre-filled from card.customFieldValues, into
// #modal-custom-fields. Rebuilt from scratch every time the modal opens
// since field definitions can differ per project and can change over time.
function renderModalCustomFields(project, card) {
  modalCustomFieldsEl.innerHTML = "";
  const fields = (project && project.customFields) || [];
  const values = card.customFieldValues || {};

  fields.forEach((field) => {
    const item = document.createElement("div");
    item.className = "custom-field-item";

    const label = document.createElement("label");
    label.textContent = field.name;
    item.appendChild(label);

    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "未設定";
      input.appendChild(blank);
      (field.options || []).forEach((optionLabel) => {
        const optionEl = document.createElement("option");
        optionEl.value = optionLabel;
        optionEl.textContent = optionLabel;
        input.appendChild(optionEl);
      });
      input.value = values[field.id] || "";
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.value = values[field.id] || "";
    }
    input.dataset.fieldId = field.id;
    input.addEventListener("change", () => {
      if (!activeCardRef) return;
      const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
      if (!found) return;
      found.card.customFieldValues = found.card.customFieldValues || {};
      found.card.customFieldValues[field.id] = input.value;
      saveProject(found.project);
    });

    item.appendChild(input);
    modalCustomFieldsEl.appendChild(item);
  });
}

// Rebuilds the "別のリストへ移動" <select> from the active project's current
// list of columns every time the modal opens, selecting whichever column the
// card is presently in.
function renderModalMoveListSelect(project, currentColumnId) {
  modalMoveListSelect.innerHTML = "";
  ((project && project.columns) || []).forEach((column) => {
    const optionEl = document.createElement("option");
    optionEl.value = column.id;
    optionEl.textContent = column.title;
    modalMoveListSelect.appendChild(optionEl);
  });
  modalMoveListSelect.value = currentColumnId || "";
}

function populateModal(card, project) {
  project = project || getActiveProject();
  modalTitleInput.value = card.text;
  modalStartDate.value = card.startDate || "";
  modalDueDate.value = card.dueDate || "";
  modalActualTimeEl.textContent = card.actualMinutes ? formatMinutesJP(card.actualMinutes) : "記録なし";
  renderModalMoveListSelect(project, activeCardRef ? activeCardRef.columnId : "");
  renderModalPriorityOptions(project, card.priority || "");
  renderModalCustomFields(project, card);
  modalNotes.innerHTML = card.notes || "";
  renderMembers(card.members || []);
  renderComments(card.comments || []);
  renderAttachments(card.attachments || []);
  renderCoverBanner(card.cover || null);
  renderCoverSwatches(card.cover || null);
  pendingCommentFile = null;
  renderPendingFile();

  updateAttachmentHint();
}

// ---------- card duplicate / delete (from within the modal) ----------
// Duplicates the card's content (title, dates, priority, members, notes,
// custom field values, and a plain color cover). Comments and file
// attachments are intentionally NOT copied: comments are a timestamped
// conversation tied to the original card, and file/image attachments point
// at a specific Firebase Storage path — copying the reference (rather than
// re-uploading a real second copy of the file) would leave both cards
// pointing at the same file, so deleting one card's attachments from the
// trash later would silently break the other card's attachment too.
function duplicateCard() {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found || !canEditProject(found.project)) return;

  const original = found.card;
  const copy = {
    id: uid(),
    text: `${original.text} のコピー`,
    startDate: original.startDate || null,
    dueDate: original.dueDate || null,
    priority: original.priority || null,
    notes: original.notes || "",
    members: Array.isArray(original.members) ? [...original.members] : [],
    comments: [],
    attachments: [],
    cover: original.cover && original.cover.type === "color" ? { ...original.cover } : null,
    customFieldValues: original.customFieldValues ? { ...original.customFieldValues } : {},
  };

  const idx = found.column.cards.findIndex((c) => c.id === original.id);
  found.column.cards.splice(idx === -1 ? found.column.cards.length : idx + 1, 0, copy);
  saveProject(found.project);

  activeCardRef = { columnId: found.column.id, cardId: copy.id };
  populateModal(copy, found.project);
  applyModalEditability(canEditProject(found.project));
}

modalDuplicateBtn.addEventListener("click", duplicateCard);

// Moves the currently-open card into whichever list the user picks from the
// dropdown — the same underlying move as dragging the card on the board,
// just reachable from inside the modal too.
modalMoveListSelect.addEventListener("change", () => {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found || !canEditProject(found.project)) return;

  const targetColumnId = modalMoveListSelect.value;
  if (targetColumnId === found.column.id) return;
  const targetColumn = found.project.columns.find((c) => c.id === targetColumnId);
  if (!targetColumn) return;

  const idx = found.column.cards.findIndex((c) => c.id === found.card.id);
  if (idx === -1) return;
  const [movedCard] = found.column.cards.splice(idx, 1);
  targetColumn.cards.push(movedCard);

  activeCardRef = { columnId: targetColumn.id, cardId: movedCard.id };
  saveProject(found.project);
});

modalDeleteBtn.addEventListener("click", () => {
  if (!activeCardRef) return;
  const { columnId, cardId } = activeCardRef;
  openConfirmModal({
    title: "削除しますか？",
    message: "このカードはゴミ箱に移動します。ゴミ箱からいつでも復元・完全削除できます。",
    okLabel: "削除する",
    onConfirm: () => moveCardToTrash(columnId, cardId),
  });
});

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

// Persists an edited/deleted comment back onto the card currently open in
// the modal, then re-renders the comment list. Shared by the edit-save and
// delete flows below.
function mutateActiveCardComments(mutator) {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.comments = found.card.comments || [];
  mutator(found.card.comments);
  saveProject(found.project);
  renderComments(found.card.comments);
}

function isCommentAuthor(comment) {
  return !!(currentUser && comment.authorUid && comment.authorUid === currentUser.uid);
}

// Swaps a comment's text display for an inline textarea + save/cancel row.
// `item` is the .comment-item element already in the DOM for this comment.
function startEditingComment(item, comment) {
  const textEl = item.querySelector(".comment-text");
  if (!textEl) return;

  const textarea = document.createElement("textarea");
  textarea.className = "comment-edit-textarea";
  textarea.rows = 3;
  textarea.value = comment.text || "";

  const actionsRow = document.createElement("div");
  actionsRow.className = "comment-edit-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "confirm-add";
  saveBtn.textContent = "保存";
  saveBtn.addEventListener("click", () => {
    const newText = textarea.value.trim();
    if (!newText) return;
    mutateActiveCardComments((comments) => {
      const target = comments.find((x) => x.id === comment.id);
      if (target) {
        target.text = newText;
        target.editedAt = new Date().toISOString();
      }
    });
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "cancel-add";
  cancelBtn.textContent = "キャンセル";
  cancelBtn.addEventListener("click", () => {
    if (!activeCardRef) return;
    const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
    if (found) renderComments(found.card.comments || []);
  });

  actionsRow.appendChild(saveBtn);
  actionsRow.appendChild(cancelBtn);

  textEl.replaceWith(textarea);
  textarea.after(actionsRow);
  textarea.focus();
}

function renderComments(comments) {
  modalCommentsEl.innerHTML = "";
  comments.forEach((c) => {
    const item = document.createElement("div");
    item.className = "comment-item";

    const meta = document.createElement("div");
    meta.className = "comment-meta";

    const authorSpan = document.createElement("span");
    authorSpan.className = "comment-meta-author";
    const date = new Date(c.createdAt);
    authorSpan.textContent =
      `${c.author} ・ ${date.toLocaleString("ja-JP")}` + (c.editedAt ? " " : "");
    if (c.editedAt) {
      const editedTag = document.createElement("span");
      editedTag.className = "comment-meta-edited";
      editedTag.textContent = "(編集済み)";
      authorSpan.appendChild(editedTag);
    }
    meta.appendChild(authorSpan);

    const textEl = document.createElement("div");
    textEl.className = "comment-text";
    textEl.textContent = c.text;

    // Only the person who posted a comment may edit or delete it.
    if (isCommentAuthor(c)) {
      const actions = document.createElement("div");
      actions.className = "comment-actions";

      if (c.text) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "comment-action-btn";
        editBtn.title = "編集";
        editBtn.textContent = "✏️";
        editBtn.addEventListener("click", () => startEditingComment(item, c));
        actions.appendChild(editBtn);
      }

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "comment-action-btn danger";
      deleteBtn.title = "削除";
      deleteBtn.textContent = "🗑️";
      deleteBtn.addEventListener("click", () => {
        openConfirmModal({
          title: "コメントを削除しますか？",
          message: "この操作は取り消せません。",
          okLabel: "削除する",
          onConfirm: () => {
            mutateActiveCardComments((comments) => {
              const idx = comments.findIndex((x) => x.id === c.id);
              if (idx !== -1) comments.splice(idx, 1);
            });
          },
        });
      });
      actions.appendChild(deleteBtn);

      meta.appendChild(actions);
    }

    item.appendChild(meta);
    if (c.text) item.appendChild(textEl);

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

// ---------- 備考 (notes) rich-text editor: bold/italic/bullet/numbered list ----------
// Strips anything that could execute (script/style/iframe tags, inline
// event-handler attributes, javascript: URLs) before it's saved. Notes are
// shared with every editor/viewer on the project, so this is stored,
// multi-user HTML — worth a defense-in-depth pass even though pasted
// content is already forced to plain text below.
function sanitizeNotesHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const strip = (root) => {
    Array.from(root.childNodes).forEach((node) => {
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (["script", "style", "iframe", "object", "embed"].includes(tag)) {
        node.remove();
        return;
      }
      Array.from(node.attributes).forEach((attr) => {
        const name = attr.name.toLowerCase();
        const value = attr.value || "";
        if (name.startsWith("on") || /^\s*javascript:/i.test(value)) {
          node.removeAttribute(attr.name);
        }
      });
      strip(node);
    });
  };
  strip(template.content);
  return template.innerHTML;
}

function saveModalNotes() {
  if (!activeCardRef) return;
  const found = findCard(activeCardRef.columnId, activeCardRef.cardId);
  if (!found) return;
  found.card.notes = sanitizeNotesHtml(modalNotes.innerHTML);
  saveProject(found.project);
}

modalNotes.addEventListener("blur", saveModalNotes);

// Pasting is forced to plain text only — accepting arbitrary pasted HTML
// (e.g. from a webpage) would be the main way something unwanted could end
// up embedded in a note that's then shared with every project member.
modalNotes.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData("text/plain");
  document.execCommand("insertText", false, text);
});

function updateNotesToolbarState() {
  modalNotesToolbar.querySelectorAll(".notes-toolbar-btn").forEach((btn) => {
    let active = false;
    try {
      active = document.queryCommandState(btn.dataset.cmd);
    } catch (err) {
      active = false;
    }
    btn.classList.toggle("active", active);
  });
}

modalNotesToolbar.querySelectorAll(".notes-toolbar-btn").forEach((btn) => {
  // mousedown (not click) + preventDefault, so clicking the toolbar button
  // doesn't steal focus/selection away from the notes editor before the
  // formatting command has a chance to apply to the selected text.
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (modalNotes.contentEditable !== "true") return;
    document.execCommand(btn.dataset.cmd, false, null);
    updateNotesToolbarState();
  });
});

modalNotes.addEventListener("keyup", updateNotesToolbarState);
modalNotes.addEventListener("mouseup", updateNotesToolbarState);
modalNotes.addEventListener("focus", updateNotesToolbarState);

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

// Comments are posted by clicking the "送信" button (not by pressing Enter
// in the input) so a stray Enter keystroke while typing doesn't accidentally
// submit an unfinished comment.
async function submitComment() {
  if (!activeCardRef) return;
  const text = modalCommentInput.value.trim();
  if (!text && !pendingCommentFile) return;
  if (!currentUser) return;

  const targetColumnId = activeCardRef.columnId;
  const targetCardId = activeCardRef.cardId;
  const fileToUpload = pendingCommentFile;

  modalCommentInput.value = "";
  modalCommentInput.disabled = true;
  modalCommentSendBtn.disabled = true;

  let attachment = null;
  if (fileToUpload) {
    showPendingFileUploading(fileToUpload);
    try {
      attachment = await uploadFile(fileToUpload, `kanban/comments/${targetCardId}`);
    } catch (err) {
      console.error("upload failed", err);
      alert("ファイルのアップロードに失敗しました: " + err.message);
      modalCommentInput.disabled = false;
      modalCommentSendBtn.disabled = false;
      pendingCommentFile = fileToUpload;
      renderPendingFile();
      return;
    }
  }

  pendingCommentFile = null;
  renderPendingFile();
  modalCommentInput.disabled = false;
  modalCommentSendBtn.disabled = false;

  const found = findCard(targetColumnId, targetCardId);
  if (!found) return;
  found.card.comments = found.card.comments || [];
  const comment = {
    id: uid(),
    author:
      (userProfile && userProfile.displayName) || currentUser.displayName || currentUser.email || "匿名",
    authorUid: currentUser.uid,
    text,
    createdAt: new Date().toISOString(),
  };
  if (attachment) comment.attachment = attachment;
  found.card.comments.push(comment);
  saveProject(found.project);
  if (activeCardRef && activeCardRef.cardId === targetCardId) {
    renderComments(found.card.comments);
  }
}

modalCommentSendBtn.addEventListener("click", submitComment);

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
  // Read-only (calendar-derived), so safe to refresh live too.
  modalActualTimeEl.textContent = found.card.actualMinutes
    ? formatMinutesJP(found.card.actualMinutes)
    : "記録なし";
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
    // Denormalized so the trash UI can still show which list a card came
    // from even after that list itself has been deleted (fromColumnId
    // would no longer resolve to anything in project.columns at that point).
    fromColumnTitle: column.title,
    deletedAt: new Date().toISOString(),
  });
  if (activeCardRef && activeCardRef.cardId === cardId) closeCardModal();
  saveProject(project);
}

// Deleting a whole list also deletes every card inside it — rather than
// losing that data outright, every card gets moved into the trash exactly
// like an individual card deletion would, all tagged with the same
// `listBatchId` so the trash UI can group them under one "this whole list
// was deleted" header (with a one-click "listごと元に戻す" to undo it) instead
// of showing a wall of unrelated-looking loose cards.
function deleteColumnAndTrashCards(project, columnId) {
  if (!project || !canEditProject(project)) return;
  const idx = project.columns.findIndex((c) => c.id === columnId);
  if (idx === -1) return;
  const [removedColumn] = project.columns.splice(idx, 1);

  const cardsInColumn = removedColumn.cards || [];
  if (activeCardRef && cardsInColumn.some((c) => c.id === activeCardRef.cardId)) {
    closeCardModal();
  }

  project.trash = project.trash || [];
  if (cardsInColumn.length) {
    const batchId = uid();
    const deletedAt = new Date().toISOString();
    cardsInColumn.forEach((card) => {
      project.trash.unshift({
        id: uid(),
        card,
        fromColumnId: removedColumn.id,
        fromColumnTitle: removedColumn.title,
        deletedAt,
        listBatchId: batchId,
        listBatchTitle: removedColumn.title,
      });
    });
  }

  saveProject(project);
}

// Un-does a whole-list deletion in one click: recreates the list (as a new
// column, since the original id is gone) with all of its cards restored
// into it, and removes those cards from the trash.
function restoreListBatch(listBatchId) {
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;
  const items = (project.trash || []).filter((t) => t.listBatchId === listBatchId);
  if (!items.length) return;
  const title = items[0].listBatchTitle || items[0].fromColumnTitle || "復元されたリスト";
  project.columns.push(makeColumn(title, items.map((it) => it.card)));
  project.trash = (project.trash || []).filter((t) => t.listBatchId !== listBatchId);
  saveProject(project);
}

// Permanently deletes every card belonging to one whole-list-deletion batch
// (and their Storage files), in one action rather than one card at a time.
function permanentlyDeleteListBatch(listBatchId) {
  const project = getActiveProject();
  if (!project || !canEditProject(project)) return;
  const items = (project.trash || []).filter((t) => t.listBatchId === listBatchId);
  items.forEach((item) => deleteCardStorageFiles(item.card));
  project.trash = (project.trash || []).filter((t) => t.listBatchId !== listBatchId);
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

// Builds one card row for the trash list. `nested` is true when this row is
// rendered inside a whole-list-deletion group (slightly different styling —
// see .trash-item.nested).
function renderTrashItemRow(item, nested) {
  const row = document.createElement("div");
  row.className = "trash-item" + (nested ? " nested" : "");

  const info = document.createElement("div");
  info.className = "trash-item-info";

  const title = document.createElement("div");
  title.className = "trash-item-title";
  title.textContent = item.card.text;

  const meta = document.createElement("div");
  meta.className = "trash-item-meta";
  meta.textContent =
    (item.fromColumnTitle || "不明なリスト") + " ・ " + new Date(item.deletedAt).toLocaleString("ja-JP");

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
  return row;
}

// Cards deleted together as part of a whole-list deletion (they share a
// listBatchId) are rendered grouped under one header with "restore the
// whole list" / "permanently delete all" actions, instead of as a wall of
// loose, seemingly-unrelated cards. Everything else renders as a plain row,
// same as before.
function renderTrash() {
  const project = getActiveProject();
  const trash = (project && project.trash) || [];
  trashListEl.innerHTML = "";

  if (!trash.length) {
    trashListEl.innerHTML = '<p class="trash-empty">ゴミ箱は空です</p>';
    return;
  }

  const rendered = new Set();

  trash.forEach((item) => {
    if (rendered.has(item.id)) return;

    if (item.listBatchId) {
      const groupItems = trash.filter((t) => t.listBatchId === item.listBatchId);
      groupItems.forEach((g) => rendered.add(g.id));
      const listTitle = item.listBatchTitle || item.fromColumnTitle || "リスト";

      const group = document.createElement("div");
      group.className = "trash-list-group";

      const header = document.createElement("div");
      header.className = "trash-group-header";

      const heading = document.createElement("div");
      heading.className = "trash-group-heading";
      const titleEl = document.createElement("div");
      titleEl.className = "trash-group-title";
      titleEl.textContent = `🗑️ 「${listTitle}」を削除`;
      const metaEl = document.createElement("div");
      metaEl.className = "trash-group-meta";
      metaEl.textContent =
        `${groupItems.length}件のカード ・ ` + new Date(item.deletedAt).toLocaleString("ja-JP");
      heading.appendChild(titleEl);
      heading.appendChild(metaEl);
      header.appendChild(heading);

      const groupActions = document.createElement("div");
      groupActions.className = "trash-group-actions";

      const restoreAllBtn = document.createElement("button");
      restoreAllBtn.className = "restore-btn";
      restoreAllBtn.textContent = "リストごと元に戻す";
      restoreAllBtn.addEventListener("click", () => restoreListBatch(item.listBatchId));
      groupActions.appendChild(restoreAllBtn);

      const deleteAllBtn = document.createElement("button");
      deleteAllBtn.className = "danger-btn small";
      deleteAllBtn.textContent = "すべて完全に削除";
      deleteAllBtn.addEventListener("click", () => {
        openConfirmModal({
          title: "完全に削除しますか？",
          message: `「${listTitle}」の${groupItems.length}件のカードをすべて完全に削除します。この操作は元に戻せません。`,
          okLabel: "完全に削除",
          onConfirm: () => permanentlyDeleteListBatch(item.listBatchId),
        });
      });
      groupActions.appendChild(deleteAllBtn);

      header.appendChild(groupActions);
      group.appendChild(header);

      const cardsWrap = document.createElement("div");
      cardsWrap.className = "trash-group-cards";
      groupItems.forEach((g) => cardsWrap.appendChild(renderTrashItemRow(g, true)));
      group.appendChild(cardsWrap);

      trashListEl.appendChild(group);
    } else {
      rendered.add(item.id);
      trashListEl.appendChild(renderTrashItemRow(item, false));
    }
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
