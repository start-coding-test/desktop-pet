// L2 阶段二：widget Worker 侧的虚拟节点（ADR-0008 决策 1）。
//
// 插件 widget 今天写的是 `const el = document.createElement("div"); el.append(...)`，
// 搬进 Worker 后拿不到真节点。这里给一个**同名同形状**的替身：方法名沿用插件现在用的那一套，
// 每次调用只改本地的虚拟状态，并把改动攒进一条 ops 批次，微任务合并后一次发给宿主。
// 迁移一个 widget 时，改动点只有「从 `document` 建节点」换成「从 `dom` 建节点」。
//
// 为什么不逐调用发一条消息：338 个 DOM 调用点就是 338 次跨 realm 往返；而且 postMessage 只有异步，
// 「取回一个节点再用」在异步形状下没法原样表达 —— 所以必须在 Worker 侧留住对象身份。
//
// 本文件跑在 Worker realm，**不许** import 任何宿主侧模块（`@tauri-apps/*`、`host-error.ts`）。
import { WIDGET_MAX_OPS_PER_MESSAGE, type WidgetOp } from "./widget-protocol";

/** SVG 命名空间串。插件写的是完整 URL，这里也按完整 URL 认，别的命名空间一律拒。 */
const SVG_NS = "http://www.w3.org/2000/svg";

/** 一批 ops 的出口。真实宿主里就是 `worker.postMessage`；单测注入一个收集器。 */
export type WidgetOpsSink = (message: { t: "ops"; seq: number; ops: WidgetOp[] }) => void;

/** 回给 handler 的事件快照。**永远不是真的事件对象**（跨 realm 传不了，也不该传）。 */
export interface WidgetEvent {
  target: WidgetNode;
  /** keydown 的按键名。其余字段（value / checked）由宿主回推后写进 target，handler 直接读 target */
  key?: string;
}

type PropName = "value" | "checked" | "disabled" | "readOnly" | "placeholder" | "type" | "id";

/**
 * 一个 widget 挂载实例对应一个 session：分配节点 id、攒批次、把宿主回推的事件派发回 handler。
 * id 由 Worker 侧单调分配，但**宿主只承认它自己创建过的 id**（apply 侧的 nodeId 表），
 * 所以这里的 id 是「宿主见过的句柄」，不是「Worker 说了算的坐标」。
 */
export class WidgetRenderSession {
  private nextId = 1;
  private seq = 0;
  private pending: WidgetOp[] = [];
  private flushScheduled = false;
  /** 停用终态：置位后所有写入都是空操作（避免插件残留回调把已下线的 widget 复活） */
  private disposed = false;
  private readonly nodes = new Map<number, WidgetNode>();
  private readonly handlers = new Map<number, Map<string, (event: WidgetEvent) => void>>();

  constructor(private readonly sink: WidgetOpsSink) {}

  /** 挂载点：宿主已经把 Shadow Root 交出来了，用固定 id 0 认领它 */
  readonly root = new WidgetNode(this, 0, "div");

  create(tag: string): WidgetNode {
    const id = this.nextId++;
    this.enqueue({ k: "create", id, tag });
    return new WidgetNode(this, id, tag);
  }

  /** 只认 SVG 那一个命名空间串；其余抛错 —— 「换个命名空间」在这里没有合法含义 */
  createSvg(ns: string, tag: string): WidgetNode {
    if (ns !== SVG_NS) throw new Error(`不支持的命名空间: ${ns}`);
    const id = this.nextId++;
    this.enqueue({ k: "create", id, tag, svg: true });
    return new WidgetNode(this, id, tag);
  }

