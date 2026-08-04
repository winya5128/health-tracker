const APP_VERSION = "2.0.0";
const STORAGE_PREFIX = "healthTracker:";
const CATEGORIES = ["weight", "meals", "exercise", "vitals"];
const GIST_FILENAME = "health-tracker.json";

// PCから閲覧するときは ?mode=view を付ける。
// このモードでは localStorage を一切書き換えず、Gistへも書き込まない。
const VIEW_MODE = new URLSearchParams(location.search).get("mode") === "view";
let remoteData = null;

// ---------- 日付ユーティリティ ----------
// toISOString() は UTC に変換されるため、JST の深夜に記録すると前日扱いになる。
// 端末のローカル日付をそのまま YYYY-MM-DD にする。

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return toDateStr(new Date());
}

// ---------- ストレージ ----------

const Storage = {
  load(category) {
    if (VIEW_MODE) return (remoteData && remoteData[category]) || [];
    try {
      return JSON.parse(localStorage.getItem(STORAGE_PREFIX + category)) || [];
    } catch {
      return [];
    }
  },
  save(category, records) {
    if (VIEW_MODE) return;
    localStorage.setItem(STORAGE_PREFIX + category, JSON.stringify(records));
  },
  add(category, record) {
    const records = Storage.load(category);
    record.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    records.push(record);
    records.sort((a, b) => (a.date < b.date ? 1 : -1));
    Storage.save(category, records);
    scheduleBackup();
    return records;
  },
  remove(category, id) {
    const records = Storage.load(category).filter((r) => r.id !== id);
    Storage.save(category, records);
    scheduleBackup();
    return records;
  },
  totalCount() {
    return CATEGORIES.reduce((n, c) => n + Storage.load(c).length, 0);
  },
};

const DEFAULT_SETTINGS = {
  targetWeight: null,
  calorieTarget: null,
  gistToken: "",
  gistId: "",
  lastBackupAt: "",
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_PREFIX + "settings"));
    return { ...DEFAULT_SETTINGS, ...(raw || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  settings = { ...settings, ...next };
  localStorage.setItem(STORAGE_PREFIX + "settings", JSON.stringify(settings));
}

let settings = loadSettings();

// ---------- 食品ライブラリ ----------
// 旧形式 { 名前: kcal } も読めるようにし、使用回数 count を持つ形へ寄せる。
// タイルは使用回数の多い順に並ぶので、使うほど入力が速くなる。

const DEFAULT_FOODS = {
  "ご飯(茶碗1杯)": 240,
  "玄米ご飯": 230,
  "食パン(1枚)": 160,
  "味噌汁": 40,
  "豆腐": 80,
  "納豆(1パック)": 100,
  "卵焼き": 150,
  "目玉焼き": 90,
  "焼き魚(鮭)": 180,
  "焼き魚(さば)": 220,
  "唐揚げ(4個)": 280,
  "餃子(6個)": 300,
  "野菜サラダ": 30,
  "きんぴらごぼう": 90,
  "ひじきの煮物": 70,
  "かぼちゃの煮物": 120,
  "肉じゃが": 250,
  "カレーライス": 700,
  "親子丼": 650,
  "チャーハン": 600,
  "うどん(かけ)": 350,
  "そば(かけ)": 320,
  "ラーメン": 500,
  "パスタ(ミートソース)": 600,
  "ヨーグルト": 80,
  "バナナ": 90,
  "牛乳(コップ1杯)": 130,
};

function normalizeFoodDb(raw) {
  const db = {};
  for (const [name, value] of Object.entries(raw || {})) {
    if (typeof value === "number") db[name] = { kcal: value, count: 0 };
    else if (value && typeof value.kcal === "number") {
      db[name] = { kcal: value.kcal, count: value.count || 0 };
    }
  }
  return db;
}

function loadFoodDb() {
  const raw = localStorage.getItem(STORAGE_PREFIX + "foods");
  if (raw) {
    try {
      const db = normalizeFoodDb(JSON.parse(raw));
      if (Object.keys(db).length) return db;
    } catch {
      // 壊れていたら初期値で作り直す
    }
  }
  const seeded = normalizeFoodDb(DEFAULT_FOODS);
  saveFoodDb(seeded);
  return seeded;
}

function saveFoodDb(db) {
  if (VIEW_MODE) return;
  localStorage.setItem(STORAGE_PREFIX + "foods", JSON.stringify(db));
}

let foodDb = loadFoodDb();

// ---------- Gist バックアップ ----------

const GH_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
});

