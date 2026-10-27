// ツールバーのポップアップ。設定の切り替えとモデルの読み込み状態の表示を行う

import type { Tabs } from "webextension-polyfill";
import type { ClearCacheRequest, ContentCommand, ErrorResponse, LoadModelRequest } from "./shared/messages";
import {
  loadModelStatus, loadSettings, onModelStatusChanged, onSettingsChanged, saveSettings,
  type Engine, type ModelStatus, type Settings,
} from "./shared/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const enabledEl = $<HTMLInputElement>("enabled");
const emojiEl = $<HTMLInputElement>("emoji");
const engineEls = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="engine"]'));
const modelIdEl = $<HTMLParagraphElement>("model-id");
const progressBar = $<HTMLDivElement>("progress-bar");
const modelStatusEl = $<HTMLParagraphElement>("model-status");
const loadBtn = $<HTMLButtonElement>("load-btn");
const unloadBtn = $<HTMLButtonElement>("unload-btn");
const rerunBtn = $<HTMLButtonElement>("rerun-btn");

let settings: Settings;

function renderSettings(s: Settings): void {
  enabledEl.checked = s.enabled;
  emojiEl.checked = s.emoji;
  engineEls.forEach((el) => (el.checked = el.value === s.engine));
  modelIdEl.textContent = s.modelId;
}

function renderStatus(st: ModelStatus): void {
  progressBar.style.width = `${Math.round((st.progress ?? 0) * 100)}%`;
  modelStatusEl.textContent = st.text || st.state;
  modelStatusEl.className = "status" + (st.state === "ready" ? " ok" : st.state === "error" ? " error" : "");
  loadBtn.disabled = st.state === "loading" || st.state === "ready";
  loadBtn.textContent = st.state === "ready" ? "読み込み済み" : st.state === "loading" ? "読み込み中…" : "モデルを読み込む";
}

async function activeTab(): Promise<Tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init(): Promise<void> {
  $<HTMLSpanElement>("version").textContent = "v" + browser.runtime.getManifest().version;
  settings = await loadSettings();
  renderSettings(settings);
  renderStatus(await loadModelStatus());

  onSettingsChanged((s) => {
    settings = s;
    renderSettings(s);
  });
  onModelStatusChanged(renderStatus);

  enabledEl.addEventListener("change", async () => {
    await saveSettings({ enabled: enabledEl.checked });
    if (enabledEl.checked && settings.engine === "llm") void loadModel();
  });
  emojiEl.addEventListener("change", () => saveSettings({ emoji: emojiEl.checked }));
  engineEls.forEach((el) =>
    el.addEventListener("change", async () => {
      if (!el.checked) return;
      await saveSettings({ engine: el.value as Engine });
      if (el.value === "llm") void loadModel();
    }),
  );

  loadBtn.addEventListener("click", () => void loadModel());
  unloadBtn.addEventListener("click", async () => {
    const req: ClearCacheRequest = { target: "background", type: "clearCache", modelId: settings.modelId };
    const res = (await browser.runtime.sendMessage(req)) as ErrorResponse | { ok: true };
    if (!res.ok) renderStatus({ state: "error", modelId: settings.modelId, progress: 0, text: res.error });
  });
  rerunBtn.addEventListener("click", async () => {
    const tab = await activeTab();
    if (!tab?.id) return;
    const cmd: ContentCommand = { type: "rerun" };
    try {
      await browser.tabs.sendMessage(tab.id, cmd);
    } catch {
      modelStatusEl.textContent = "このページでは動作しません(拡張機能の再読み込み後はページも更新してください)";
      modelStatusEl.className = "status error";
    }
  });
}

async function loadModel(): Promise<void> {
  const req: LoadModelRequest = { target: "background", type: "loadModel", modelId: settings.modelId };
  const res = (await browser.runtime.sendMessage(req)) as ErrorResponse | { ok: true } | undefined;
  if (res && !res.ok) renderStatus({ state: "error", modelId: settings.modelId, progress: 0, text: res.error });
}

void init();
