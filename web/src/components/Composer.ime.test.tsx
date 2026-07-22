// #729：输入法确认候选的回车不能误发消息。WebKit/WKWebView(桌面版)里 compositionend 早于
// 确认键 keydown,那一刻 isComposing 已是 false——只靠 isComposing 会漏拦。这里用可控的 rAF
// 精确复现「compositionend → 确认 Enter(isComposing=false) → 才放开护栏」的时序。
// @ts-expect-error Bun executes this test, while the web tsconfig intentionally loads only Vite globals.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { LocaleProvider } from "../i18n/locale";
import { Composer } from "./Composer";

let renderer: ReactTestRenderer | null = null;
let rafQueue: Array<() => void> = [];
const savedDescriptors: Record<string, PropertyDescriptor | undefined> = {};

function stubGlobal(key: string, value: unknown) {
  // 只在本周期首次替换该 key 时存原始描述符——否则同一用例里二次 stub(如把 rAF 改成 undefined)
  // 会用「上一个 stub 的描述符」覆盖掉真·原始值,afterEach 还原就会漏(#735 CodeRabbit)。
  if (!(key in savedDescriptors)) savedDescriptors[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
}

function memoryStorage(): Storage {
  const values = new Map<string, string>([["ap_locale", "en"]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
}

beforeEach(() => {
  rafQueue = [];
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("localStorage", memoryStorage());
  stubGlobal("window", { innerHeight: 844 });
  // 可控 rAF:攒起来,由测试决定何时放开护栏。
  stubGlobal("requestAnimationFrame", (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; });
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  // 还原被替换的全局对象,避免泄漏到后续用例/文件(#735 CodeRabbit)。
  for (const [key, desc] of Object.entries(savedDescriptors)) {
    if (desc === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, desc);
    delete savedDescriptors[key];
  }
});

function render(onSend: () => void) {
  act(() => {
    renderer = create(
      <LocaleProvider>
        <Composer
          draft="你好"
          setDraft={() => undefined}
          onSend={onSend}
          ready
          candidates={[]}
          mentionStatuses={[]}
        />
      </LocaleProvider>,
    );
  });
  return renderer!.root.findByProps({ className: "composer-input t-mono" });
}

function enter(isComposing = false) {
  return { key: "Enter", preventDefault() {}, nativeEvent: { isComposing }, shiftKey: false, metaKey: false, ctrlKey: false };
}

describe("Composer 输入法回车不误发 (#729)", () => {
  test("WebKit 时序:compositionend 后、护栏未放开时的确认 Enter(isComposing=false) 不发送", () => {
    let sends = 0;
    const ta = render(() => { sends += 1; });
    act(() => ta.props.onCompositionStart());
    act(() => ta.props.onCompositionEnd()); // 把放开动作压进 rafQueue(未执行)
    act(() => ta.props.onKeyDown(enter(false))); // 确认候选的回车
    expect(sends).toBe(0);
    // 放开护栏后,真正的回车才发送
    act(() => { rafQueue.forEach((cb) => cb()); });
    act(() => ta.props.onKeyDown(enter(false)));
    expect(sends).toBe(1);
  });

  test("合成中(isComposing=true)的 Enter 一律不发送", () => {
    let sends = 0;
    const ta = render(() => { sends += 1; });
    act(() => ta.props.onCompositionStart());
    act(() => ta.props.onKeyDown(enter(true)));
    expect(sends).toBe(0);
  });

  test("非合成状态下普通 Enter 正常发送", () => {
    let sends = 0;
    const ta = render(() => { sends += 1; });
    act(() => ta.props.onKeyDown(enter(false)));
    expect(sends).toBe(1);
  });

  test("无 requestAnimationFrame(SSR/测试环境)时走微任务回退,仍在合成周期内拦住 Enter", async () => {
    stubGlobal("requestAnimationFrame", undefined); // 触发 Promise 微任务回退分支
    let sends = 0;
    const ta = render(() => { sends += 1; });
    act(() => ta.props.onCompositionStart());
    act(() => ta.props.onCompositionEnd()); // 放开动作压进微任务(未 flush)
    act(() => ta.props.onKeyDown(enter(false)));
    expect(sends).toBe(0);
    await act(async () => { await Promise.resolve(); }); // flush 微任务 → 放开护栏
    act(() => ta.props.onKeyDown(enter(false)));
    expect(sends).toBe(1);
  });

  test("旧合成周期的延迟回调不清掉新周期的护栏(#735)", () => {
    let sends = 0;
    const ta = render(() => { sends += 1; });
    act(() => ta.props.onCompositionStart()); // 周期1
    act(() => ta.props.onCompositionEnd());    // 压入周期1的放开(gen=1)
    act(() => ta.props.onCompositionStart()); // 周期2 立起新护栏(gen=2)
    act(() => { rafQueue.forEach((cb) => cb()); }); // 周期1的放开触发,但 gen 已变 → 不清
    act(() => ta.props.onKeyDown(enter(false))); // 仍在周期2合成中 → 不发
    expect(sends).toBe(0);
  });
});