function buildPayload() {
  const payload = { version: APP_VERSION, exportedAt: new Date().toISOString(), foods: foodDb };
  for (const category of CATEGORIES) payload[category] = Storage.load(category);
  payload.settings = {
    targetWeight: settings.targetWeight,
    calorieTarget: settings.calorieTarget,
  };
  return payload;
}

function setSyncStatus(text, isError) {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "#ffd9d4" : "";
}

let backupTimer = null;
let backupPending = false;

function scheduleBackup() {
  if (VIEW_MODE) return;
  if (!settings.gistToken || !settings.gistId) return;
  backupPending = true;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(runBackup, 2500);
}

async function runBackup() {
  if (VIEW_MODE || !settings.gistToken || !settings.gistId) return;

  // 空データでの上書きは事故のもとなので絶対に送らない。
  if (Storage.totalCount() === 0) {
    setSyncStatus("記録なし");
    return;
  }
  if (!navigator.onLine) {
    setSyncStatus("オフライン（未送信）", true);
    return;
  }

  setSyncStatus("同期中…");
  try {
    const res = await fetch(`https://api.github.com/gists/${settings.gistId}`, {
      method: "PATCH",
      headers: GH_HEADERS(settings.gistToken),
      body: JSON.stringify({
        files: { [GIST_FILENAME]: { content: JSON.stringify(buildPayload(), null, 2) } },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    backupPending = false;
    saveSettings({ lastBackupAt: new Date().toISOString() });
    setSyncStatus(`同期 ${new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`);
  } catch (err) {
    setSyncStatus("同期エラー", true);
    logGist(`バックアップに失敗しました: ${err.message}`, true);
  }
}

function logGist(message, isError) {
  const el = document.getElementById("gistLog");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", !!isError);
}

async function gistConnect() {
  const token = document.getElementById("setGistToken").value.trim();
  const gistId = document.getElementById("setGistId").value.trim();
  if (!token) {
    logGist("トークンを入力してください。", true);
    return;
  }
  saveSettings({ gistToken: token, gistId });

  try {
    if (!gistId) {
      logGist("新しいGistを作成しています…");
      const res = await fetch("https://api.github.com/gists", {
        method: "POST",
        headers: GH_HEADERS(token),
        body: JSON.stringify({
          description: "体重ノート バックアップ",
          public: false,
          files: { [GIST_FILENAME]: { content: JSON.stringify(buildPayload(), null, 2) } },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      saveSettings({ gistId: json.id, lastBackupAt: new Date().toISOString() });
      document.getElementById("setGistId").value = json.id;
      logGist(`接続しました（Gist ID: ${json.id}）。以後は自動でバックアップされます。`);
      setSyncStatus("同期済み");
    } else {
      await runBackup();
      logGist("既存のGistへバックアップしました。");
    }
  } catch (err) {
    logGist(`接続に失敗しました: ${err.message}（トークンのgist権限を確認してください）`, true);
  }
}

async function fetchGistPayload(token, gistId) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: GH_HEADERS(token),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const file = json.files && json.files[GIST_FILENAME];
  if (!file) throw new Error(`${GIST_FILENAME} が見つかりません`);
  const content = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
  return JSON.parse(content);
}

async function gistRestore() {
  const token = document.getElementById("setGistToken").value.trim() || settings.gistToken;
  const gistId = document.getElementById("setGistId").value.trim() || settings.gistId;
  if (!token || !gistId) {
    logGist("トークンとGist IDの両方が必要です。", true);
    return;
  }
  if (Storage.totalCount() > 0 && !confirm("端末の既存データにGistの内容をマージします。よろしいですか？")) {
    return;
  }
  try {
    logGist("Gistから読み込んでいます…");
    const payload = await fetchGistPayload(token, gistId);
    mergePayload(payload);
    saveSettings({ gistToken: token, gistId });
    logGist("復元しました。");
    refreshAll();
  } catch (err) {
    logGist(`復元に失敗しました: ${err.message}`, true);
  }
}

// id が重複しないレコードだけを取り込む。
function mergePayload(payload) {
  for (const category of CATEGORIES) {
    if (!Array.isArray(payload[category])) continue;
    const existing = Storage.load(category);
    const existingIds = new Set(existing.map((r) => r.id));
    const merged = existing.concat(payload[category].filter((r) => !existingIds.has(r.id)));
    merged.sort((a, b) => (a.date < b.date ? 1 : -1));
    Storage.save(category, merged);
  }
  if (payload.foods) {
    foodDb = { ...normalizeFoodDb(payload.foods), ...foodDb };
    saveFoodDb(foodDb);
  }
  if (payload.settings) {
    const s = {};
    if (payload.settings.targetWeight != null) s.targetWeight = payload.settings.targetWeight;
    if (payload.settings.calorieTarget != null) s.calorieTarget = payload.settings.calorieTarget;
    saveSettings(s);
  }
}

window.addEventListener("online", () => {
  if (backupPending) runBackup();
});

// ---------- タブ ----------

function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${name}`);
  });
  window.scrollTo(0, 0);
  if (name === "home") renderDashboard();
}

document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (btn) switchTab(btn.dataset.tab);
});

document.querySelectorAll("[data-goto]").forEach((el) => {
  el.addEventListener("click", () => switchTab(el.dataset.goto));
});

// ショートカットから #weight / #meals 付きで開くと、その入力画面が直接開く。
function applyHashRoute() {
  const target = location.hash.replace("#", "");
  if (["home", "weight", "meals", "other"].includes(target)) {
    switchTab(target);
    if (target === "weight") {
      const input = document.getElementById("weightInput");
      if (input) setTimeout(() => input.focus(), 150);
    }
  }
}

window.addEventListener("hashchange", applyHashRoute);

// ---------- 一覧テーブル ----------

const TABLE_CONFIG = {
  weight: {
    columns: ["date", "weight", "memo"],
    render: (r) => [r.date, `${r.weight} kg`, r.memo || "-"],
  },
  meals: {
    columns: ["date", "mealType", "content", "calories"],
    render: (r) => [r.date, r.mealType, r.content, r.calories ? `${r.calories}` : "-"],
  },
  exercise: {
    columns: ["date", "activity", "duration", "steps", "memo"],
    render: (r) => [
      r.date,
      r.activity,
      r.duration ? `${r.duration} 分` : "-",
      r.steps ? `${r.steps} 歩` : "-",
      r.memo || "-",
    ],
  },
  vitals: {
    columns: ["date", "sleepHours", "bp", "memo"],
    render: (r) => [
      r.date,
      r.sleepHours ? `${r.sleepHours} h` : "-",
      r.bpHigh && r.bpLow ? `${r.bpHigh}/${r.bpLow}` : "-",
      r.memo || "-",
    ],
  },
};

function renderTable(category) {
  const table = document.getElementById(`table-${category}`);
  if (!table) return;
  const tbody = table.querySelector("tbody");
  const records = Storage.load(category);
  tbody.innerHTML = "";

  if (records.length === 0) {
    const colCount = TABLE_CONFIG[category].columns.length + 1;
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colCount}">まだ記録がありません</td></tr>`;
    return;
  }

  for (const record of records.slice(0, 200)) {
    const tr = document.createElement("tr");
    const cells = TABLE_CONFIG[category].render(record);
    tr.innerHTML = cells.map((c) => `<td>${escapeHtml(String(c))}</td>`).join("");
    const actionTd = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => {
      if (!confirm("この記録を削除しますか？")) return;
      Storage.remove(category, record.id);
      renderTable(category);
      renderDashboard();
    });
    actionTd.appendChild(delBtn);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- 汎用フォーム（体重・運動・生活習慣） ----------

function setupForm(category, extract) {
  const form = document.getElementById(`form-${category}`);
  if (!form) return;
  const dateInput = form.querySelector('input[name="date"]');
  dateInput.value = todayStr();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const record = extract(new FormData(form));
    if (!record) return;
    Storage.add(category, record);
    form.reset();
    dateInput.value = todayStr();
    renderTable(category);
    renderDashboard();
    if (category === "weight") updateWeightHint();
    flash("記録しました");
  });

  renderTable(category);
}

function flash(message) {
  const el = document.createElement("div");
  el.textContent = message;
  el.style.cssText =
    "position:fixed;left:50%;bottom:calc(72px + env(safe-area-inset-bottom));transform:translateX(-50%);" +
    "background:rgba(0,0,0,.82);color:#fff;padding:9px 18px;border-radius:999px;font-size:.85rem;z-index:60;";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

setupForm("weight", (data) => ({
  date: data.get("date"),
  weight: parseFloat(data.get("weight")),
  memo: data.get("memo") || "",
}));

setupForm("exercise", (data) => ({
  date: data.get("date"),
  activity: data.get("activity"),
  duration: data.get("duration") ? parseFloat(data.get("duration")) : null,
  steps: data.get("steps") ? parseFloat(data.get("steps")) : null,
  memo: data.get("memo") || "",
}));

setupForm("vitals", (data) => ({
  date: data.get("date"),
  sleepHours: data.get("sleepHours") ? parseFloat(data.get("sleepHours")) : null,
  bpHigh: data.get("bpHigh") ? parseFloat(data.get("bpHigh")) : null,
  bpLow: data.get("bpLow") ? parseFloat(data.get("bpLow")) : null,
  memo: data.get("memo") || "",
}));

// ---------- 体重入力の補助 ----------

function latestWeightRecord() {
  return Storage.load("weight").find((r) => typeof r.weight === "number") || null;
}

function updateWeightHint() {
  const hint = document.getElementById("weightHint");
  const input = document.getElementById("weightInput");
  if (!hint || !input) return;
  const last = latestWeightRecord();
  if (!last) {
    hint.textContent = "最初の記録です。体重計の数字をそのまま入れてください。";
    return;
  }
  hint.textContent = `前回 ${last.weight} kg（${last.date}）`;
  if (!input.value) input.placeholder = String(last.weight);
}

function stepWeight(delta) {
  const input = document.getElementById("weightInput");
  const base = parseFloat(input.value);
  const start = isNaN(base) ? (latestWeightRecord()?.weight ?? 60) : base;
  input.value = (Math.round((start + delta) * 10) / 10).toFixed(1);
}

document.getElementById("weightMinus")?.addEventListener("click", () => stepWeight(-0.1));
document.getElementById("weightPlus")?.addEventListener("click", () => stepWeight(0.1));

// ---------- 食事（タップ選択式） ----------

let currentMealItems = [];
const QTY_STEPS = [0.5, 1, 1.5, 2, 3];

function guessMealType() {
  const h = new Date().getHours();
  if (h < 10) return "朝食";
  if (h < 15) return "昼食";
  if (h < 21) return "夕食";
  return "間食";
}

function selectedMealType() {
  const active = document.querySelector("#mealTypeSeg .seg-btn.active");
  return active ? active.dataset.value : "朝食";
}

function setMealType(value) {
  document.querySelectorAll("#mealTypeSeg .seg-btn").forEach((b) => {
    const on = b.dataset.value === value;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
}

document.getElementById("mealTypeSeg")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (btn) setMealType(btn.dataset.value);
});

function renderFoodTiles() {
  const wrap = document.getElementById("foodTiles");
  if (!wrap) return;
  const query = (document.getElementById("foodFilter").value || "").trim().toLowerCase();

  let names = Object.keys(foodDb);
  if (query) names = names.filter((n) => n.toLowerCase().includes(query));
  names.sort((a, b) => {
    const diff = (foodDb[b].count || 0) - (foodDb[a].count || 0);
    return diff !== 0 ? diff : a.localeCompare(b, "ja");
  });
  if (!query) names = names.slice(0, 24);

  wrap.innerHTML = "";
  if (names.length === 0) {
    wrap.innerHTML = '<p class="food-empty">該当するメニューがありません。下のボタンから登録できます。</p>';
    return;
  }
  for (const name of names) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "food-tile";
    btn.innerHTML = `<span></span><span class="kcal">${foodDb[name].kcal}</span>`;
    btn.firstChild.textContent = name;
    btn.addEventListener("click", () => addMealItem(name));
    wrap.appendChild(btn);
  }
}

function addMealItem(name) {
  const entry = foodDb[name];
  if (!entry) return;
  const existing = currentMealItems.find((i) => i.name === name);
  if (existing) existing.qty = Math.round((existing.qty + 1) * 10) / 10;
  else currentMealItems.push({ name, qty: 1, calories: entry.kcal });
  renderMealItems();
}

function renderMealItems() {
  const list = document.getElementById("mealItemsList");
  if (!list) return 0;
  list.innerHTML = "";
  let total = 0;

  currentMealItems.forEach((item, index) => {
    const subtotal = Math.round(item.calories * item.qty);
    total += subtotal;

    const li = document.createElement("li");

    const nameSpan = document.createElement("span");
    nameSpan.className = "item-name";
    nameSpan.textContent = item.name;

    const kcalSpan = document.createElement("span");
    kcalSpan.className = "item-kcal";
    kcalSpan.textContent = `${subtotal} kcal`;

    const qtyBtn = document.createElement("button");
    qtyBtn.type = "button";
    qtyBtn.className = "qty-btn";
    qtyBtn.textContent = `×${item.qty}`;
    qtyBtn.addEventListener("click", () => {
      const i = QTY_STEPS.indexOf(item.qty);
      item.qty = QTY_STEPS[(i + 1) % QTY_STEPS.length];
      renderMealItems();
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "item-del";
    delBtn.setAttribute("aria-label", `${item.name}を外す`);
    delBtn.textContent = "×";
    delBtn.addEventListener("click", () => {
      currentMealItems.splice(index, 1);
      renderMealItems();
    });

    li.append(nameSpan, kcalSpan, qtyBtn, delBtn);
    list.appendChild(li);
  });

  document.getElementById("mealTotalDisplay").textContent = total;
  return total;
}

document.getElementById("foodFilter")?.addEventListener("input", renderFoodTiles);

document.getElementById("newFoodBtn")?.addEventListener("click", () => {
  const form = document.getElementById("newFoodForm");
  form.hidden = false;
  const nameInput = document.getElementById("newFoodName");
  nameInput.value = document.getElementById("foodFilter").value.trim();
  nameInput.focus();
});

document.getElementById("newFoodCancel")?.addEventListener("click", () => {
  document.getElementById("newFoodForm").hidden = true;
});

document.getElementById("newFoodSave")?.addEventListener("click", () => {
  const name = document.getElementById("newFoodName").value.trim();
  const kcal = parseFloat(document.getElementById("newFoodKcal").value);
  if (!name) {
    alert("メニュー名を入力してください。");
    return;
  }
  if (isNaN(kcal) || kcal < 0) {
    alert("カロリーを数字で入力してください。");
    return;
  }
  foodDb[name] = { kcal, count: foodDb[name]?.count || 0 };
  saveFoodDb(foodDb);
  document.getElementById("newFoodName").value = "";
  document.getElementById("newFoodKcal").value = "";
  document.getElementById("newFoodForm").hidden = true;
  document.getElementById("foodFilter").value = "";
  renderFoodTiles();
  addMealItem(name);
});

(function setupMealsForm() {
  const form = document.getElementById("form-meals");
  if (!form) return;
  const dateInput = form.querySelector('input[name="date"]');
  const overrideInput = document.getElementById("caloriesOverride");
  dateInput.value = todayStr();
  setMealType(guessMealType());

  renderFoodTiles();
  renderMealItems();
  renderTable("meals");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const autoTotal = renderMealItems();

    const content = currentMealItems.length
      ? currentMealItems.map((i) => (i.qty === 1 ? i.name : `${i.name}×${i.qty}`)).join("、")
      : (data.get("memo") || "").trim();

    if (!content) {
      alert("メニューを1品以上選ぶか、メモを入力してください。");
      return;
    }

    const overrideRaw = overrideInput.value;
    const calories = overrideRaw
      ? parseFloat(overrideRaw)
      : currentMealItems.length
      ? autoTotal
      : null;

    // 使ったメニューの回数を増やし、次回タイルの上位に来るようにする。
    for (const item of currentMealItems) {
      if (foodDb[item.name]) foodDb[item.name].count = (foodDb[item.name].count || 0) + 1;
    }
    saveFoodDb(foodDb);

    Storage.add("meals", {
      date: data.get("date"),
      mealType: selectedMealType(),
      items: currentMealItems.slice(),
      content,
      calories,
      memo: data.get("memo") || "",
    });

    currentMealItems = [];
    form.reset();
    dateInput.value = todayStr();
    setMealType(guessMealType());
    document.getElementById("foodFilter").value = "";
    renderMealItems();
    renderFoodTiles();
    renderTable("meals");
    renderDashboard();
    flash("記録しました");
  });
})();

// ---------- 集計 ----------

function dateRangeLabels(days) {
  const labels = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    labels.push(toDateStr(d));
  }
  return labels;
}

function dailyAverage(records, dateStr, field) {
  const matches = records.filter((r) => r.date === dateStr && r[field] != null);
  if (matches.length === 0) return null;
  const sum = matches.reduce((acc, r) => acc + Number(r[field]), 0);
  return Math.round((sum / matches.length) * 10) / 10;
}

function dailySum(records, dateStr, field) {
  const matches = records.filter((r) => r.date === dateStr && r[field] != null);
  if (matches.length === 0) return null;
  return matches.reduce((acc, r) => acc + Number(r[field]), 0);
}

// 体重は水分で日々±1kg動くため、生の折れ線では増減が読めない。
// 各日について「その日を末尾とする7日間」の平均を出し、トレンドだけを見る。
function movingAverage(series, window) {
  return series.map((_, i) => {
    const slice = series.slice(Math.max(0, i - window + 1), i + 1).filter((v) => v != null);
    if (slice.length === 0) return null;
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    return Math.round(avg * 100) / 100;
  });
}

// ---------- ダッシュボード ----------

const chartInstances = {};

function chartColors() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return {
    text: dark ? "#9aa2ad" : "#5c6470",
    grid: dark ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.06)",
  };
}

function drawChart(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (chartInstances[canvasId]) chartInstances[canvasId].destroy();

  const c = chartColors();
  const axis = (extra) => ({
    ticks: { color: c.text, font: { size: 10 }, maxTicksLimit: 5 },
    grid: { color: c.grid },
    ...extra,
  });

  const base = {
    responsive: true,
    maintainAspectRatio: false,
    spanGaps: true,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { boxWidth: 10, font: { size: 11 }, color: c.text } },
    },
    scales: {
      x: axis({
        ticks: {
          color: c.text,
          font: { size: 10 },
          maxTicksLimit: 6,
          // ラベルは YYYY-MM-DD なので、狭い画面では MM-DD だけ出す
          callback(v) {
            const label = this.getLabelForValue(v);
            return label ? label.slice(5) : label;
          },
        },
      }),
      y: axis({ beginAtZero: false }),
    },
  };

  // 呼び出し側の options は scales だけ1段深くマージする（x軸の書式を失わないため）
  const custom = config.options || {};
  const scales = { ...base.scales };
  for (const [key, value] of Object.entries(custom.scales || {})) {
    scales[key] = { ...(base.scales[key] || axis({})), ...value };
  }
  config.options = { ...base, ...custom, scales };

  chartInstances[canvasId] = new Chart(canvas, config);
}

