// #1113：每个 party 身份最近一次上报的本机 ocs 会话。纯内存（同 #1103 的 live session 环形缓冲）：
// DO 被驱逐后丢了也无妨——CLI 每 OCS_ROSTER_REPORT_INTERVAL_MS 重报一次，重连 hello 后也会立即重报。
// 按身份只留一份（同名 serve + mcp 都报时最新者生效）；只有「当前持有这份」的连接断开才清。
import {
  OCS_ROSTER_TTL_MS,
  viewOcsSessions,
  type OcsRosterFrame,
  type OcsSessionReport,
} from "@agentparty/shared";

interface StoredRoster {
  connectionId: string;
  sessions: Array<OcsSessionReport & { party_name?: string }>;
  ts: number;
  expiresAt: number;
}

export class OcsRosterStore {
  private readonly byName = new Map<string, StoredRoster>();

  /** 记下一次上报。session_key 在这里被消费（换成 party_name）并丢弃，不进任何下发帧。 */
  apply(
    name: string,
    connectionId: string,
    sessions: OcsSessionReport[],
    now: number,
    partyNameOf: (s: OcsSessionReport) => string | undefined,
  ): void {
    const stored = sessions.map((s) => {
      const partyName = partyNameOf(s);
      const { session_key: _drop, ...rest } = s;
      return partyName === undefined ? rest : { ...rest, party_name: partyName };
    });
    this.byName.set(name, { connectionId, sessions: stored, ts: now, expiresAt: now + OCS_ROSTER_TTL_MS });
  }

  /** 为某个观看者生成帧。full 由调用方按可见性规则判定。过期/不存在返回 null。 */
  frameFor(name: string, full: boolean, now: number): OcsRosterFrame | null {
    const r = this.byName.get(name);
    if (r === undefined) return null;
    if (r.expiresAt <= now) {
      this.byName.delete(name);
      return null;
    }
    return { type: "ocs_roster", name, sessions: viewOcsSessions(r.sessions, full), ts: r.ts, expires_at: r.expiresAt, full };
  }

  /** 当前未过期的全部身份名。 */
  names(now: number): string[] {
    const out: string[] = [];
    for (const [name, r] of this.byName) {
      if (r.expiresAt <= now) this.byName.delete(name);
      else out.push(name);
    }
    return out;
  }

  /** 连接断开：只清由这条连接上报的那份，返回被清掉的身份名。 */
  disconnect(connectionId: string): string[] {
    const cleared: string[] = [];
    for (const [name, r] of this.byName) {
      if (r.connectionId === connectionId) {
        this.byName.delete(name);
        cleared.push(name);
      }
    }
    return cleared;
  }

  /** 身份被移除/擦除。返回是否真的清了东西。 */
  forget(name: string): boolean {
    return this.byName.delete(name);
  }
}

/** 空清除帧：观看者据此移除该身份的本机分组。 */
export function clearedOcsRosterFrame(name: string, now: number): OcsRosterFrame {
  return { type: "ocs_roster", name, sessions: [], ts: now, expires_at: now, full: false };
}
