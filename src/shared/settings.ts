// 拡張機能の設定。browser.storage.local に保存する

export type Engine = "llm" | "rule";

export interface Settings {
  /** ねこ語変換の ON/OFF */
  enabled: boolean;
  /** 変換エンジン。llm はブラウザ内 LLM、rule は正規表現による簡易変換 */
  engine: Engine;
  /** 文末に 🐈 🐱 を付けるか */
  emoji: boolean;
  /** WebLLM のモデル ID */
  modelId: string;
}

export const DEFAULT_MODEL_ID = "Qwen3-0.6B-q4f16_1-MLC";

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  engine: "llm",
  emoji: true,
  modelId: DEFAULT_MODEL_ID,
};

const KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const got = await browser.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(got[KEY] ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) {
      cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue ?? {}) });
    }
  });
}

/** モデルの読み込み状態。background が書き、popup が読む(ブラウザを閉じると消える session 領域) */
export type ModelState = "idle" | "loading" | "ready" | "error";

export interface ModelStatus {
  state: ModelState;
  modelId: string;
  progress: number;
  text: string;
}

const STATUS_KEY = "modelStatus";

export async function loadModelStatus(): Promise<ModelStatus> {
  const got = await browser.storage.session.get(STATUS_KEY);
  return (got[STATUS_KEY] as ModelStatus | undefined) ?? { state: "idle", modelId: "", progress: 0, text: "" };
}

export async function saveModelStatus(status: ModelStatus): Promise<void> {
  await browser.storage.session.set({ [STATUS_KEY]: status });
}

export function onModelStatusChanged(cb: (s: ModelStatus) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[STATUS_KEY]) {
      cb(changes[STATUS_KEY].newValue as ModelStatus);
    }
  });
}

/** 変換した文の累計(日付ごと) */
const COUNT_KEY = "counts";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function addCount(n: number): Promise<number> {
  const got = await browser.storage.local.get(COUNT_KEY);
  const counts = (got[COUNT_KEY] as Record<string, number> | undefined) ?? {};
  const key = todayKey();
  counts[key] = (counts[key] ?? 0) + n;
  await browser.storage.local.set({ [COUNT_KEY]: counts });
  return counts[key];
}

export async function getTodayCount(): Promise<number> {
  const got = await browser.storage.local.get(COUNT_KEY);
  const counts = (got[COUNT_KEY] as Record<string, number> | undefined) ?? {};
  return counts[todayKey()] ?? 0;
}