function renderTodayCard() {
  const today = todayStr();
  document.getElementById("todayDate").textContent = new Date().toLocaleDateString("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });

  const weightToday = dailyAverage(Storage.load("weight"), today, "weight");
  const wEl = document.getElementById("todayWeight");
  wEl.textContent = weightToday != null ? `${weightToday} kg` : "未記録";
  wEl.classList.toggle("empty", weightToday == null);
  wEl.closest(".today-slot").classList.toggle("filled", weightToday != null);

  const calToday = dailySum(Storage.load("meals"), today, "calories");
  const cEl = document.getElementById("todayCalories");
  cEl.textContent = calToday != null ? `${calToday}` : "未記録";
  cEl.classList.toggle("empty", calToday == null);
  cEl.closest(".today-slot").classList.toggle("filled", calToday != null);

  const hint = document.getElementById("todayHint");
  if (weightToday == null) {
    hint.textContent = "まずは体重だけでも記録しましょう。";
  } else if (settings.calorieTarget && calToday != null) {
    const diff = settings.calorieTarget - calToday;
    hint.textContent =
      diff >= 0 ? `目標まであと ${diff} kcal` : `目標を ${Math.abs(diff)} kcal 超えています`;
  } else {
    hint.textContent = "今日の記録は完了です。";
  }
}

function renderGoalCard() {
  const records = Storage.load("weight");
  const latest = records.find((r) => typeof r.weight === "number");
  const first = [...records].reverse().find((r) => typeof r.weight === "number");

  const curEl = document.getElementById("goalCurrent");
  const tgtEl = document.getElementById("goalTarget");
  const remEl = document.getElementById("goalRemain");
  const note = document.getElementById("goalNote");
  const fill = document.getElementById("goalBarFill");

  curEl.textContent = latest ? `${latest.weight}` : "—";
  tgtEl.textContent = settings.targetWeight ? `${settings.targetWeight}` : "—";

  if (!latest || !settings.targetWeight) {
    remEl.textContent = "—";
    remEl.className = "goal-value";
    fill.style.width = "0%";
    note.textContent = settings.targetWeight
      ? "体重を記録すると進捗が表示されます。"
      : "目標体重は「その他」タブで設定できます。";
    return;
  }

  const remain = Math.round((latest.weight - settings.targetWeight) * 10) / 10;
  remEl.textContent = remain > 0 ? `${remain}` : "達成";
  remEl.className = `goal-value ${remain > 0 ? "pos" : "done"}`;

  const startWeight = first ? first.weight : latest.weight;
  const totalGap = startWeight - settings.targetWeight;
  const progress = totalGap > 0 ? ((startWeight - latest.weight) / totalGap) * 100 : remain <= 0 ? 100 : 0;
  fill.style.width = `${Math.max(0, Math.min(100, progress))}%`;

  const diffFromStart = Math.round((latest.weight - startWeight) * 10) / 10;
  note.textContent =
    diffFromStart === 0
      ? `開始時 ${startWeight} kg から変化なし`
      : `開始時 ${startWeight} kg から ${diffFromStart > 0 ? "+" : ""}${diffFromStart} kg`;
}

function renderDashboard() {
  renderTodayCard();
  renderGoalCard();

  const days = parseInt(document.getElementById("rangeSelect").value, 10);
  const labels = dateRangeLabels(days);

  if (typeof Chart === "undefined") {
    document.getElementById("noChartLibNotice").hidden = false;
    return;
  }
  document.getElementById("noChartLibNotice").hidden = true;

  const weightRecords = Storage.load("weight");
  const weightSeries = labels.map((d) => dailyAverage(weightRecords, d, "weight"));
  drawChart("chartWeight", {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "実測",
          data: weightSeries,
          borderColor: "rgba(47,125,95,.35)",
          backgroundColor: "rgba(47,125,95,.35)",
          borderWidth: 1,
          pointRadius: 2,
        },
        {
          label: "7日平均",
          data: movingAverage(weightSeries, 7),
          borderColor: "#1a7a5a",
          backgroundColor: "#1a7a5a",
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.25,
        },
      ],
    },
  });

  const mealRecords = Storage.load("meals");
  const calorieDatasets = [
    {
      label: "摂取カロリー",
      data: labels.map((d) => dailySum(mealRecords, d, "calories")),
      backgroundColor: "#3b6bc9",
      borderColor: "#3b6bc9",
    },
  ];
  if (settings.calorieTarget) {
    calorieDatasets.push({
      type: "line",
      label: "目標",
      data: labels.map(() => settings.calorieTarget),
      borderColor: "#e08a2e",
      borderDash: [5, 4],
      borderWidth: 2,
      pointRadius: 0,
    });
  }
  drawChart("chartCalories", {
    type: "bar",
    data: { labels, datasets: calorieDatasets },
    options: { scales: { y: { beginAtZero: true } } },
  });

  const exerciseRecords = Storage.load("exercise");
  drawChart("chartExercise", {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "運動時間 (分)",
          data: labels.map((d) => dailySum(exerciseRecords, d, "duration")),
          borderColor: "#8e44ad",
          backgroundColor: "#8e44ad",
          pointRadius: 2,
        },
        {
          label: "歩数",
          data: labels.map((d) => dailySum(exerciseRecords, d, "steps")),
          borderColor: "#16a085",
          backgroundColor: "#16a085",
          pointRadius: 2,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      scales: {
        y: { beginAtZero: true, ticks: { maxTicksLimit: 5 } },
        y1: { position: "right", beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { maxTicksLimit: 5 } },
      },
    },
  });

  const vitalsRecords = Storage.load("vitals");
  drawChart("chartSleep", {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "睡眠時間 (h)",
          data: labels.map((d) => dailyAverage(vitalsRecords, d, "sleepHours")),
          borderColor: "#34495e",
          backgroundColor: "#34495e",
          pointRadius: 2,
        },
      ],
    },
  });
}

