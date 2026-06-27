/** 偏好设置：快捷键录制、表单管理、关闭确认弹窗 */
import { appState } from "./state.js";
import { normalizeCloseAction, alertRequestFailed } from "./utils.js";
import { invoke } from "@tauri-apps/api/core";

// ── 快捷键录制 ──

const HOTKEY_MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const CODE_TO_MAIN_KEY = {
  KeyA: "A", KeyB: "B", KeyC: "C", KeyD: "D", KeyE: "E",
  KeyF: "F", KeyG: "G", KeyH: "H", KeyI: "I", KeyJ: "J",
  KeyK: "K", KeyL: "L", KeyM: "M", KeyN: "N", KeyO: "O",
  KeyP: "P", KeyQ: "Q", KeyR: "R", KeyS: "S", KeyT: "T",
  KeyU: "U", KeyV: "V", KeyW: "W", KeyX: "X", KeyY: "Y",
  KeyZ: "Z",
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
  Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  F1: "F1", F2: "F2", F3: "F3", F4: "F4", F5: "F5",
  F6: "F6", F7: "F7", F8: "F8", F9: "F9", F10: "F10",
  F11: "F11", F12: "F12",
  Space: "Space", Enter: "Return", Escape: "Escape",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Insert: "Insert", Delete: "Delete", Backspace: "Backspace", Tab: "Tab",
};

function codeToHotkeyMainKey(code) {
  return CODE_TO_MAIN_KEY[code] || null;
}

function accelFromKeyboardEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (!HOTKEY_MODIFIER_CODES.has(e.code)) {
    const mainKey = codeToHotkeyMainKey(e.code);
    if (mainKey) parts.push(mainKey);
  }
  return parts.join("+");
}

function formatAccelDisplay(accel) {
  if (!accel) return "未设置";
  return accel
    .replace(/CommandOrControl/g, "Ctrl")
    .replace(/\+/g, " + ");
}

// ── 快捷键状态 UI ──

function syncHotkeyButtonUi(btn, accel) {
  if (!btn) return;
  const display = formatAccelDisplay(accel);
  btn.textContent = display;
  btn.title = accel ? `快捷键：${accel}` : "点击录制快捷键";
}

function hotkeyStatusSetConflict(el, message) {
  if (!el) return;
  el.textContent = message;
  el.style.color = "#ef4444";
}

function renderHotkeyStatusOk(el, label) {
  if (!el) return;
  el.textContent = label || "✓ 已保存";
  el.style.color = "";
}

function renderHotkeyStatusFromReport(el, report) {
  if (!el) return;
  if (!report) {
    el.textContent = "";
    return;
  }
  const conflicts = report.conflicts || [];
  if (conflicts.length > 0) {
    hotkeyStatusSetConflict(el, `冲突：${conflicts.map((c) => c.accel || c).join(", ")}`);
  } else {
    renderHotkeyStatusOk(el);
  }
}

// ── 快捷键录制状态机 ──

let hotkeyCaptureTarget = null;
let hotkeyCaptureAbort = null;

function startHotkeyCapture(btn, statusEl) {
  stopHotkeyCapture();
  hotkeyCaptureTarget = { btn, statusEl };
  btn.textContent = "请按下快捷键…";
  btn.classList.add("is-capturing");
  if (statusEl) statusEl.textContent = "";

  const onKeyDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (e.code === "Escape") {
      stopHotkeyCapture();
      return;
    }
    const accel = accelFromKeyboardEvent(e);
    if (!accel || accel === "CommandOrControl" || accel === "Alt" || accel === "Shift") {
      return;
    }
    btn.dataset.accel = accel;
    syncHotkeyButtonUi(btn, accel);
    stopHotkeyCapture();
  };

  const controller = new AbortController();
  document.addEventListener("keydown", onKeyDown, {
    capture: true,
    signal: controller.signal,
  });
  hotkeyCaptureAbort = controller;
}

function stopHotkeyCapture() {
  if (hotkeyCaptureAbort) {
    hotkeyCaptureAbort.abort();
    hotkeyCaptureAbort = null;
  }
  if (hotkeyCaptureTarget) {
    hotkeyCaptureTarget.btn.classList.remove("is-capturing");
    hotkeyCaptureTarget = null;
  }
}

