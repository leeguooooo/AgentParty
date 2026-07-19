// 当前发布的 party CLI 版本。单一真源是 cli/package.json（scripts/release-version.ts 每次发布
// 同步 cli/desktop/cargo 到同一版号）；Vite 在构建与 dev 时经 define 注入 __PARTY_CLI_VERSION__，
// 于是接入脚本的版本闸永远跟随刚发布的 CLI，不再手改常量、也不再漂移（#612 的教训）。
//
// fallback 只在没有 Vite define 的运行时用到——目前只有 bun 单测。它不进任何产物；测试断言一律引用
// 本常量（或从它派生的 MIN_CLI），从不写死数字，所以 fallback 无需跟随发布，够新的合法 semver 即可。
declare const __PARTY_CLI_VERSION__: string | undefined;

export const RELEASE_CLI_VERSION: string = typeof __PARTY_CLI_VERSION__ === "string" ? __PARTY_CLI_VERSION__ : "0.2.132";
