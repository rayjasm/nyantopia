// background / content / popup の間でやり取りするメッセージ型

import type { Engine, ModelStatus } from "./settings";

export type Target = "background";

/** content → background: テキストをねこ語に変換してほしい */
export interface ConvertRequest {
  target: "background";
  type: "convert";
  texts: string[];
  engine: Engine;
  emoji: boolean;
}

export interface ConvertResponse {
  ok: true;
  /** texts と同じ順序。変換できなかった要素は null */
  results: (string | null)[];
}

export interface ErrorResponse {
  ok: false;
  /** 利用者向けの説明 */
  error: string;
  /** 元のエラーメッセージ(調査用) */
  detail?: string;
}

/** popup → background: モデルを読み込む */
export interface LoadModelRequest {
  target: "background";
  type: "loadModel";
  modelId: string;
}

/** popup → background: キャッシュ削除 */
export interface ClearCacheRequest {
  target: "background";
  type: "clearCache";
  modelId: string;
}

/** 評価スクリプト → background: 直近の生成の統計を返す */
export interface StatsRequest {
  target: "background";
  type: "stats";
}

/** 評価スクリプト → background: 現在のモデルの読み込み状態を返す */
export interface ModelStatusRequest {
  target: "background";
  type: "modelStatus";
}

export interface ModelStatusResponse {
  ok: true;
  status: ModelStatus;
}

/** background → content: 再変換 or 元に戻す */
export interface ContentCommand {
  type: "rerun" | "restore";
}

export type BackgroundMessage = ConvertRequest | LoadModelRequest | ClearCacheRequest | StatsRequest | ModelStatusRequest;

export function isTargeted(msg: unknown, target: Target): msg is { target: Target; type: string } {
  return typeof msg === "object" && msg !== null && (msg as { target?: unknown }).target === target;
}