function onHotkeyCaptureKeydown(btn, statusEl) {
  if (hotkeyCaptureTarget) {
    stopHotkeyCapture();
  } else {
    startHotkeyCapture(btn, statusEl);
  }
}

// ── 设置表单 ──

async function populateFontSelect(selectEl) {
  if (!selectEl) return;
  let fonts = [];
  try {
    if (typeof window.queryLocalFonts === "function") {
      const fontHandles = await window.queryLocalFonts();
      const familySet = new Set();
      for (const handle of fontHandles) {
        familySet.add(handle.family);
      }
      fonts = [...familySet].sort((a, b) => a.localeCompare(b));
    }
  } catch (e) {
    console.warn("queryLocalFonts unavailable:", e);
  }
  if (fonts.length === 0) {
    fonts = [
      "Segoe UI", "Microsoft YaHei UI", "PingFang SC",
      "Noto Sans SC", "Noto Sans CJK SC", "Arial", "Helvetica",
      "Times New Roman", "Georgia", "Consolas", "Courier New",
      "system-ui", "sans-serif", "serif", "monospace",
    ];
  }
  const current = selectEl.value;
  while (selectEl.options.length > 1) selectEl.remove(1);
  for (const name of fonts) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    selectEl.appendChild(opt);
  }
  if (current && [...selectEl.options].some((o) => o.value === current)) {
    selectEl.value = current;
  }
}

export function fillSettingsFormFromSettings(s) {
  if (!s) return;
  const action = normalizeCloseAction(s.main_window_close_action ?? s.mainWindowCloseAction);
  const base = s.desktop_lyrics_color_base ?? s.desktopLyricsColorBase ?? "#ffffff";
  const highlight = s.desktop_lyrics_color_highlight ?? s.desktopLyricsColorHighlight ?? "#ffb7d4";
  const neteaseApiBase = s.netease_api_base ?? s.neteaseApiBase ?? "";

  const closeSelect = document.getElementById("setting-close-action");
  if (closeSelect) closeSelect.value = action;
  const baseInput = document.getElementById("setting-ly-base");
  if (baseInput) baseInput.value = base;
  const hlInput = document.getElementById("setting-ly-highlight");
  if (hlInput) hlInput.value = highlight;
  const apiInput = document.getElementById("setting-netease-api-base");
  if (apiInput) apiInput.value = neteaseApiBase;
  const fontSelect = document.getElementById("setting-ly-font");
  if (fontSelect) fontSelect.value = s.desktop_lyrics_font_family ?? s.desktopLyricsFontFamily ?? "";

  // 代理：前端只读 `proxy.{enabled,url,no_proxy}`（snake_case 由 Tauri 直接序列化而来）。
  const proxyObj = s.proxy ?? null;
  const proxyEnabled = Boolean(proxyObj?.enabled ?? proxyObj?.enabled);
  const proxyUrl = String(proxyObj?.url ?? "").trim();
  const proxyNoProxy = String(proxyObj?.no_proxy ?? proxyObj?.noProxy ?? "").trim();
  const proxyEnabledEl = document.getElementById("setting-proxy-enabled");
  if (proxyEnabledEl) proxyEnabledEl.checked = proxyEnabled;
  const proxyUrlEl = document.getElementById("setting-proxy-url");
  if (proxyUrlEl) proxyUrlEl.value = proxyUrl;
  const proxyNoProxyEl = document.getElementById("setting-proxy-no-proxy");
  if (proxyNoProxyEl) proxyNoProxyEl.value = proxyNoProxy;

  fillHotkeysFormFromSettings(s);
  syncSettingsFormBaselineFromDom();
  updateSettingsSaveButtonState();
}

function fillHotkeysFormFromSettings(s) {
  const hotkeys = s.global_hotkeys ?? s.globalHotkeys ?? {};
  const defs = [
    { id: "hk-play-pause", statusId: "hk-status-play-pause", key: "play_pause" },
    { id: "hk-prev", statusId: "hk-status-prev", key: "prev" },
    { id: "hk-next", statusId: "hk-status-next", key: "next" },
    { id: "hk-vol-up", statusId: "hk-status-vol-up", key: "volume_up" },
    { id: "hk-vol-down", statusId: "hk-status-vol-down", key: "volume_down" },
  ];
  for (const def of defs) {
    const btn = document.getElementById(def.id);
    const accel = hotkeys[def.key] || "";
    if (btn) {
      btn.dataset.accel = accel;
      syncHotkeyButtonUi(btn, accel);
    }
    const statusEl = document.getElementById(def.statusId);
    if (statusEl) statusEl.textContent = "";
  }
}

