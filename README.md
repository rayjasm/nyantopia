# にゃんとぴあ 🐾

「にゃんとぴあ」は、画面上の日本語をねこ語に変換するブラウザ拡張機能です。どんなにきつい言葉もねこ語に変換して、世界をちょっとやさしくします。

## 現在の機能

- **語尾のねこ語変換**: ページ内の日本語テキストの語尾を「にゃ」に変えます。
- **2 つの変換エンジン**
  - ねこ語モデル: ブラウザ内で小型 LLM(日本語専用の [llm-jp-3-150m-instruct3](https://huggingface.co/llm-jp/llm-jp-3-150m-instruct3) をねこ語向けに学習させた [nyantopia-llm-jp-3-150m](https://huggingface.co/jasmray/nyantopia-llm-jp-3-150m-q4f16_1-MLC))を [WebLLM](https://github.com/mlc-ai/web-llm) で動かして変換します。「二度と話しかけてくるな → 二度と話しかけてこないでにゃ」のように、命令や禁止のきつい語尾をやわらかく言い換えます。入力文はどこにも送信されません。
  - かんたん変換: 正規表現で語尾に「にゃ」を付けるだけの高速モード。モデルなしで動きます。
- **ON / OFF 切り替え**: ツールバーのポップアップからワンクリックで切り替えられます。OFF にすると元の文に戻ります。
- **文末の 🐈 🐱**: 文ごとにランダムに付けます(設定で無効化できます)。
- **後から追加されたテキストにも対応**: SPA などで動的に追加された文も変換します。

## 動作要件

- Firefox 142 以降
- ねこ語モデルを使う場合は WebGPU が有効なこと。空きメモリ 1GB 程度
  - Windows は Firefox 141 以降、macOS は Apple Silicon の Mac で Firefox 147 以降で標準で有効です
  - それ以外の環境では `about:config` の `dom.webgpu.enabled` を確認してください。WebGPU が使えない場合も「かんたん変換」は動きます
- 初回のみモデル(約 90MB)を Hugging Face からダウンロードします。2 回目以降はブラウザのキャッシュから読み込みます

## 仕組み

```
content.js (各ページ)  →  background.js (常駐バックグラウンドページ、WebLLM + WebGPU)
   テキストノード収集            メッセージの処理
   置換 / 復元                   llm-jp-3-150m で語尾変換、結果の後処理
```

- content script がページ内のテキストノードを集め、日本語を含むものだけを画面に近い順に変換します。リンクや強調などの行内要素をまたいだ文も 1 つの文として扱います(脚注番号、ルビの読み、コードは変換しません)。 ハッシュタグ(`#タグ`)だけの文字列は変換せず、文末に並ぶハッシュタグは「にゃ」と絵文字の後ろに残します。
- バックグラウンドページは常駐の通常のドキュメントなので、WebGPU が使え、読み込んだモデルをブラウザを閉じるまで保持できます。Manifest V3 のイベントページでは数十秒でアンロードされてしまうため、Manifest V2 を使っています。
- モデル実行用の wasm は拡張機能に同梱しています(addons.mozilla.org のポリシーで外部から実行コードを取得できないため)。wasm は WebLLM と同じ版の TVM(mlc-llm)でねこ語モデル用にコンパイルしたもので、重みと同じ Hugging Face のリポジトリの `lib/` に置いてあり、`npm run build` 時に `scripts/fetch-wasm.mjs` が `public/wasm/` にダウンロードします。モデルの重みだけを実行時に Hugging Face から取得します。
- WebLLM が JavaScript に埋め込んでいるトークナイザと文法エンジンの wasm は、ビルド時に `dist/wasm/` へ切り出しています(addons.mozilla.org は 5MB を超える JavaScript ファイルを受け付けないため)。
- WebLLM は WebGPU の `maxStorageBuffersPerShaderStage` を固定で 10 要求しますが、Firefox の上限は 9 なので、ビルド時にブラウザの上限に合わせるよう書き換えています。ねこ語モデルは 9 で動くことを確認しています。
- ねこ語モデルは llm-jp-3-150m-instruct3 を LoRA で学習させたもので、文末の命令・禁止・きつい断定だけをやわらかい形にして「にゃ」を付けます。1.5 億パラメータの小さなモデルなので、ダウンロードは約 90MB、1 文の変換は 1 秒前後です。学習データと手順は別リポジトリで管理しています。
- モデルの重みが Hugging Face 上で更新されていれば(索引ファイルのコミット ID が前回と違えば)、読み込み時に古いキャッシュを捨てて取り直します。ネットワークに届かないときはキャッシュのまま動きます。
- モデルの出力は検査し、元の文との違いが「対応表にある語尾の言い換え」に収まるものだけを採用します。意味が変わる出力や文の途中を変えた出力はルール変換の結果に戻します。
- モデルの出力は後処理で検査し、語尾が「にゃ」になっていなければ補います(ルール変換と共通)。
- 後処理(「にゃ」の付け方や終助詞の整え方)は [nyanyaku](https://github.com/rayjasm/nyanyaku) から移植しています。

## ビルド

```sh
npm install          # package-lock.json のとおりに依存関係を入れる
npm run build        # dist/ に出力
```

Firefox で `about:debugging#/runtime/this-firefox` を開き、「一時的なアドオンを読み込む」から `dist/manifest.json` を選ぶと試せます。

### Build instructions for reviewers

The extension is bundled with esbuild. To reproduce the distributed package from this source:

- Node.js 22 or newer (verified with Node.js 22.15.0 / npm 10.9.2; Node.js 24 is fine). No other tools are required
- `npm install`, then `npm run package`. The output `web-ext-artifacts/nyantopia-firefox-<version>.zip` is the submitted package
- The model weights are fetched by the user's browser at runtime from https://huggingface.co/jasmray/nyantopia-llm-jp-3-150m-q4f16_1-MLC
  (llm-jp-3-150m-instruct3 fine-tuned with LoRA and quantized to q4f16_1; Apache-2.0). No code is downloaded at runtime
- `public/wasm/nyantopia-llm-jp-3-150m-q4f16_1_cs1k-webgpu.wasm` is the model runtime (the TVM/WebGPU kernels for this model),
  compiled from the unmodified mlc-llm sources (commit 8978ea9, TVM 201fa00 = web-runtime 0.28.0-dev0, the version WebLLM 0.2.86
  bundles) with `mlc_llm compile --device webgpu` (LLVM 23.1, Emscripten 4.0.23). It is published next to the weights at
  `https://huggingface.co/jasmray/nyantopia-llm-jp-3-150m-q4f16_1-MLC/tree/main/lib` together with `BUILD-INFO.json`.
  `scripts/fetch-wasm.mjs` downloads it only when the file is missing
- `dist/wasm/xgrammar.wasm` and `dist/wasm/web-tokenizers.wasm` are extracted at build time from the base64 data URIs embedded in
  `node_modules/@mlc-ai/web-llm/lib/index.js` (see `build.mjs`), without modification
- `build.mjs` applies one change to the WebLLM library while bundling: the requested WebGPU limit
  `maxStorageBuffersPerShaderStage` is lowered to the adapter's limit (Firefox exposes 9, WebLLM asks for 10)

## ライセンス

にゃんとぴあのコードは [MIT ライセンス](LICENSE) です。

利用している外部のライブラリ、モデル、素材のライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にまとめています。

- [WebLLM](https://github.com/mlc-ai/web-llm): Apache License 2.0。拡張機能にバンドルして配布しています
- [nyantopia-llm-jp-3-150m](https://huggingface.co/jasmray/nyantopia-llm-jp-3-150m-q4f16_1-MLC)([llm-jp-3-150m-instruct3](https://huggingface.co/llm-jp/llm-jp-3-150m-instruct3) をねこ語向けに学習させたもの): Apache License 2.0。利用者のブラウザが Hugging Face から直接ダウンロードします
- アイコンの肉球イラスト: [いらすとや](https://www.irasutoya.com/) の素材を[利用規約](https://www.irasutoya.com/p/terms.html)の範囲で利用しています。著作権は作者に帰属し、MIT ライセンスの対象外です
