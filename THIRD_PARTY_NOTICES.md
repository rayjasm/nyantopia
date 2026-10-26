# サードパーティのライセンス表記

にゃんとぴあ本体のコードは [MIT ライセンス](LICENSE) です。
このファイルは、にゃんとぴあが利用している外部のソフトウェア、モデル、素材と、それぞれのライセンスをまとめたものです。

## 拡張機能に同梱しているライブラリ

ビルド時に `dist/background.js` などへバンドルされ、拡張機能と一緒に配布されます。

| ソフトウェア | ライセンス | 著作権者 / 提供元 |
| --- | --- | --- |
| [WebLLM](https://github.com/mlc-ai/web-llm) (`@mlc-ai/web-llm`) | Apache License 2.0 | MLC LLM Contributors |
| WebLLM に同梱されている TVM Web Runtime、web-tokenizers、WebXGrammar | Apache License 2.0 | Apache Software Foundation / MLC LLM Contributors |
| [loglevel](https://github.com/pimterry/loglevel) | MIT License | Tim Perry |
| [tslib](https://github.com/microsoft/tslib)(WebLLM に同梱) | 0BSD | Microsoft Corporation |

ライセンス全文は [licenses/](licenses/) にあります。

- [licenses/web-llm-LICENSE.txt](licenses/web-llm-LICENSE.txt): Apache License 2.0
- [licenses/loglevel-LICENSE.txt](licenses/loglevel-LICENSE.txt): MIT License

## 実行時にダウンロードされるモデル

拡張機能には含まれず、利用者のブラウザが Hugging Face から直接ダウンロードします。

| モデル | ライセンス | 提供元 |
| --- | --- | --- |
| [nyantopia-Qwen3-0.6B-q4f16_1-MLC](https://huggingface.co/jasmray/nyantopia-Qwen3-0.6B-q4f16_1-MLC)([Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B) をねこ語向けに LoRA で学習させ、q4f16_1 に量子化したもの) | Apache License 2.0(ベースモデルと同じ) | ベースモデル: Alibaba Cloud / Qwen Team。学習: にゃんとぴあ |

## 画像素材

| 素材 | 利用条件 | 提供元 |
| --- | --- | --- |
| アイコンの肉球イラスト(`public/icons/`) | [いらすとや 利用規約](https://www.irasutoya.com/p/terms.html)の範囲で利用。著作権は作者に帰属 | [いらすとや](https://www.irasutoya.com/)(みふねたかし) |

いらすとやの素材は、にゃんとぴあのコードのライセンス(MIT)の対象外です。再利用する場合はいらすとやの利用規約に従ってください。

## 移植したコード

- プロンプトと後処理の一部は [nyanyaku](https://github.com/rayjasm/nyanyaku)(MIT License、同じ作者)から移植しています。

## 開発時のみ使用するもの(配布物には含まれません)

| ソフトウェア | ライセンス |
| --- | --- |
| [esbuild](https://esbuild.github.io/) | MIT License |
| [TypeScript](https://www.typescriptlang.org/) | Apache License 2.0 |
| [@types/webextension-polyfill](https://github.com/DefinitelyTyped/DefinitelyTyped) | MIT License |
| [web-ext](https://github.com/mozilla/web-ext) | Mozilla Public License 2.0 |
| [selenium-webdriver](https://www.selenium.dev/) | Apache License 2.0 |
