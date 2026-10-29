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

/** ねこ語モデル(llm-jp-3-150m-instruct3 に語尾の言い換えを学習させたもの。nyantopia-model で作成) */
export const LLMJP_MODEL_ID = "nyantopia-llm-jp-3-150m-q4f16_1-MLC";

/** モデルの定義。model は重みの置き場所、lib は同梱する実行用 wasm(public/wasm/)と WebLLM に伝える必要メモリの目安(MB) */
export interface ModelDef {
  model: string;
  lib: { file: string; vramMB: number };
}

export const MODELS: Record<string, ModelDef> = {
  [LLMJP_MODEL_ID]: {
    model: "https://huggingface.co/jasmray/nyantopia-llm-jp-3-150m-q4f16_1-MLC",
    // 重み 86MB + KV キャッシュなど。wasm は nyantopia-model の scripts/compile_webgpu.sh で作ったもの
    lib: { file: "nyantopia-llm-jp-3-150m-q4f16_1_cs1k-webgpu.wasm", vramMB: 300 },
  },
};
export const DEFAULT_MODEL_ID = LLMJP_MODEL_ID;

/** 以前のバージョン(〜0.3.2)が使っていた Qwen3 のモデル。初回起動時にキャッシュした重みを消す */
export const LEGACY_MODELS = [
  { model_id: "Qwen3-0.6B-q4f16_1-MLC", model: "https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_1-MLC" },
  { model_id: "nyantopia-Qwen3-0.6B-q4f16_1-MLC", model: "https://huggingface.co/jasmray/nyantopia-Qwen3-0.6B-q4f16_1-MLC" },
];

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

/** 保存された設定に既定値を補う。以前のバージョンのモデル ID が残っていれば今の既定に置き換える */
function withDefaults(stored: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS, ...((stored ?? {}) as Partial<Settings>) };
  if (!(s.modelId in MODELS)) s.modelId = DEFAULT_MODEL_ID;
  return s;
}

export async function loadSettings(): Promise<Settings> {
  const got = await browser.storage.local.get(KEY);
  return withDefaults(got[KEY]);
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
      cb(withDefaults(changes[KEY].newValue));
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

/**
 * モデルごとに、最後に読み込んだ重みのコミット ID(Hugging Face の X-Repo-Commit)。
 * WebLLM は URL をキーに重みをキャッシュするので、同じファイル名で上げ直した重みはそのままでは届かない。
 * background がモデルを読み込む前にこの値と比べ、変わっていれば古いキャッシュを捨てる
 */
const REVISION_KEY = "modelRevisions";

export async function loadModelRevision(modelId: string): Promise<string | undefined> {
  const got = await browser.storage.local.get(REVISION_KEY);
  const revs = (got[REVISION_KEY] ?? {}) as Record<string, string>;
  return revs[modelId];
}

export async function saveModelRevision(modelId: string, revision: string | undefined): Promise<void> {
  const got = await browser.storage.local.get(REVISION_KEY);
  const revs = { ...((got[REVISION_KEY] ?? {}) as Record<string, string>) };
  if (revision) revs[modelId] = revision;
  else delete revs[modelId];
  await browser.storage.local.set({ [REVISION_KEY]: revs });
}

/** 以前のバージョンが保存していた「今日癒した言葉」の件数を消す(v0.3.2 で機能を削除) */
export async function removeLegacyCounts(): Promise<void> {
  await browser.storage.local.remove("counts");
}
