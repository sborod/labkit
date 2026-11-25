// MIDI mappings and musical input events share one adapter and the same port listeners.
import type { Origin } from "../core/origin.ts";
import { loadMidiState, saveMidiState, type MidiStorage, type StoredMidiState } from "./store.ts";
import { absoluteScale, decodeMidiMessage, isRelative, quantize, relativeDelta } from "./decode.ts";
import type {
  MidiAccessLike,
  MidiActionInput,
  MidiDeviceInfo,
  MidiEnvironment,
  MidiInputEvent,
  MidiInputLike,
  MidiMapping,
  MidiMessage,
  MidiMode,
  MidiStatus,
} from "./types.ts";

const MIDI_ORIGIN: Origin = "midi";

/** Узкий host параметров: `ParameterRegistry` ему структурно удовлетворяет. */
export interface MidiParamHost {
  has(id: string): boolean;
  ids(): string[];
  kind(id: string): string;
  getNumber(id: string): number;
  getBoolean(id: string): boolean;
  isAvailable(id: string): boolean;
  spec(id: string): {
    id: string;
    label: string;
    kind: string;
    min?: number;
    max?: number;
    step?: number | "any";
  };
  set(id: string, value: unknown, origin: Origin): void;
}

/** Узкий host действий: `ActionRegistry` ему структурно удовлетворяет. */
export interface MidiActionHost {
  has(id: string): boolean;
  ids(): string[];
  isAvailable(id: string): boolean;
  label(id: string): string;
  execute(id: string, origin: Origin, input?: MidiActionInput): Promise<void>;
}

export interface MidiTargetInfo {
  id: string;
  label: string;
  kind: "number" | "boolean" | "action";
}

export interface MidiAdapterOptions {
  /** Namespace персистентности (отдельный ключ от состояния лаборатории). */
  namespace: string;
  params: MidiParamHost;
  actions: MidiActionHost;
  environment: MidiEnvironment;
  lifetime: { readonly disposed: boolean };
  storage?: MidiStorage;
  /**
   * Что слушать по умолчанию: один первый вход (`"first"`, текущее поведение)
   * или все подключённые входы одновременно (`"all"`). Пользователь может
   * переключить режим в панели (`selectInput`/`selectAllInputs`).
   */
  inputMode?: "first" | "all";
  /**
   * Режим по умолчанию для НОВЫХ назначений цели (создание через addMapping и
   * inline/строчное обучение). Применяется только к number-параметрам:
   * относительные режимы для boolean/action не имеют смысла и остаются
   * `absolute`. Явно переданный или сохранённый mode никогда не перезаписывается.
   * Лаборатории, не задавшие опцию, сохраняют прежнее поведение (всё absolute).
   */
  defaultModes?: Readonly<Record<string, MidiMode>>;
  onStatus?(status: MidiStatus): void;
  onMonitor?(message: MidiMessage | null): void;
  onError?(error: unknown): void;
  /** Любое изменение состояния адаптера (UI перерисовывается). */
  onChange?(): void;
}

interface Runtime {
  /** Ключи `${inputId}\u0000${channel}`: удержания разных устройств независимы. */
  held: Set<string>;
  /** История относительных CC по паре (вход, канал). */
  lastValue: Map<string, number>;
}

interface ActiveInput {
  input: MidiInputLike;
  listener: (event: { data: ArrayLike<number> }) => void;
}

interface Learning {
  target: string;
  /** null — inline-обучение (первое назначение цели); иначе конкретная строка. */
  mappingId: string | null;
}

/** Обязательство доставить scoped-reset снятого входа музыкальным подписчикам. */
interface PendingInputReset {
  inputId: string;
  reason: "disconnect" | "selection" | "dispose";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Безопасное получение localStorage: недоступный/бросающий getter не должен
 * ломать optional MIDI. Если persistence недоступна — возвращается `null`
 * (запись/чтение отключены), НЕ подменяется in-memory хранилищем. Память
 * используется только по явной инъекции в тестах.
 */
function acquireStorage(provided?: MidiStorage): {
  storage: MidiStorage | null;
  warning: string | null;
} {
  if (provided) return { storage: provided, warning: null };
  try {
    if (typeof localStorage !== "undefined") return { storage: localStorage, warning: null };
  } catch (error) {
    return {
      storage: null,
      warning: `MIDI: localStorage недоступен — назначения не сохраняются (${messageOf(error)})`,
    };
  }
  return {
    storage: null,
    warning: "MIDI: localStorage недоступен — назначения не сохраняются",
  };
}

/**
 * Экземплярный MIDI-адаптер. Создаётся в hooks.setup, освобождается вместе с
 * Scope. Два экземпляра на одном входе используют независимые listeners и
 * независимые state-change-подписки.
 */
export class MidiAdapter {
  readonly #params: MidiParamHost;
  readonly #actions: MidiActionHost;
  readonly #env: MidiEnvironment;
  readonly #lifetime: { readonly disposed: boolean };
  readonly #storage: MidiStorage | null;
  readonly #defaultModes: Readonly<Record<string, MidiMode>>;
  readonly #namespace: string;
  readonly #onStatus: (status: MidiStatus) => void;
  readonly #onMonitor: (message: MidiMessage | null) => void;
  readonly #onError: (error: unknown) => void;
  readonly #onChange: () => void;

