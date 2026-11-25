// Владение ресурсами экземпляра. dispose() идемпотентный и awaitable: повторный
// вызов (в том числе reentrant из освободителя) возвращает тот же промис.
//
// Промис публикуется ДО запуска освободителей, а синхронные освободители
// выполняются синхронно до первого асинхронного — поэтому очистка на неудачном
// createLab остаётся синхронной.
//
// Политика late-add: после начала dispose scope «закрыт». add()/listen()
// после dispose — ЯВНАЯ ошибка (никаких untracked fire-and-forget ресурсов).
// Освободитель не должен await-ить собственный scope.dispose() (это
// самоблокировка); для наблюдения промис можно только захватить/сравнить.
//
// Если один или несколько освободителей бросили, остальные всё равно
// выполняются, но итоговый промис отклоняется AggregateError — dispose НЕ
// считается успешным.

export type Disposer = () => void | Promise<void>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class Scope {
  #disposers: Disposer[] = [];
  #disposed = false;
  #disposal: Promise<void> | null = null;

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Добавить освободитель. После dispose() — явная ошибка. */
  add(disposer: Disposer): void {
    if (this.#disposed) {
      throw new Error("labkit: Scope уже освобождается — add после dispose запрещён");
    }
    this.#disposers.push(disposer);
  }

  listen(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void {
    // Проверяем ДО addEventListener, чтобы на закрытом scope не осталось слушателя.
    if (this.#disposed) {
      throw new Error("labkit: Scope уже освобождается — listen после dispose запрещён");
    }
    target.addEventListener(type, handler, options);
    this.add(() => target.removeEventListener(type, handler, options));
  }

  dispose(): Promise<void> {
    if (this.#disposal) {
      return this.#disposal;
    }
    this.#disposed = true;
    const list = this.#disposers.splice(0).reverse();
    const gate = deferred<void>();
    // Публикуем промис до запуска освободителей: reentrant dispose() получает
    // тот же промис; барьер не заканчивается раньше запланированной очистки.
    this.#disposal = gate.promise;
    // Подавляем unhandled-rejection шум; rejection доступен вызывающему и
    // обрабатывается им (createLab/instance.dispose).
    gate.promise.catch(() => {});
    this.#run(list, 0, [], gate);
    return gate.promise;
  }

  #run(list: readonly Disposer[], index: number, errors: unknown[], gate: Deferred<void>): void {
    for (let i = index; i < list.length; i++) {
      const disposer = list[i];
      if (!disposer) continue;
      let result: void | Promise<void>;
      try {
        result = disposer();
      } catch (error) {
        errors.push(error);
        continue;
      }
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).then(
          () => this.#run(list, i + 1, errors, gate),
          (error) => {
            errors.push(error);
            this.#run(list, i + 1, errors, gate);
          },
        );
        return;
      }
    }
    if (errors.length > 0) {
      gate.reject(
        new AggregateError(errors, `labkit: ошибки при освобождении ресурсов (${errors.length})`),
      );
    } else {
      gate.resolve();
    }
  }
}
