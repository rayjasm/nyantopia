// Firefox の WebExtension API(browser.*)の型。Promise ベースの API として扱う
import type Browser from "webextension-polyfill";

declare global {
  const browser: typeof Browser;
}
