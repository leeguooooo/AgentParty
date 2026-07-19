// 当前发布的 party CLI 版本。单一真源是 cli/package.json（scripts/release-version.ts 每次发布
// 同步 cli/desktop/cargo 到同一版号）；Vite 在构建与 dev 时经 define 注入 __PARTY_CLI_VERSION__，
// 于是接入脚本的版本闸永远跟随刚发布的 CLI，不再手改常量、也不再漂移（#612 的教训）。
//
// 两个真实运行时都注入这个符号：产物走 Vite define；bun 单测走 test/inject-cli-version.ts 预载
// （从 cli/package.json 读真实发布版）。fallback 因此是纯防御死码，永不落进产物、也不会被测试选中；
// releaseVersion.test.ts 断言 RELEASE_CLI_VERSION 恒等于 cli/package.json，注入一旦断掉就当场失败。
declare const __PARTY_CLI_VERSION__: string | undefined;

export const RELEASE_CLI_VERSION: string = typeof __PARTY_CLI_VERSION__ === "string" ? __PARTY_CLI_VERSION__ : "0.2.132";