  enqueue(op: WidgetOp): void {
    // 停用后的迟到写入一律丢弃（附录2 N7）：插件留下的定时器 / await 回来时仍会调
    // `el.textContent = ...`，这些 op 发出去只会落在一个已经不存在的插槽上。
    if (this.disposed) return;
    this.pending.push(op);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** 立即发出攒着的 ops。宿主在 `mount()` 返回后调一次，保证首屏不等到下一个微任务。 */
  flush(): void {
    this.flushScheduled = false;
    if (this.disposed) {
      this.pending = [];
      return;
    }
    while (this.pending.length) {
      const ops = this.pending.splice(0, WIDGET_MAX_OPS_PER_MESSAGE);
      this.sink({ t: "ops", seq: this.seq++, ops });
    }
  }

  /**
   * 宿主回推事件。快照里的 value / checked 先写回节点（**不再发 prop op**，否则会把用户刚改的值
   * 原样回声给宿主），再派发给 handler —— 插件代码读的是 `select.value` 而不是 `e.target.value`，
   * 实测 0 处 `e.target`，所以这一步不做对，所有下拉框与复选框的回读都是旧值。
   */
  handleEvent(id: number, event: string, snapshot: Record<string, unknown>): void {
    const node = this.nodes.get(id) ?? this.root;
    if ("value" in snapshot) node.setLocal("value", snapshot.value);
    if ("checked" in snapshot) node.setLocal("checked", snapshot.checked === true);
    const handler = this.handlers.get(id)?.get(event);
    if (!handler) return;
    const key = snapshot.key;
    handler(typeof key === "string" ? { target: node, key } : { target: node });
  }

  register(node: WidgetNode): void {
    this.nodes.set(node.nodeId, node);
  }

  bindHandler(id: number, event: string, handler: (event: WidgetEvent) => void): void {
    let bucket = this.handlers.get(id);
    if (!bucket) {
      bucket = new Map();
      this.handlers.set(id, bucket);
    }
    bucket.set(event, handler);
  }

  unbindHandler(id: number, event: string): void {
    this.handlers.get(id)?.delete(event);
  }

  /** 停用时丢掉 handler 与未发出的 ops：Worker 即将 terminate，留着只会让人以为还能回事件 */
  discard(): void {
    // disposed 是「终态」标记，不是清空动作（附录2 N7）：清空之后插件残留的回调
    // 还能再 enqueue 并触发一次 flush，等于让已经下线的 widget 复活一次
    this.disposed = true;
    this.handlers.clear();
    this.nodes.clear();
    this.pending = [];
    this.flushScheduled = false;
  }

  /** 是否已停用（诊断与单测用；停用后 enqueue/flush 都是空操作） */
  get isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * 虚拟节点。可读回来的部分（`textContent` / `value` / `checked` / `dataset`）都存在本地，
 * 因为插件里确实有「写完又读回来」的写法；真相仍在宿主 —— 这里读到的只保证与**本节点已发出的写**一致。
 */
export class WidgetNode {
  private text = "";
  private readonly classes = new Set<string>();
  private readonly data = new Map<string, string>();
  private valueLocal = "";
  private checkedLocal = false;
  private disabledLocal = false;
  private readOnlyLocal = false;
  private placeholderLocal = "";
  private typeLocal = "";
  private idLocal = "";

  constructor(
    private readonly session: WidgetRenderSession,
    readonly nodeId: number,
    readonly tag: string,
  ) {
    this.session.register(this);
    // 逐属性写样式：赋值即一条 op。消息层的批次合并已经把 13 处逐属性写收敛成一条消息了。
    this.style = new Proxy({} as Record<string, string | number>, {
      set: (target, key, value: string | number) => {
        target[String(key)] = value;
        this.session.enqueue({ k: "style", id: this.nodeId, props: { [String(key)]: value } });
        return true;
      },
    });
  }

  readonly style: Record<string, string | number>;

  get className(): string {
    return [...this.classes].join(" ");
  }

  set className(value: string) {
    this.classes.clear();
    for (const name of String(value).split(/\s+/)) if (name) this.classes.add(name);
    this.emitClass();
  }

  /** `toggle` 要读当前值，所以类名集合留在 Worker 侧、整串当 `attr class` 下发 ——
   *  不为此新开一种 op kind：词表越闭越好审。 */
  readonly classList = {
    add: (...names: string[]) => {
      for (const n of names) this.classes.add(n);
      this.emitClass();
    },
    remove: (...names: string[]) => {
      for (const n of names) this.classes.delete(n);
      this.emitClass();
    },
    toggle: (name: string, force?: boolean) => {
      const want = force ?? !this.classes.has(name);
      if (want) this.classes.add(name);
      else this.classes.delete(name);
      this.emitClass();
      return want;
    },
    contains: (name: string) => this.classes.has(name),
  };

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string | null) {
    this.text = value === null ? "" : String(value);
    this.session.enqueue({ k: "text", id: this.nodeId, value: this.text });
  }

  /** `el.dataset.k = v` 的替身。删除走 `delete el.dataset.k`（宿主侧把 null 理解成 removeAttribute） */
  readonly dataset: Record<string, string | undefined> = new Proxy({} as Record<string, string | undefined>, {
    get: (_t, key) => this.data.get(String(key)),
    set: (_t, key, value: string) => {
      this.data.set(String(key), String(value));
      this.session.enqueue({ k: "dataset", id: this.nodeId, key: String(key), value: String(value) });
      return true;
    },
    deleteProperty: (_t, key) => {
      this.data.delete(String(key));
      this.session.enqueue({ k: "dataset", id: this.nodeId, key: String(key), value: null });
      return true;
    },
  });

  get value(): string {
    return this.valueLocal;
  }

  set value(v: string) {
    this.setProp("value", String(v));
  }

  get checked(): boolean {
    return this.checkedLocal;
  }

  set checked(v: boolean) {
    this.setProp("checked", v === true);
  }

  get disabled(): boolean {
    return this.disabledLocal;
  }

  set disabled(v: boolean) {
    this.setProp("disabled", v === true);
  }

  get readOnly(): boolean {
    return this.readOnlyLocal;
  }

  set readOnly(v: boolean) {
    this.setProp("readOnly", v === true);
  }

  get placeholder(): string {
    return this.placeholderLocal;
  }

  set placeholder(v: string) {
    this.setProp("placeholder", String(v));
  }

  get type(): string {
    return this.typeLocal;
  }

  set type(v: string) {
    this.setProp("type", String(v));
  }

  /** DOM id（插件里 4 处 `el.id = "..."`）。数字句柄在 `nodeId` 上，两者**必须不同名**：
   *  同名会让插件那次赋值覆盖掉宿主句柄，之后这个节点发出的每条 op 都指向别的节点。 */
  get id(): string {
    return this.idLocal;
  }

  set id(v: string) {
    this.setProp("id", String(v));
  }

  setAttribute(name: string, value: string | null): void {
    // class 的唯一真相是 classes，走 className 才不会把两份状态写岔
    if (name === "class") {
      this.className = value ?? "";
      return;
    }
    // id 既是 property 也是 attribute，但真相只留一份：走 setProp，不再补发一条 attr op
    if (name === "id") {
      this.setProp(name, value === null ? "" : String(value));
      return;
    }
    this.session.enqueue({ k: "attr", id: this.nodeId, name, value });
  }

  append(...nodes: WidgetNode[]): void {
    for (const n of nodes) this.session.enqueue({ k: "append", parent: this.nodeId, child: n.nodeId });
  }

  appendChild(node: WidgetNode): WidgetNode {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes: WidgetNode[]): void {
    this.session.enqueue({ k: "replace", parent: this.nodeId, children: nodes.map((n) => n.nodeId) });
  }

  remove(): void {
    this.session.enqueue({ k: "remove", id: this.nodeId });
  }

  on(event: string, handler: (e: WidgetEvent) => void, opts?: { preventDefault?: boolean }): void {
    this.session.bindHandler(this.nodeId, event, handler);
    this.session.enqueue({
      k: "listen",
      id: this.nodeId,
      event,
      ...(opts?.preventDefault ? { preventDefault: true as const } : {}),
    });
  }

  off(event: string): void {
    this.session.unbindHandler(this.nodeId, event);
    this.session.enqueue({ k: "unlisten", id: this.nodeId, event });
  }

  private setProp(name: PropName, v: string | number | boolean): void {
    this.session.enqueue({ k: "prop", id: this.nodeId, name, value: v });
    this.setLocal(name, v);
  }

  /** 只写本地、不发 op：宿主回推事件时用它把用户改后的值同步进来（发 op 就是回声） */
  setLocal(name: PropName, v: unknown): void {
    if (name === "value") this.valueLocal = v === null || v === undefined ? "" : String(v);
    else if (name === "checked") this.checkedLocal = v === true;
    else if (name === "disabled") this.disabledLocal = v === true;
    else if (name === "readOnly") this.readOnlyLocal = v === true;
    else if (name === "placeholder") this.placeholderLocal = String(v ?? "");
    else if (name === "type") this.typeLocal = String(v ?? "");
    else this.idLocal = String(v ?? "");
  }

  private emitClass(): void {
    this.session.enqueue({ k: "attr", id: this.nodeId, name: "class", value: this.className });
  }
}

/** 交给 widget 的 DOM 面：插件里把 `document.createElement` 换成 `dom.createElement`，其余不动。 */
export function createDomFacade(session: WidgetRenderSession) {
  return {
    createElement: (tag: string) => session.create(tag),
    createElementNS: (ns: string, tag: string) => session.createSvg(ns, tag),
  };
}