  #access: MidiAccessLike | null = null;
  #unsubscribeStateChange: (() => void) | null = null;
  /** Активные входы и их listeners; в режиме «все входы» их несколько. */
  readonly #inputs = new Map<string, ActiveInput>();
  #allInputs = false;
  #wanted = "";
  /** Монотонный ревизор выбора входа: инвалидирует событие, если внешний
   *  колбэк (напр. onMonitor) сменил выбор во время его обработки. */
  #selectionRevision = 0;
  #training = false;
  #learning: Learning | null = null;
  #learnMessage = "";
  #detail = "";
  #persistenceWarning: string | null = null;
  #status: MidiStatus = { kind: "idle", message: "MIDI ещё не подключён." };
  #connecting = false;
  #disposed = false;
  #counter = 0;
  #lastMessage: MidiMessage | null = null;
  readonly #mappings: MidiMapping[] = [];
  readonly #runtime = new Map<string, Runtime>();
  readonly #usedIds = new Set<string>();
  readonly #listeners = new Set<() => void>();
  /** Opt-in подписчики музыкального потока; не участвуют в routing реестра. */
  readonly #inputListeners = new Set<(event: MidiInputEvent) => void>();
  /**
   * Очередь обязательств reset'а снятых входов. Заполняется ДО внешних
   * registry-колбэков, поэтому reset не теряется, если callback освободит
   * адаптер или сменит выбор. Очередь ограничена числом входов.
   */
  readonly #pendingInputResets: PendingInputReset[] = [];
  #inputResetDeliveryDepth = 0;
  #disposeCleanupPending = false;

  constructor(options: MidiAdapterOptions) {
    this.#params = options.params;
    this.#actions = options.actions;
    this.#env = options.environment;
    this.#lifetime = options.lifetime;
    const acquired = acquireStorage(options.storage);
    this.#storage = acquired.storage;
    this.#allInputs = options.inputMode === "all";
    this.#defaultModes = options.defaultModes ?? {};
    this.#namespace = options.namespace;
    this.#onStatus = options.onStatus ?? (() => {});
    this.#onMonitor = options.onMonitor ?? (() => {});
    this.#onError = options.onError ?? (() => {});
    this.#onChange = options.onChange ?? (() => {});
    if (acquired.warning) this.#persistenceWarning = acquired.warning;
    this.#load();
  }

  // --- observation ---------------------------------------------------------

  get status(): MidiStatus {
    return this.#status;
  }

  get training(): boolean {
    return this.#training;
  }