function getSettingsFormValues() {
  const closeSelect = document.getElementById("setting-close-action");
  const action = closeSelect ? closeSelect.value : "ask";
  const base = document.getElementById("setting-ly-base")?.value || "#ffffff";
  const highlight = document.getElementById("setting-ly-highlight")?.value || "#ffb7d4";
  const neteaseApiBase = document.getElementById("setting-netease-api-base")?.value?.trim() || "";
  const fontFamily = document.getElementById("setting-ly-font")?.value || "";
  const proxyEnabled = document.getElementById("setting-proxy-enabled")?.checked ?? false;
  const proxyUrl = document.getElementById("setting-proxy-url")?.value?.trim() || "";
  const proxyNoProxy = document.getElementById("setting-proxy-no-proxy")?.value?.trim() || "";

  const hotkeys = {};
  const defs = [
    { id: "hk-play-pause", key: "play_pause" },
    { id: "hk-prev", key: "prev" },
    { id: "hk-next", key: "next" },
    { id: "hk-vol-up", key: "volume_up" },
    { id: "hk-vol-down", key: "volume_down" },
  ];
  for (const def of defs) {
    const btn = document.getElementById(def.id);
    const accel = btn?.dataset.accel || "";
    if (accel) hotkeys[def.key] = accel;
  }

  return { action, base, highlight, neteaseApiBase, fontFamily, hotkeys, proxyEnabled, proxyUrl, proxyNoProxy };
}

function settingsFormIsDirty() {
  const cur = getSettingsFormValues();
  const bl = appState.settingsFormBaseline;
  if (cur.action !== bl.action) return true;
  if (cur.base !== bl.base) return true;
  if (cur.highlight !== bl.highlight) return true;
  if (cur.neteaseApiBase !== bl.neteaseApiBase) return true;
  if (cur.fontFamily !== bl.fontFamily) return true;
  if (cur.proxyEnabled !== bl.proxyEnabled) return true;
  if (cur.proxyUrl !== bl.proxyUrl) return true;
  if (cur.proxyNoProxy !== bl.proxyNoProxy) return true;
  const curSig = JSON.stringify(cur.hotkeys);
  return curSig !== bl.hotkeysSig;
}

function syncSettingsFormBaselineFromDom() {
  const cur = getSettingsFormValues();
  appState.settingsFormBaseline = {
    action: cur.action,
    base: cur.base,
    highlight: cur.highlight,
    neteaseApiBase: cur.neteaseApiBase,
    fontFamily: cur.fontFamily,
    hotkeysSig: JSON.stringify(cur.hotkeys),
    proxyEnabled: cur.proxyEnabled,
    proxyUrl: cur.proxyUrl,
    proxyNoProxy: cur.proxyNoProxy,
  };
}

function updateSettingsSaveButtonState() {
  const btn = document.getElementById("settings-save");
  if (!btn) return;
  btn.disabled = !settingsFormIsDirty();
}

// ── 关闭确认弹窗 ──

export function openCloseConfirmModal() {
  const modal = document.getElementById("close-confirm-modal");
  if (modal) modal.hidden = false;
}

function closeCloseConfirmModal() {
  const modal = document.getElementById("close-confirm-modal");
  if (modal) modal.hidden = true;
}

async function runCloseChoice(choice) {
  closeCloseConfirmModal();
  if (choice === "quit") {
    try {
      await invoke("quit_app");
    } catch (e) {
      alertRequestFailed(e, "close flow");
    }
    return;
  }
  if (choice === "tray") {
    try {
      await invoke("hide_main_window");
    } catch (e) {
      alertRequestFailed(e, "close flow");
    }
    return;
  }
}

// ── Wiring ──

export function wireSettingsFormDirtyTracking() {
  const inputs = document.querySelectorAll(
    '.settings-form #setting-close-action, #setting-ly-base, #setting-ly-highlight, #setting-netease-api-base, #setting-ly-font, #setting-proxy-enabled, #setting-proxy-url, #setting-proxy-no-proxy'
  );
  inputs.forEach((el) => {
    el.addEventListener("input", updateSettingsSaveButtonState);
    el.addEventListener("change", updateSettingsSaveButtonState);
  });
}

