// #858：同 owner 同角色的 agent 显示名撞车时，在名字后补一段技术区分码。
// 只有撞名身份才有 code；不撞名时组件渲染 null，界面完全不变（不给所有身份加尾巴）。
export function IdentityDisambiguator({ code }: { code: string | null | undefined }) {
  if (code === null || code === undefined || code === "") return null;
  return (
    <span className="t-mono identity-disambiguator" title={code}>
      ·{code}
    </span>
  );
}