document.getElementById("rangeSelect").addEventListener("change", renderDashboard);

// ---------- 設定 ----------

function fillSettingsForm() {
  const t = document.getElementById("setTargetWeight");
  const c = document.getElementById("setCalorieTarget");
  const tok = document.getElementById("setGistToken");
  const gid = document.getElementById("setGistId");
  if (t) t.value = settings.targetWeight ?? "";
  if (c) c.value = settings.calorieTarget ?? "";
  if (tok) tok.value = settings.gistToken || "";
  if (gid) gid.value = settings.gistId || "";
}

document.getElementById("saveSettingsBtn")?.addEventListener("click", () => {
  const t = parseFloat(document.getElementById("setTargetWeight").value);
  const c = parseFloat(document.getElementById("setCalorieTarget").value);
  saveSettings({
    targetWeight: isNaN(t) ? null : t,
    calorieTarget: isNaN(c) ? null : c,
  });
  renderDashboard();
  scheduleBackup();
  flash("保存しました");
});

document.getElementById("gistConnectBtn")?.addEventListener("click", gistConnect);
document.getElementById("gistRestoreBtn")?.addEventListener("click", gistRestore);

// ---------- エクスポート / インポート ----------

document.getElementById("exportBtn")?.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(buildPayload(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `health-tracker-export-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("importInput")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    mergePayload(JSON.parse(await file.text()));
    refreshAll();
    scheduleBackup();
    alert("インポートが完了しました。");
  } catch {
    alert("インポートに失敗しました。ファイル形式を確認してください。");
  } finally {
    e.target.value = "";
  }
});

// ---------- 初期化 ----------

function refreshAll() {
  for (const category of CATEGORIES) renderTable(category);
  renderFoodTiles();
  updateWeightHint();
  fillSettingsForm();
  renderDashboard();
}

async function initViewMode() {
  document.body.classList.add("view-mode");
  const banner = document.createElement("div");
  banner.className = "view-banner";
  banner.textContent = "閲覧専用モード（このモードでは記録の追加・変更はできません）";
  document.body.insertBefore(banner, document.getElementById("main"));

  const token = settings.gistToken || prompt("GitHubアクセストークン（gist権限）を入力してください");
  const gistId = settings.gistId || prompt("Gist ID を入力してください");
  if (!token || !gistId) {
    banner.textContent = "トークンとGist IDが必要です。ページを再読み込みして入力してください。";
    return;
  }
  saveSettings({ gistToken: token, gistId });
  try {
    setSyncStatus("読込中…");
    remoteData = await fetchGistPayload(token, gistId);
    if (remoteData.foods) foodDb = normalizeFoodDb(remoteData.foods);
    if (remoteData.settings) settings = { ...settings, ...remoteData.settings };
    setSyncStatus("Gistから読込済み");
  } catch (err) {
    setSyncStatus("読込エラー", true);
    banner.textContent = `Gistを読み込めませんでした: ${err.message}`;
  }
  refreshAll();
}

function init() {
  document.getElementById("versionNote").textContent = `v${APP_VERSION}`;
  fillSettingsForm();
  updateWeightHint();

  if (VIEW_MODE) {
    initViewMode();
    return;
  }

  applyHashRoute();
  renderDashboard();

  if (settings.gistToken && settings.gistId) {
    setSyncStatus(
      settings.lastBackupAt
        ? `同期 ${new Date(settings.lastBackupAt).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })}`
        : "同期待ち"
    );
  } else {
    setSyncStatus("バックアップ未設定");
  }
}

if (typeof Chart === "undefined") {
  window.addEventListener("load", init);
} else {
  init();
}

// ---------- Service Worker ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          // 既存のSWがある状態で installed になった＝新バージョンが待機中
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            const bar = document.getElementById("updateBar");
            bar.hidden = false;
            document.getElementById("updateBtn").onclick = () => {
              sw.postMessage({ type: "SKIP_WAITING" });
            };
          }
        });
      });
    });

    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  });
}