export function wireHotkeySettingsUi() {
  const defs = [
    { id: "hk-play-pause", statusId: "hk-status-play-pause", key: "play_pause" },
    { id: "hk-prev", statusId: "hk-status-prev", key: "prev" },
    { id: "hk-next", statusId: "hk-status-next", key: "next" },
    { id: "hk-vol-up", statusId: "hk-status-vol-up", key: "volume_up" },
    { id: "hk-vol-down", statusId: "hk-status-vol-down", key: "volume_down" },
  ];
  for (const def of defs) {
    const btn = document.getElementById(def.id);
    const statusEl = document.getElementById(def.statusId);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      onHotkeyCaptureKeydown(btn, statusEl);
    });
  }

  document.getElementById("btn-hotkey-clear-all")?.addEventListener("click", async () => {
    try {
      await invoke("save_settings", { patch: { global_hotkeys: {} } });
      fillHotkeysFormFromSettings({});
      for (const def of defs) {
        const statusEl = document.getElementById(def.statusId);
        renderHotkeyStatusOk(statusEl, "已清除");
      }
    } catch (e) {
      alertRequestFailed(e, "clear hotkeys");
    }
  });
}


// ── 代理生效状态 ──

function renderEffectiveProxyStatus() {
  const badge = document.getElementById("setting-proxy-source");
  if (!badge) return;
  const eff = appState.effectiveProxy || {};
  let label;
  if (eff.applied) {
    const where = eff.normalizedUrl || eff.redactedUrl || "(empty)";
    label = `生效中 · ${eff.source} · ${where}`;
    badge.classList.add("is-applied");
  } else {
    label = `未启用 · ${eff.source || "none"}`;
    badge.classList.remove("is-applied");
  }
  badge.textContent = label;
  badge.title = eff.redactedUrl
    ? `代理 URL：${eff.redactedUrl}\n来源：${eff.source}\nNO_PROXY：${eff.noProxy || "(空)"}`
    : `当前进程未启用代理（来源：${eff.source || "none"}）`;
}

async function refreshEffectiveProxy() {
  try {
    const status = await invoke("get_proxy_status");
    appState.effectiveProxy = status || appState.effectiveProxy;
  } catch (e) {
    console.warn("get_proxy_status failed:", e);
  }
  renderEffectiveProxyStatus();
}

export function wirePreferencesModals() {
  populateFontSelect(document.getElementById("setting-ly-font"));
  wireSettingsFormDirtyTracking();
  wireHotkeySettingsUi();
  renderEffectiveProxyStatus();
  void refreshEffectiveProxy();
  document.getElementById("btn-proxy-refresh")?.addEventListener("click", () => {
    void refreshEffectiveProxy();
  });

  document.getElementById("settings-save")?.addEventListener("click", async () => {
    const cur = getSettingsFormValues();
    try {
      await invoke("save_settings", {
        patch: {
          main_window_close_action: cur.action,
          desktop_lyrics_color_base: cur.base,
          desktop_lyrics_color_highlight: cur.highlight,
          desktop_lyrics_font_family: cur.fontFamily,
          netease_api_base: cur.neteaseApiBase,
          global_hotkeys: cur.hotkeys,
          proxy_enabled: cur.proxyEnabled,
          proxy_url: cur.proxyUrl,
          proxy_no_proxy: cur.proxyNoProxy,
        },
      });
      appState.mainWindowCloseAction = normalizeCloseAction(cur.action);
      syncSettingsFormBaselineFromDom();
      updateSettingsSaveButtonState();
      // 代理变更需重启；保存后立即拉一次最新 status 让 UI 提示用户。
      void refreshEffectiveProxy();
      for (const statusId of [
        "hk-status-play-pause",
        "hk-status-prev",
        "hk-status-next",
        "hk-status-vol-up",
        "hk-status-vol-down",
      ]) {
        const statusEl = document.getElementById(statusId);
        renderHotkeyStatusOk(statusEl);
      }
    } catch (e) {
      alertRequestFailed(e, "save_settings");
    }
  });

  // 关闭确认弹窗
  document.getElementById("close-choice-quit")?.addEventListener("click", () => runCloseChoice("quit"));
  document.getElementById("close-choice-tray")?.addEventListener("click", () => runCloseChoice("tray"));
  document.getElementById("close-choice-cancel")?.addEventListener("click", closeCloseConfirmModal);
}
