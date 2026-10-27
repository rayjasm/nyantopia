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

/** 素の Qwen3-0.6B(WebLLM の組み込み設定にあるもの) */
export const BASE_MODEL_ID = "Qwen3-0.6B-q4f16_1-MLC";
/** 語尾の言い換えを学習させたモデル(nyantopia-model で作成。重みだけ差し替え、wasm は BASE と共通) */
export const TUNED_MODEL_ID = "nyantopia-Qwen3-0.6B-q4f16_1-MLC";
/** 独自モデルの設定。model は重みの置き場所、base は WebLLM の組み込み設定のうち流用する元 */
export const CUSTOM_MODELS: Record<string, { base: string; model: string }> = {
  [TUNED_MODEL_ID]: { base: BASE_MODEL_ID, model: "https://huggingface.co/jasmray/nyantopia-Qwen3-0.6B-q4f16_1-MLC" },
};
export function isTunedModel(modelId: string): boolean {
  return modelId in CUSTOM_MODELS;
}
export const DEFAULT_MODEL_ID = TUNED_MODEL_ID;

/** 開発用: 独自モデルの重みをローカルサーバーなどから取る(browser.storage.local の devModelUrl) */
export async function loadDevModelUrl(): Promise<string | undefined> {
  const got = await browser.storage.local.get("devModelUrl");
  const url = got.devModelUrl;
  return typeof url === "string" && url ? url : undefined;
}

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

/** 以前のバージョンが保存していた「今日癒した言葉」の件数を消す(v0.3.2 で機能を削除) */
export async function removeLegacyCounts(): Promise<void> {
  await browser.storage.local.remove("counts");
}