  /** В режиме «все входы» — id первого активного; для одного входа — выбранный. */
  get inputId(): string {
    if (this.#allInputs) return this.#inputs.keys().next().value ?? "";
    return this.#inputs.get(this.#wanted)?.input.id ?? "";
  }

  get inputName(): string {
    const names = [...this.#inputs.values()]
      .map((active) => active.input.name ?? "")
      .filter((name) => name.length > 0);
    return this.#allInputs ? names.join(", ") : (names[0] ?? "");
  }

  get allInputs(): boolean {
    return this.#allInputs;
  }

  /** id входов, на которые сейчас реально подписан адаптер. */
  listeningInputIds(): string[] {
    return [...this.#inputs.keys()];
  }

  get connecting(): boolean {
    return this.#connecting;
  }

  get learnMessage(): string {
    return this.#learnMessage;
  }

  get detail(): string {
    return this.#detail;
  }

  get persistenceWarning(): string | null {
    return this.#persistenceWarning;
  }

  get learningTarget(): string | null {
    return this.#learning?.target ?? null;
  }

  get learningMappingId(): string | null {
    return this.#learning?.mappingId ?? null;
  }

  get lastMessage(): MidiMessage | null {
    return this.#lastMessage;
  }

  mappings(): readonly MidiMapping[] {
    return this.#mappings;
  }

  /** Подписка UI на изменения адаптера. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Opt-in подписка на музыкальный поток входных сообщений и reset-события.
   * Это НЕ второй Web MIDI access и не порт: адаптер остаётся единственным
   * владельцем listeners. Назначения при этом по-прежнему адресуют реестр;
   * подписчик адресует локальный инструмент. Возвращает функцию отписки.
   */
  subscribeInput(listener: (event: MidiInputEvent) => void): () => void {
    if (this.#closed()) return () => {};
    this.#inputListeners.add(listener);
    return () => {
      this.#inputListeners.delete(listener);
    };
  }

  devices(): MidiDeviceInfo[] {
    if (!this.#access) return [];
    return [...this.#access.inputs.values()]
      .filter((input) => input.state !== "disconnected")
      .map((input) => ({ id: input.id, name: input.name ?? "" }));
  }

  /** Все адресуемые цели: параметры (number/boolean) и действия. */
  targets(): MidiTargetInfo[] {
    const list: MidiTargetInfo[] = [];
    for (const id of this.#params.ids()) {
      const kind = this.#params.kind(id);
      if (kind === "number" || kind === "boolean") {
        list.push({ id, label: this.#params.spec(id).label, kind });
      }
    }
    for (const id of this.#actions.ids()) {
      list.push({ id, label: this.#actions.label(id), kind: "action" });
    }
    return list;
  }

  // --- connection ----------------------------------------------------------

  async connect(): Promise<void> {
    if (this.#closed()) return;
    if (!this.#env.isSupported()) {
      this.#setStatus({
        kind: "unsupported",
        message: "Web MIDI не поддерживается этим браузером.",
      });
      return;
    }
    if (!this.#env.isSecureContext()) {
      this.#setStatus({
        kind: "insecure",
        message: "MIDI требует HTTPS или localhost. Открой страницу через локальный сервер.",
      });
      return;
    }
    if (this.#connecting) return;
    this.#connecting = true;
    this.#setStatus({ kind: "connecting", message: "Подключение MIDI…" });
    // onStatus-колбэк мог освободить адаптер: не запрашиваем доступ после dispose.
    if (this.#closed()) {
      this.#connecting = false;
      return;
    }
    try {
      if (!this.#access) {
        const access = await this.#env.requestAccess();
        if (this.#closed()) return;
        this.#access = access;
        this.#unsubscribeStateChange = access.addStateChangeListener(() => {
          if (!this.#closed()) this.refresh();
        });
        if (this.#closed()) {
          this.#unsubscribeStateChange();
          this.#unsubscribeStateChange = null;
          return;
        }
      }
      this.refresh();
    } catch (error) {
      if (this.#closed()) return;
      const name = (error as { name?: string }).name;
      this.#setStatus({
        kind: name === "NotAllowedError" || name === "SecurityError" ? "denied" : "error",
        message:
          name === "NotAllowedError" || name === "SecurityError"
            ? "Доступ к MIDI запрещён. Разреши MIDI для страницы в настройках браузера."
            : `Не удалось подключить MIDI: ${messageOf(error)}`,
      });
    } finally {
      this.#connecting = false;
      this.#notify();
    }
  }

  /** Перечитать список входов (hotplug/reconnect). Выбранный вход не подменяется. */
  refresh(): void {
    if (this.#closed()) return;
    const inputs = this.devices();
    if (this.#allInputs) {
      this.#syncInputs(
        inputs.map((input) => input.id),
        "disconnect",
      );
      if (this.#closed()) return;
      this.#setStatus(this.#allInputsStatus(inputs));
      return;
    }
    if (!this.#wanted && inputs.length > 0) {
      this.#wanted = inputs[0]!.id;
    }
    const input = this.#access?.inputs.get(this.#wanted) ?? null;
    const connected = input && input.state !== "disconnected" ? input : null;
    this.#syncInputs(connected ? [connected.id] : [], "disconnect");
    if (this.#closed()) return;
    if (this.#wanted && !connected) {
      this.#setStatus({
        kind: inputs.length > 0 ? "input-disconnected" : "no-inputs",
        message:
          inputs.length > 0
            ? "Выбранный вход отключён. Выбери другой или подключи его снова."
            : "Нет входов MIDI. Подключи устройство — список обновится автоматически.",
      });
      return;
    }
    if (connected) {
      this.#setStatus({
        kind: "connected",
        message: `MIDI подключён: ${connected.name || "MIDI вход"}.`,
      });
    } else {
      this.#setStatus({ kind: "no-inputs", message: "Нет входов MIDI." });
    }
  }

  /** Явный выбор одного входа; сохраняется как «желаемый» для reconnect. */
  selectInput(id: string): void {
    if (this.#closed()) return;
    const changed = this.#allInputs || id !== this.#wanted;
    this.#allInputs = false;
    this.#wanted = id;
    const input = this.#access?.inputs.get(id) ?? null;
    const connected = input && input.state !== "disconnected" ? input : null;
    this.#syncInputs(connected ? [connected.id] : [], "selection");
    if (this.#closed()) return;
    if (changed) {
      this.cancelLearn("Обучение отменено.");
      if (this.#closed()) return;
    }
    this.#setStatus(
      connected
        ? { kind: "connected", message: `MIDI подключён: ${connected.name || "MIDI вход"}.` }
        : { kind: "input-disconnected", message: "Вход MIDI не выбран." },
    );
  }

  /**
   * Слушать все подключённые входы одновременно. Назначения общие: одинаковые
   * CC/Note с разных устройств управляют одной и той же целью.
   */
  selectAllInputs(): void {
    if (this.#closed()) return;
    const changed = !this.#allInputs;
    this.#allInputs = true;
    const inputs = this.devices();
    this.#syncInputs(
      inputs.map((input) => input.id),
      "selection",
    );
    if (this.#closed()) return;
    if (changed) {
      this.cancelLearn("Обучение отменено.");
      if (this.#closed()) return;
    }
    this.#setStatus(this.#allInputsStatus(inputs));
  }

  setTraining(training: boolean): void {
    this.#training = training;
    if (!training)
      this.cancelLearn("Обучение завершено. Назначения сохранены; управление MIDI работает.");
    if (this.#closed()) return;
    this.#notify();
  }

  // --- learn / CRUD --------------------------------------------------------

  /**
   * Начать обучение. `mappingId` (если задан) обучает конкретную строку; без
   * него — первое назначение цели (inline). Повторный клик по той же кнопке
   * отменяет обучение.
   */
  startLearn(target: string, mappingId?: string): void {
    if (this.#closed()) return;
    const rowId = mappingId ?? null;
    if (this.#learning && this.#learning.target === target && this.#learning.mappingId === rowId) {
      this.cancelLearn();
      return;
    }
    if (this.#inputs.size === 0) {
      this.#learnMessage = "Сначала подключи и выбери вход MIDI.";
      this.#notify();
      return;
    }
    if (!this.#targetExists(target)) {
      this.#learnMessage = "Сначала выбери параметр или действие.";
      this.#notify();
      return;
    }
    if (rowId !== null && !this.#mappings.some((mapping) => mapping.id === rowId)) {
      // Строка исчезла: не воскрешаем её новой строкой при следующем сообщении.
      this.#learning = null;
      this.#learnMessage = "Назначение для обучения не найдено — обучение отменено.";
      this.#notify();
      return;
    }
    this.#learning = { target, mappingId: rowId };
    this.#learnMessage =
      "Жду CC или Note On на активном входе; канал запишется в назначение. Нажми ещё раз для отмены.";
    this.#notify();
  }

  cancelLearn(message = "Обучение отменено."): void {
    if (!this.#learning && !this.#learnMessage) return;
    this.#learning = null;
    this.#learnMessage = message;
    this.#notify();
  }

  /**
   * Добавить назначение. Если цель не задана/невалидна — берётся первая
   * доступная цель (валидный draft-путь для панели). Возвращает null, если цели нет.
   */
  addMapping(partial: Partial<Omit<MidiMapping, "id">> = {}): MidiMapping | null {
    let target = typeof partial.target === "string" ? partial.target : "";
    if (!this.#targetExists(target)) {
      target = this.targets()[0]?.id ?? "";
    }
    if (!target) return null;
    const mapping: MidiMapping = {
      id: this.#nextId(),
      target,
      source: partial.source === "note" ? "note" : "cc",
      number:
        Number.isInteger(partial.number) && partial.number! >= 0 && partial.number! <= 127
          ? partial.number!
          : 0,
      channel: this.#clampChannel(partial.channel ?? 0),
      mode: this.#validMode(partial.mode) ?? this.#defaultMode(target),
      sensitivity:
        Number.isInteger(partial.sensitivity) &&
        partial.sensitivity! >= 1 &&
        partial.sensitivity! <= 100
          ? partial.sensitivity!
          : 1,
      invert: partial.invert === true,
    };
    this.#mappings.push(mapping);
    this.#ensureRuntime(mapping);
    this.#save();
    this.#notify();
    return mapping;
  }

  updateMapping(id: string, patch: Partial<Omit<MidiMapping, "id" | "target">>): void {
    const mapping = this.#mappings.find((m) => m.id === id);
    if (!mapping) return;
    // Освобождаем старые удержания ДО мутации (иначе тумблер залипнет).
    // Release пишет в реестр, подписчик которого мог освободить адаптер (или
    // создать replacement): после этого продолжение недопустимо.
    if (patch.source === "cc" || patch.source === "note") {
      this.#releaseMapping(mapping);
      if (this.#closed()) return;
      mapping.source = patch.source;
    }
    if (Number.isInteger(patch.number) && patch.number! >= 0 && patch.number! <= 127) {
      this.#releaseMapping(mapping);
      if (this.#closed()) return;
      mapping.number = patch.number!;
    }
    if (
      Number.isInteger(patch.channel) &&
      patch.channel! >= 0 &&
      patch.channel! <= 16 &&
      patch.channel !== mapping.channel
    ) {
      // Смена канала меняет адресуемый поток: освобождаем удержания ДО мутации,
      // иначе Note/тумблер, пришедшие на старом канале, останутся залипшими.
      this.#releaseMapping(mapping);
      if (this.#closed()) return;
      mapping.channel = patch.channel!;
    }
    const mode = this.#validMode(patch.mode);
    if (mode) mapping.mode = mode;
    if (
      Number.isInteger(patch.sensitivity) &&
      patch.sensitivity! >= 1 &&
      patch.sensitivity! <= 100
    ) {
      mapping.sensitivity = patch.sensitivity!;
    }
    if (patch.invert !== undefined) mapping.invert = patch.invert;
    this.#save();
    this.#notify();
  }

  removeMapping(id: string): void {
    const index = this.#mappings.findIndex((m) => m.id === id);
    if (index < 0) return;
    const mapping = this.#mappings[index]!;
    // Освобождаем удержание, пока строка ещё в списке: значение пересчитывается
    // по ОСТАВШИМСЯ удержаниям цели. Подписчик мог освободить адаптер.
    this.#releaseMapping(mapping);
    if (this.#closed()) return;
    this.#mappings.splice(index, 1);
    this.#runtime.delete(mapping.id);
    this.#usedIds.delete(mapping.id);
    if (this.#learning?.mappingId === mapping.id) this.cancelLearn();
    this.#save();
    this.#notify();
  }

  /** Summary первого назначения цели (как в эталоне). */
  targetSummary(target: string): string {
    const rows = this.#mappings.filter((m) => m.target === target);
    const first = rows[0];
    if (!first) return "Обучить MIDI";
    const base = `${first.source === "cc" ? "CC" : "Note"} ${first.number}`;
    const channel = first.channel === 0 ? "" : ` · ch ${first.channel}`;
    const relative = isRelative(first.mode, first.source) ? " · Δ" : "";
    const extra = rows.length > 1 ? ` +${rows.length - 1}` : "";
    return base + channel + relative + extra;
  }

  dispose(): void {
    if (this.#disposed) return;
    // Входы, которые были активны ДО закрытия: им нужен терминальный reset.
    const activeIds = [...this.#inputs.keys()];
    this.#disposed = true;
    this.#disposeCleanupPending = true;
    // Normal delivery закрыт disposed-guard'ом. Обязательства reset'ов
    // фиксируются ДО release-колбэков: снятый ранее вход тоже не должен
    // потеряться, даже если callback вызовет dispose/selection.
    for (const id of activeIds) this.#enqueueInputReset(id, "dispose");
    // Освобождаем удержанные тумблеры (запись в реестр) до отписки.
    this.#releaseAllHeld();
    this.#flushInputResets();
    this.#cleanupAfterDispose();
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  // --- persistence ---------------------------------------------------------

  #load(): void {
    // Persistence отключена (нет localStorage) — читать нечего.
    if (!this.#storage) return;
    let loaded: StoredMidiState;
    try {
      loaded = loadMidiState(this.#storage, this.#namespace, () => this.#nextId());
    } catch (error) {
      this.#reportPersistence(`MIDI: не удалось прочитать назначения — ${messageOf(error)}`);
      return;
    }
    for (const issue of loaded.issues) this.#reportPersistence(issue);
    for (const mapping of loaded.mappings) {
      if (!this.#kindOf(mapping.target)) {
        this.#reportPersistence(
          `MIDI: назначение ${mapping.id} отброшено — цель "${mapping.target}" не поддерживается (нужны number/boolean/action)`,
        );
        continue;
      }
      if (this.#usedIds.has(mapping.id)) mapping.id = this.#nextId();
      this.#usedIds.add(mapping.id);
      this.#mappings.push(mapping);
      this.#ensureRuntime(mapping);
    }
  }

  #save(): void {
    if (!this.#storage) return;
    // После dispose (в т.ч. вызванного подписчиком реестра) запись запрещена:
    // иначе старое продолжение затрёт persistence replacement-экземпляра.
    if (this.#closed()) return;
    try {
      saveMidiState(this.#storage, this.#namespace, { mappings: this.#mappings });
      // Успешная запись снимает прежнее предупреждение о сбое.
      this.#persistenceWarning = null;
    } catch (error) {
      this.#reportPersistence(`MIDI: не удалось сохранить назначения — ${messageOf(error)}`);
    }
  }

  #reportPersistence(message: string): void {
    if (this.#persistenceWarning === message) return;
    this.#persistenceWarning = message;
    this.#reportError(new Error(message));
  }

  // --- internal ------------------------------------------------------------

  #closed(): boolean {
    return this.#disposed || this.#lifetime.disposed;
  }

  /** Канал назначения: 0 — любой, 1..16 — конкретный; невалидный → 0. */
  #clampChannel(channel: number): number {
    return Number.isInteger(channel) && channel >= 0 && channel <= 16 ? channel : 0;
  }

  #nextId(): string {
    let id: string;
    do {
      this.#counter += 1;
      id = `m${this.#counter}`;
    } while (this.#usedIds.has(id));
    this.#usedIds.add(id);
    return id;
  }

  #targetExists(target: string): boolean {
    return this.#kindOf(target) !== null;
  }

  /**
   * Runtime-вид цели. Поддерживаются только number/boolean-параметры и actions;
   * прочие виды параметров (например enum) не адресуемы MIDI на этом этапе и
   * трактуются как неизвестная цель (отбрасываются при загрузке с предупреждением).
   */
  #kindOf(target: string): "number" | "boolean" | "action" | null {
    if (this.#params.has(target)) {
      const kind = this.#params.kind(target);
      if (kind === "boolean") return "boolean";
      if (kind === "number") return "number";
      return null;
    }
    if (this.#actions.has(target)) return "action";
    return null;
  }

  #defaultMode(target: string): MidiMode {
    // Относительный режим осмыслен только для числовой цели (reference Sombrero:
    // sourceX/sourceY/sourceZ → delta, прочие цели → absolute). boolean/action
    // остаются абсолютными, даже если для них задан относительный default.
    // Явный/сохранённый mode сюда не попадает: default — только для новых строк.
    if (this.#kindOf(target) === "number") {
      const configured = this.#validMode(this.#defaultModes[target]);
      if (configured) return configured;
    }
    return "absolute";
  }

  #validMode(mode: unknown): MidiMode | null {
    return mode === "absolute" ||
      mode === "delta" ||
      mode === "wrap" ||
      mode === "twos" ||
      mode === "offset" ||
      mode === "sign"
      ? mode
      : null;
  }

  #ensureRuntime(mapping: MidiMapping): Runtime {
    let runtime = this.#runtime.get(mapping.id);
    if (!runtime) {
      runtime = { held: new Set(), lastValue: new Map() };
      this.#runtime.set(mapping.id, runtime);
    }
    return runtime;
  }

  #runtimeFor(mapping: MidiMapping): Runtime {
    return this.#ensureRuntime(mapping);
  }

  #holdKey(inputId: string, channel: number): string {
    return `${inputId}\u0000${channel}`;
  }

  /**
   * Привести набор активных входов к `ids`: снять лишние listeners и повесить
   * недостающие. Удержания снятого входа освобождаются, остальные устройства
   * продолжают работать. `resetReason` классифицирует причину снятия входа:
   * hotplug/отключение (`disconnect`) или явная смена выбора (`selection`).
   * Возвращает true, если набор изменился.
   */
  #syncInputs(ids: readonly string[], resetReason: "disconnect" | "selection"): boolean {
    const desired = new Set(ids);
    let revision = this.#selectionRevision;
    let changed = false;
    let invalidated = false;
    // Membership/revision инвалидируются ДО внешних release-колбэков: старое
    // сообщение не может продолжиться через registry callback.
    const invalidate = (): void => {
      if (invalidated) return;
      invalidated = true;
      this.#selectionRevision++;
      this.#lastMessage = null;
      revision = this.#selectionRevision;
    };
    for (const [id, active] of [...this.#inputs]) {
      if (desired.has(id) && active.input.state !== "disconnected") continue;
      active.input.removeEventListener("midimessage", active.listener);
      this.#inputs.delete(id);
      // Обязательство reset'а фиксируется до release-колбэков и переживает
      // dispose/вложенный selection: источник уже снят из active membership.
      this.#enqueueInputReset(id, resetReason);
      invalidate();
      this.#releaseHeldForInput(id);
      changed = true;
      // releaseHeldForInput пишет в реестр и дёргает колбэки: подписчик мог
      // освободить адаптер или сменить набор входов. Тогда не продолжаем.
      if (this.#closed() || this.#selectionRevision !== revision) {
        this.#flushInputResets();
        return changed;
      }
    }
    for (const id of desired) {
      if (this.#inputs.has(id)) continue;
      const input = this.#access?.inputs.get(id);
      if (!input || input.state === "disconnected") continue;
      const listener = (event: { data: ArrayLike<number> }): void => {
        this.#handleEvent(event, id);
      };
      input.addEventListener("midimessage", listener);
      this.#inputs.set(id, { input, listener });
      // Повторное добавление того же id НЕ отменяет pending-reset: reset
      // закрывает прошлый период holdings, даже если вход уже снова активен.
      invalidate();
      changed = true;
    }
    if (changed) {
      // Уведомляем музыкальный поток scoped-reset'ами только о снятых входах.
      // Revision/membership уже инвалидированы до release-колбэков.
      this.#onMonitor(null);
      this.#flushInputResets();
    }
    return changed;
  }

  #allInputsStatus(inputs: MidiDeviceInfo[]): MidiStatus {
    if (inputs.length === 0) return { kind: "no-inputs", message: "Нет входов MIDI." };
    if (inputs.length === 1) {
      return { kind: "connected", message: `MIDI подключён: ${inputs[0]!.name || "MIDI вход"}.` };
    }
    const names = inputs.map((input) => input.name || "MIDI вход").join(", ");
    return {
      kind: "connected",
      message: `MIDI: подключено устройств — ${inputs.length} (${names}).`,
    };
  }

  #handleEvent(event: { data: ArrayLike<number> }, inputId: string): void {
    if (this.#closed()) return;
    const active = this.#inputs.get(inputId);
    if (!active || active.input.state === "disconnected") return;
    const message = decodeMidiMessage(event.data);
    if (!message) return;
    // Снимок делаем ДО onMonitor: внешний колбэк не должен получить ссылку на
    // объект, который затем увидят музыкальные подписчики. onMonitor и
    // lastMessage остаются изменяемым мониторинговым объектом, но learn,
    // routing, флаги и payload действия используют только этот снимок.
    const messageSnapshot: Readonly<MidiMessage> = Object.freeze({ ...message });
    const revision = this.#selectionRevision;
    this.#lastMessage = message;
    this.#detail = "";
    this.#onMonitor(message);
    // onMonitor — внешний колбэк: он мог освободить адаптер ИЛИ переключить
    // вход. В обоих случаях текущее (старое) сообщение не применяется.
    if (!this.#messageStillApplies(inputId, revision)) return;
    // Флаги снимаем ДО mutation mapping'ов в learn/dispatch: подписчик должен
    // видеть routing-состояние на момент прихода сообщения.
    const consumedByLearn =
      this.#learning !== null && (messageSnapshot.source === "cc" || messageSnapshot.on);
    const matchedMapping = this.#matchesMapping(messageSnapshot);
    if (consumedByLearn) {
      // Learn поглощает обычный mapping dispatch, но музыкальный поток обязан
      // получить это сообщение с consumedByLearn=true.
      this.#applyLearn(messageSnapshot, inputId, revision);
      if (!this.#messageStillApplies(inputId, revision)) return;
      this.#deliverInputMessage(
        messageSnapshot,
        inputId,
        revision,
        consumedByLearn,
        matchedMapping,
      );
      return;
    }
    this.#dispatch(messageSnapshot, inputId, revision);
    if (!this.#messageStillApplies(inputId, revision)) return;
    this.#deliverInputMessage(messageSnapshot, inputId, revision, consumedByLearn, matchedMapping);
    if (this.#closed()) return;
    this.#notify();
  }

  #applyLearn(message: Readonly<MidiMessage>, inputId: string, revision: number): void {
    const learning = this.#learning!;
    let mapping: MidiMapping | undefined;
    if (learning.mappingId) {
      mapping = this.#mappings.find((m) => m.id === learning.mappingId);
      if (!mapping) {
        // Строка исчезла между началом обучения и сообщением: не создаём новую.
        this.#learning = null;
        this.#learnMessage = "Назначение для обучения не найдено — обучение отменено.";
        this.#notify();
        return;
      }
    } else {
      mapping = this.#mappings.find((m) => m.target === learning.target);
    }
    if (mapping) {
      this.#releaseMapping(mapping);
      if (this.#closed()) return;
      // releaseMapping пишет в реестр: подписчик мог сменить вход. Тогда
      // обучение отменено, а исходная строка/хранилище НЕ должны получить
      // stale learn из уже неактуального сообщения.
      if (this.#selectionRevision !== revision) {
        this.cancelLearn("Обучение отменено.");
        return;
      }
      mapping.source = message.source;
      mapping.number = message.number;
      mapping.channel = message.channel;
    } else {
      mapping = {
        id: this.#nextId(),
        target: learning.target,
        source: message.source,
        number: message.number,
        channel: message.channel,
        mode: this.#defaultMode(learning.target),
        sensitivity: 1,
        invert: false,
      };
      this.#mappings.push(mapping);
      this.#ensureRuntime(mapping);
    }
    if (message.source === "cc") {
      for (const row of [...this.#mappings]) {
        if (this.#closed()) return;
        if (row.source === "cc" && row.number === message.number) {
          this.#runtimeFor(row).lastValue.set(
            this.#holdKey(inputId, message.channel),
            message.value,
          );
        }
      }
    }
    this.#learning = null;
    this.#learnMessage = `Назначено: ${message.source === "cc" ? "CC" : "Note"} ${message.number}, канал ${message.channel}.`;
    this.#save();
    this.#notify();
  }

  #dispatch(message: Readonly<MidiMessage>, inputId: string, revision: number): void {
    const activated = new Set<string>();
    const details: string[] = [];
    for (const mapping of [...this.#mappings]) {
      if (this.#closed() || this.#selectionRevision !== revision) return;
      if (mapping.source !== message.source || mapping.number !== message.number) continue;
      // Канал — часть адреса назначения: 0 принимает любой, иначе только свой.
      if (mapping.channel !== 0 && mapping.channel !== message.channel) continue;
      const kind = this.#kindOf(mapping.target);
      if (!kind) continue;
      if (kind === "action") {
        this.#dispatchAction(mapping, message, inputId, activated, details);
      } else if (kind === "boolean") {
        this.#dispatchSwitch(mapping, message, inputId);
      } else {
        this.#dispatchNumber(mapping, message, inputId, details);
      }
      // Registry/action-колбэк мог сменить выбранный вход: старое сообщение не
      // должно продолжать применяться к следующим строкам.
      if (this.#closed() || this.#selectionRevision !== revision) return;
    }
    this.#detail = details.join(" · ");
  }

  #dispatchAction(
    mapping: MidiMapping,
    message: Readonly<MidiMessage>,
    inputId: string,
    activated: Set<string>,
    details: string[],
  ): void {
    const runtime = this.#runtimeFor(mapping);
    const cc = message.source === "cc";
    const down = cc ? message.value >= 64 : message.on;
    const key = this.#holdKey(inputId, message.channel);
    const wasDown = runtime.held.has(key);
    if (down) runtime.held.add(key);
    else runtime.held.delete(key);
    // CC — edge по порогу 64: удержание не повторяет и не запускает действие.
    // Note On — самостоятельный удар: повтор до Note Off запускает снова, а
    // Note Off (включая Note On velocity 0) не запускает никогда.
    if (!down || (cc && wasDown) || activated.has(mapping.target)) return;
    if (!this.#actions.isAvailable(mapping.target)) {
      details.push(`${this.#actions.label(mapping.target)}: неактивно`);
      return;
    }
    activated.add(mapping.target);
    // Верхний payload тоже immutable: действие не может подменить inputId или
    // message для последующей обработки; message — frozen-снимок из #handleEvent.
    const input: MidiActionInput = Object.freeze({ kind: "midi", inputId, message });
    void this.#actions.execute(mapping.target, MIDI_ORIGIN, input).catch((error) => {
      if (!this.#closed()) this.#reportError(error);
    });
  }

  #dispatchSwitch(mapping: MidiMapping, message: Readonly<MidiMessage>, inputId: string): void {
    const runtime = this.#runtimeFor(mapping);
    if (message.source === "cc") {
      // CC пишет напрямую, даже если Note того же тумблера удерживается.
      this.#setBoolean(mapping.target, message.value >= 64);
      return;
    }
    const key = this.#holdKey(inputId, message.channel);
    if (message.on) runtime.held.add(key);
    else runtime.held.delete(key);
    this.#setBoolean(mapping.target, this.#anyHeld(mapping.target));
  }

  #dispatchNumber(
    mapping: MidiMapping,
    message: Readonly<MidiMessage>,
    inputId: string,
    details: string[],
  ): void {
    if (message.source === "note" && !message.on) return;
    const spec = this.#params.spec(mapping.target);
    const min = spec.min ?? 0;
    const max = spec.max ?? 1;
    const step = spec.step ?? "any";
    const relative = isRelative(mapping.mode, mapping.source);
    if (relative) {
      // История по паре (вход, канал) обновляется ВСЕГДА, даже при недоступном
      // параметре: иначе повторное включение даёт скачок (stale anchor).
      // Запись — только когда параметр доступен.
      const runtime = this.#runtimeFor(mapping);
      const key = this.#holdKey(inputId, message.channel);
      const previous = runtime.lastValue.has(key) ? runtime.lastValue.get(key)! : null;
      const delta = relativeDelta(mapping.mode, message.value, previous);
      runtime.lastValue.set(key, message.value);
      if (!this.#params.isAvailable(mapping.target)) {
        details.push(`${spec.label}: неактивен`);
        return;
      }
      if (delta === null) {
        details.push(`${spec.label}: относительно, запомнена начальная позиция`);
        return;
      }
      const steps = delta * mapping.sensitivity * (mapping.invert ? -1 : 1);
      const increment = step === "any" ? 1 : step;
      const next = quantize(
        this.#params.getNumber(mapping.target) + steps * increment,
        min,
        max,
        step,
      );
      this.#setNumber(mapping.target, next);
      return;
    }
    if (!this.#params.isAvailable(mapping.target)) {
      details.push(`${spec.label}: неактивен`);
      return;
    }
    const next = quantize(absoluteScale(message.value, min, max), min, max, step);
    this.#setNumber(mapping.target, next);
  }

  #anyHeld(target: string): boolean {
    for (const mapping of this.#mappings) {
      if (mapping.target !== target) continue;
      if (this.#runtimeFor(mapping).held.size > 0) return true;
    }
    return false;
  }

  #setNumber(target: string, value: number): void {
    try {
      this.#params.set(target, value, MIDI_ORIGIN);
    } catch (error) {
      this.#reportError(error);
    }
  }

  #setBoolean(target: string, value: boolean): void {
    if (!this.#params.isAvailable(target)) return;
    try {
      this.#params.set(target, value, MIDI_ORIGIN);
    } catch (error) {
      this.#reportError(error);
    }
  }

  /**
   * Снять только удержания и историю ОДНОГО входа (при hotplug/disconnect или
   * переключении набора входов). Остальные устройства сохраняют состояние.
   */
  #releaseHeldForInput(inputId: string): void {
    const prefix = `${inputId}\u0000`;
    const affected = new Set<string>();
    for (const mapping of this.#mappings) {
      const runtime = this.#runtimeFor(mapping);
      let released = false;
      for (const key of [...runtime.held]) {
        if (!key.startsWith(prefix)) continue;
        runtime.held.delete(key);
        released = true;
      }
      for (const key of [...runtime.lastValue.keys()]) {
        if (key.startsWith(prefix)) runtime.lastValue.delete(key);
      }
      if (released) affected.add(mapping.target);
    }
    for (const target of affected) {
      if (this.#closed()) return;
      if (this.#kindOf(target) === "boolean") {
        this.#setBoolean(target, this.#anyHeld(target));
      }
    }
  }

  /**
   * Снять удержание строки и пересчитать тумблер по ОСТАВШИМСЯ удержаниям цели.
   * Это recompute (может записать и `true`, и `false`), а не безусловный сброс:
   * иначе прямой CC-write `false` при удержанном Note залипал бы после CRUD.
   */
  #releaseMapping(mapping: MidiMapping): void {
    const runtime = this.#runtimeFor(mapping);
    const had = runtime.held.size > 0;
    const target = mapping.target;
    runtime.held.clear();
    runtime.lastValue.clear();
    if (had && this.#kindOf(target) === "boolean") {
      this.#setBoolean(target, this.#anyHeld(target));
    }
  }

  #releaseAllHeld(): void {
    const targets = new Set<string>();
    for (const mapping of this.#mappings) {
      const runtime = this.#runtimeFor(mapping);
      if (runtime.held.size > 0) targets.add(mapping.target);
      runtime.held.clear();
      runtime.lastValue.clear();
    }
    for (const target of targets) {
      if (this.#kindOf(target) === "boolean") {
        this.#setBoolean(target, this.#anyHeld(target));
      }
    }
  }

  /**
   * Сообщение ещё адресует тот же вход и не инвалидировано сменой набора
   * входов/освобождением адаптера. Проверяется перед каждым музыкальным
   * подписчиком: предыдущий callback мог всё изменить.
   */
  #messageStillApplies(inputId: string, revision: number): boolean {
    if (this.#closed()) return false;
    if (this.#selectionRevision !== revision) return false;
    const active = this.#inputs.get(inputId);
    return active !== undefined && active.input.state !== "disconnected";
  }

  /** Есть ли строка source/number/channel, независимо от доступности цели. */
  #matchesMapping(message: Readonly<MidiMessage>): boolean {
    return this.#mappings.some(
      (mapping) =>
        mapping.source === message.source &&
        mapping.number === message.number &&
        (mapping.channel === 0 || mapping.channel === message.channel),
    );
  }

  /**
   * Доставить музыкальный снимок всем opt-in подписчикам. Ошибка одного
   * сообщается через onError и не мешает остальным; отписавшиеся во время
   * обхода пропускаются; между подписчиками проверяется актуальность события.
   */
  #deliverInputMessage(
    messageSnapshot: Readonly<MidiMessage>,
    inputId: string,
    revision: number,
    consumedByLearn: boolean,
    matchedMapping: boolean,
  ): void {
    const event: MidiInputEvent = {
      type: "message",
      inputId,
      message: messageSnapshot,
      consumedByLearn,
      matchedMapping,
    };
    Object.freeze(event);
    const listeners = [...this.#inputListeners];
    for (const listener of listeners) {
      if (!this.#inputListeners.has(listener)) continue;
      if (!this.#messageStillApplies(inputId, revision)) return;
      try {
        listener(event);
      } catch (error) {
        this.#reportError(error);
      }
    }
  }

  /**
   * Зафиксировать обязательство reset'а. Вызывается до внешних registry-
   * колбэков; повтор для того же входа не создаёт вторую запись, `dispose`
   * повышает причину до терминальной.
   */
  #enqueueInputReset(inputId: string, reason: "disconnect" | "selection" | "dispose"): void {
    const existing = this.#pendingInputResets.find((entry) => entry.inputId === inputId);
    if (existing) {
      if (reason === "dispose") existing.reason = "dispose";
      return;
    }
    this.#pendingInputResets.push({ inputId, reason });
  }

  /**
   * Доставить все накопленные reset'ы. Реентерабельный вызов (dispose/
   * selection из listener'а или registry-колбэка) только добавляет записи в
   * очередь; дренирует её самый внешний вызов. Очистка dispose откладывается
   * до конца обхода, поэтому оставшиеся подписчики получают reset.
   */
  #flushInputResets(): void {
    if (this.#inputResetDeliveryDepth > 0) return;
    this.#inputResetDeliveryDepth++;
    try {
      while (this.#pendingInputResets.length > 0) {
        const entry = this.#pendingInputResets.shift()!;
        this.#deliverInputReset(entry.inputId, entry.reason);
      }
    } finally {
      this.#inputResetDeliveryDepth--;
      if (this.#inputResetDeliveryDepth === 0) this.#cleanupAfterDispose();
    }
  }

  /** Scoped reset одного входа; errors listener'ов не прерывают остальных. */
  #deliverInputReset(inputId: string, reason: "disconnect" | "selection" | "dispose"): void {
    const event: MidiInputEvent = { type: "input-reset", inputId, reason };
    Object.freeze(event);
    const listeners = [...this.#inputListeners];
    for (const listener of listeners) {
      if (!this.#inputListeners.has(listener)) continue;
      try {
        listener(event);
      } catch (error) {
        this.#reportError(error);
      }
    }
  }

  /**
   * Терминальная очистка ресурсов. Выполняется после дренажа reset-очереди,
   * в том числе если dispose был вызван из listener'а reset'а.
   */
  #cleanupAfterDispose(): void {
    if (!this.#disposeCleanupPending || this.#inputResetDeliveryDepth > 0) return;
    this.#disposeCleanupPending = false;
    this.#pendingInputResets.length = 0;
    if (this.#unsubscribeStateChange) {
      try {
        this.#unsubscribeStateChange();
      } catch (error) {
        console.error("[labkit] ошибка отписки MIDI state change", error);
      }
      this.#unsubscribeStateChange = null;
    }
    for (const active of this.#inputs.values()) {
      active.input.removeEventListener("midimessage", active.listener);
    }
    this.#inputs.clear();
    this.#access = null;
    this.#learning = null;
    this.#inputListeners.clear();
  }

  #setStatus(status: MidiStatus): void {
    this.#status = status;
    this.#onStatus(status);
    this.#notify();
  }

  #reportError(error: unknown): void {
    if (this.#disposed) {
      console.error("[labkit] ошибка MIDI после dispose", error);
      return;
    }
    try {
      this.#onError(error);
    } catch (callbackError) {
      console.error("[labkit] ошибка обработчика onError MIDI", callbackError);
    }
  }

  #notify(): void {
    if (this.#closed()) return;
    try {
      this.#onChange();
    } catch (callbackError) {
      console.error("[labkit] ошибка обработчика onChange MIDI", callbackError);
    }
    // onChange — внешний колбэк: он мог освободить адаптер. Тогда подписчики
    // (UI-панель) не должны получать уведомление о мёртвом состоянии.
    if (this.#closed()) return;
    for (const listener of [...this.#listeners]) {
      if (this.#closed()) return;
      try {
        listener();
      } catch (callbackError) {
        console.error("[labkit] ошибка подписчика MIDI", callbackError);
      }
    }
  }
}
