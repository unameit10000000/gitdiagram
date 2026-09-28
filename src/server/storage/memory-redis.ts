// A self-contained in-memory Redis for local development, used when
// UPSTASH_REDIS_REST_URL/TOKEN are not configured. It implements the command
// subset and the Lua EVAL scripts the application uses, so a local server can
// run without any external account. State lives in this process only.

interface MemoryEntry {
  value?: string;
  hash?: Map<string, string>;
  list?: string[];
  zset?: Map<string, number>;
  expiresAt?: number;
}

const STORE_SYMBOL = Symbol.for("gitdiagram.memory-redis.store");

function nowMs(): number {
  return Date.now();
}

function getStore(): Map<string, MemoryEntry> {
  const globalObject = globalThis as unknown as Record<PropertyKey, unknown>;
  let store = globalObject[STORE_SYMBOL] as Map<string, MemoryEntry> | undefined;
  if (!store) {
    store = new Map();
    globalObject[STORE_SYMBOL] = store;
  }
  return store;
}

function getEntry(key: string): MemoryEntry | null {
  const store = getStore();
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== undefined && entry.expiresAt <= nowMs()) {
    store.delete(key);
    return null;
  }
  return entry;
}

function putEntry(key: string, entry: MemoryEntry): void {
  getStore().set(key, entry);
}

function argString(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function argNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function rangeIndex(index: number, length: number): number {
  const resolved = index < 0 ? length + index : index;
  return Math.max(0, Math.min(resolved, length - 1));
}

function scoreBound(value: string): number {
  if (value === "-inf") return Number.NEGATIVE_INFINITY;
  if (value === "+inf") return Number.POSITIVE_INFINITY;
  return Number(value);
}

function bump(key: string, delta: number): number {
  const entry = getEntry(key) ?? {};
  const next = Number(entry.value ?? "0") + delta;
  entry.value = String(next);
  putEntry(key, entry);
  return next;
}

/** Executes a single Redis command against the in-memory store. */
export function memoryRedisCommand(command: unknown[]): unknown {
  const name = argString(command[0]).toUpperCase();
  const args = command.slice(1);
  const store = getStore();

  switch (name) {
    case "GET": {
      const entry = getEntry(argString(args[0]));
      return entry?.value ?? null;
    }
    case "SET": {
      const key = argString(args[0]);
      const value = argString(args[1]);
      let nx = false;
      let ttlMs: number | null = null;
      let keepTtl = false;
      for (let index = 2; index < args.length; index += 1) {
        const flag = argString(args[index]).toUpperCase();
        if (flag === "NX") nx = true;
        else if (flag === "EX") {
          ttlMs = argNumber(args[index + 1]) * 1000;
          index += 1;
        } else if (flag === "PX") {
          ttlMs = argNumber(args[index + 1]);
          index += 1;
        } else if (flag === "KEEPTTL") keepTtl = true;
      }
      const existing = getEntry(key);
      if (nx && existing) return null;
      const entry: MemoryEntry = { value };
      if (ttlMs !== null) entry.expiresAt = nowMs() + ttlMs;
      else if (keepTtl && existing?.expiresAt !== undefined)
        entry.expiresAt = existing.expiresAt;
      putEntry(key, entry);
      return "OK";
    }
    case "DEL": {
      let removed = 0;
      for (const key of args) {
        const resolved = argString(key);
        if (getEntry(resolved)) {
          store.delete(resolved);
          removed += 1;
        }
      }
      return removed;
    }
    case "INCR":
      return bump(argString(args[0]), 1);
    case "DECR":
      return bump(argString(args[0]), -1);
    case "EXPIRE": {
      const key = argString(args[0]);
      const entry = getEntry(key);
      if (!entry) return 0;
      entry.expiresAt = nowMs() + argNumber(args[1]) * 1000;
      putEntry(key, entry);
      return 1;
    }
    case "PEXPIRE": {
      const key = argString(args[0]);
      const entry = getEntry(key);
      if (!entry) return 0;
      entry.expiresAt = nowMs() + argNumber(args[1]);
      putEntry(key, entry);
      return 1;
    }
    case "TTL": {
      const entry = getEntry(argString(args[0]));
      if (!entry) return -2;
      if (entry.expiresAt === undefined) return -1;
      return Math.max(0, Math.round((entry.expiresAt - nowMs()) / 1000));
    }
    case "EXISTS":
      return getEntry(argString(args[0])) ? 1 : 0;
    case "MGET":
      return args.map((key) => getEntry(argString(key))?.value ?? null);
    case "HGET": {
      const entry = getEntry(argString(args[0]));
      return entry?.hash?.get(argString(args[1])) ?? null;
    }
    case "HGETALL": {
      const entry = getEntry(argString(args[0]));
      if (!entry?.hash) return [];
      return [...entry.hash.entries()].flatMap(([field, value]) => [
        field,
        value,
      ]);
    }
    case "HSET": {
      const key = argString(args[0]);
      const entry = getEntry(key) ?? {};
      entry.hash ??= new Map();
      for (let index = 1; index < args.length; index += 2)
        entry.hash.set(argString(args[index]), argString(args[index + 1]));
      putEntry(key, entry);
      return (args.length - 1) / 2;
    }
    case "HDEL": {
      const entry = getEntry(argString(args[0]));
      let removed = 0;
      if (entry?.hash)
        for (let index = 1; index < args.length; index += 1)
          if (entry.hash.delete(argString(args[index]))) removed += 1;
      return removed;
    }
    case "HEXISTS": {
      const entry = getEntry(argString(args[0]));
      return entry?.hash?.has(argString(args[1])) ? 1 : 0;
    }
    case "HVALS": {
      const entry = getEntry(argString(args[0]));
      return entry?.hash ? [...entry.hash.values()] : [];
    }
    case "ZADD": {
      const key = argString(args[0]);
      const entry = getEntry(key) ?? {};
      entry.zset ??= new Map();
      let added = 0;
      for (let index = 1; index < args.length; index += 2) {
        const member = argString(args[index + 1]);
        if (!entry.zset.has(member)) added += 1;
        entry.zset.set(member, argNumber(args[index]));
      }
      putEntry(key, entry);
      return added;
    }
    case "ZREM": {
      const entry = getEntry(argString(args[0]));
      let removed = 0;
      if (entry?.zset)
        for (let index = 1; index < args.length; index += 1)
          if (entry.zset.delete(argString(args[index]))) removed += 1;
      return removed;
    }
    case "ZCARD":
      return getEntry(argString(args[0]))?.zset?.size ?? 0;
    case "ZRANGEBYSCORE": {
      const entry = getEntry(argString(args[0]));
      const min = scoreBound(argString(args[1]));
      const max = scoreBound(argString(args[2]));
      if (!entry?.zset) return [];
      return [...entry.zset.entries()]
        .filter(([, score]) => score >= min && score <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    }
    case "ZREMRANGEBYSCORE": {
      const entry = getEntry(argString(args[0]));
      const min = scoreBound(argString(args[1]));
      const max = scoreBound(argString(args[2]));
      let removed = 0;
      if (entry?.zset)
        for (const [member, score] of [...entry.zset]) {
          if (score >= min && score <= max) {
            entry.zset.delete(member);
            removed += 1;
          }
        }
      return removed;
    }
    case "RPUSH": {
      const key = argString(args[0]);
      const entry = getEntry(key) ?? {};
      entry.list ??= [];
      for (let index = 1; index < args.length; index += 1)
        entry.list.push(argString(args[index]));
      putEntry(key, entry);
      return entry.list.length;
    }
    case "LRANGE": {
      const list = getEntry(argString(args[0]))?.list ?? [];
      const start = rangeIndex(argNumber(args[1]), list.length);
      const stop = rangeIndex(argNumber(args[2]), list.length);
      const result: string[] = [];
      if (list.length > 0)
        for (let index = start; index <= stop; index += 1) {
          const value = list[index];
          if (value !== undefined) result.push(value);
        }
      return result;
    }
    case "LTRIM": {
      const key = argString(args[0]);
      const entry = getEntry(key);
      if (entry?.list) {
        const start = rangeIndex(argNumber(args[1]), entry.list.length);
        const stop = rangeIndex(argNumber(args[2]), entry.list.length);
        entry.list = entry.list.slice(start, stop + 1);
      }
      return "OK";
    }
    default:
      throw new Error(
        `Unsupported Redis command in the in-memory fallback: ${name}.`,
      );
  }
}

type LuaValue = null | boolean | number | string | LuaTable;

class LuaTable {
  constructor(public readonly items: LuaValue[] = []) {}

  get length(): number {
    return this.items.length;
  }

  get(index: number): LuaValue {
    const value = this.items[index - 1];
    return value === undefined ? null : value;
  }
}

interface LuaExpr {
  kind:
    | "num"
    | "str"
    | "nil"
    | "bool"
    | "name"
    | "index"
    | "call"
    | "table"
    | "binop"
    | "unop";
  name?: string;
  value?: number | string | boolean;
  object?: LuaExpr;
  key?: LuaExpr;
  args?: LuaExpr[];
  items?: LuaExpr[];
  op?: string;
  left?: LuaExpr;
  right?: LuaExpr;
  operand?: LuaExpr;
}

interface LuaStmt {
  kind: "local" | "assign" | "exprstmt" | "if" | "fornum" | "forin" | "return";
  name?: string;
  expr?: LuaExpr | null;
  clauses?: Array<{ cond: LuaExpr; body: LuaStmt[] }>;
  elseBody?: LuaStmt[] | null;
  start?: LuaExpr;
  end?: LuaExpr;
  step?: LuaExpr | null;
  indexName?: string;
  valueName?: string;
  iterable?: LuaExpr;
  body?: LuaStmt[];
}

interface LuaProgram {
  body: LuaStmt[];
}

type Token =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "name"; value: string }
  | { type: "op"; value: string }
  | { type: "eof" };

function tokenizeLua(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index += 1;
      continue;
    }
    if (char === "-" && source[index + 1] === "-") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== quote) {
        const current = source[index]!;
        if (current === "\\" && index + 1 < source.length) {
          const escaped = source[index + 1]!;
          if (escaped === "n") value += "\n";
          else if (escaped === "t") value += "\t";
          else if (escaped === "r") value += "\r";
          else value += escaped;
          index += 2;
        } else {
          value += current;
          index += 1;
        }
      }
      if (source[index] !== quote)
        throw new Error("Unterminated string literal in an EVAL script.");
      index += 1;
      tokens.push({ type: "str", value });
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      let value = "";
      while (index < source.length && /[0-9.]/.test(source[index] ?? "")) {
        value += source[index];
        index += 1;
      }
      tokens.push({ type: "num", value: Number(value) });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = "";
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index] ?? "")) {
        value += source[index];
        index += 1;
      }
      tokens.push({ type: "name", value });
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (pair === ".." || pair === "==" || pair === "~=" || pair === "<=" || pair === ">=") {
      tokens.push({ type: "op", value: pair });
      index += 2;
      continue;
    }
    if ("+-*/%<>=(){}[].,;#".includes(char)) {
      tokens.push({ type: "op", value: char });
      index += 1;
      continue;
    }
    throw new Error(
      `Unsupported character ${JSON.stringify(char)} in an EVAL script.`,
    );
  }
  tokens.push({ type: "eof" });
  return tokens;
}

class LuaParser {
  private position = 0;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): LuaProgram {
    const body = this.parseBlock();
    if (this.peek().type !== "eof")
      throw new Error("Unexpected trailing tokens in an EVAL script.");
    return { body };
  }

  private peek(): Token {
    return this.tokens[this.position]!;
  }

  private next(): Token {
    const token = this.tokens[this.position]!;
    if (token.type !== "eof") this.position += 1;
    return token;
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token.type === "op" && token.value === value;
  }

  private isKeyword(value: string): boolean {
    const token = this.peek();
    return token.type === "name" && token.value === value;
  }

  private expectOp(value: string): void {
    const token = this.next();
    if (token.type !== "op" || token.value !== value)
      throw new Error(
        `Expected "${value}" in an EVAL script, found ${JSON.stringify(token.value)}.`,
      );
  }

  private expectName(): string {
    const token = this.next();
    if (token.type !== "name")
      throw new Error(`Expected a name in an EVAL script.`);
    return token.value;
  }

  private expectKeyword(value: string): void {
    const token = this.next();
    if (token.type !== "name" || token.value !== value)
      throw new Error(`Expected "${value}" in an EVAL script.`);
  }

  private parseBlock(): LuaStmt[] {
    const statements: LuaStmt[] = [];
    while (true) {
      if (this.peek().type === "eof") break;
      if (this.isKeyword("end") || this.isKeyword("elseif") || this.isKeyword("else"))
        break;
      statements.push(this.parseStatement());
    }
    return statements;
  }

  private parseStatement(): LuaStmt {
    if (this.isKeyword("local")) {
      this.next();
      const name = this.expectName();
      let expr: LuaExpr | null = null;
      if (this.isOp("=")) {
        this.next();
        expr = this.parseExpr();
      }
      return { kind: "local", name, expr };
    }
    if (this.isKeyword("if")) return this.parseIfStatement();
    if (this.isKeyword("for")) return this.parseForStatement();
    if (this.isKeyword("return")) {
      this.next();
      let expr: LuaExpr | null = null;
      if (!this.isOp(";") && this.peek().type !== "eof" && !this.isKeyword("end"))
        expr = this.parseExpr();
      return { kind: "return", expr };
    }
    const expr = this.parseExpr();
    if (expr.kind === "name" && this.isOp("=")) {
      this.next();
      const value = this.parseExpr();
      return { kind: "assign", name: expr.name, expr: value };
    }
    return { kind: "exprstmt", expr };
  }

  private parseIfStatement(): LuaStmt {
    this.next();
    const clauses: Array<{ cond: LuaExpr; body: LuaStmt[] }> = [];
    let cond = this.parseExpr();
    this.expectKeyword("then");
    let body = this.parseBlock();
    clauses.push({ cond, body });
    while (this.isKeyword("elseif")) {
      this.next();
      cond = this.parseExpr();
      this.expectKeyword("then");
      body = this.parseBlock();
      clauses.push({ cond, body });
    }
    let elseBody: LuaStmt[] | null = null;
    if (this.isKeyword("else")) {
      this.next();
      elseBody = this.parseBlock();
    }
    this.expectKeyword("end");
    return { kind: "if", clauses, elseBody };
  }

  private parseForStatement(): LuaStmt {
    this.next();
    const firstName = this.expectName();
    if (this.isOp("=")) {
      this.next();
      const start = this.parseExpr();
      this.expectOp(",");
      const end = this.parseExpr();
      let step: LuaExpr | null = null;
      if (this.isOp(",")) {
        this.next();
        step = this.parseExpr();
      }
      this.expectKeyword("do");
      const body = this.parseBlock();
      this.expectKeyword("end");
      return { kind: "fornum", name: firstName, start, end, step, body };
    }
    this.expectOp(",");
    const secondName = this.expectName();
    this.expectKeyword("in");
    const iterable = this.parseExpr();
    this.expectKeyword("do");
    const body = this.parseBlock();
    this.expectKeyword("end");
    return {
      kind: "forin",
      indexName: firstName,
      valueName: secondName,
      iterable,
      body,
    };
  }

  private parseExpr(): LuaExpr {
    return this.parseOr();
  }

  private parseOr(): LuaExpr {
    let left = this.parseAnd();
    while (this.isKeyword("or")) {
      this.next();
      const right = this.parseAnd();
      left = { kind: "binop", op: "or", left, right };
    }
    return left;
  }

  private parseAnd(): LuaExpr {
    let left = this.parseCompare();
    while (this.isKeyword("and")) {
      this.next();
      const right = this.parseCompare();
      left = { kind: "binop", op: "and", left, right };
    }
    return left;
  }

  private parseCompare(): LuaExpr {
    let left = this.parseAdditive();
    const token = this.peek();
    if (
      token.type === "op" &&
      ["==", "~=", "<", ">", "<=", ">="].includes(token.value)
    ) {
      this.next();
      const right = this.parseAdditive();
      left = { kind: "binop", op: token.value, left, right };
    }
    return left;
  }

  private parseAdditive(): LuaExpr {
    let left = this.parseMultiplicative();
    while (true) {
      const token = this.peek();
      if (token.type === "op" && (token.value === "+" || token.value === "-")) {
        this.next();
        const right = this.parseMultiplicative();
        left = { kind: "binop", op: token.value, left, right };
      } else break;
    }
    return left;
  }

  private parseMultiplicative(): LuaExpr {
    let left = this.parseUnary();
    while (true) {
      const token = this.peek();
      if (token.type === "op" && ["*", "/", "%"].includes(token.value)) {
        this.next();
        const right = this.parseUnary();
        left = { kind: "binop", op: token.value, left, right };
      } else break;
    }
    return left;
  }

  private parseUnary(): LuaExpr {
    const token = this.peek();
    if (token.type === "op" && (token.value === "-" || token.value === "#")) {
      this.next();
      return { kind: "unop", op: token.value, operand: this.parseUnary() };
    }
    if (token.type === "name" && token.value === "not") {
      this.next();
      return { kind: "unop", op: "not", operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): LuaExpr {
    const token = this.next();
    switch (token.type) {
      case "num":
        return { kind: "num", value: token.value };
      case "str":
        return { kind: "str", value: token.value };
      case "op":
        if (token.value === "(") {
          const expr = this.parseExpr();
          this.expectOp(")");
          return expr;
        }
        if (token.value === "{") {
          const items: LuaExpr[] = [];
          while (!this.isOp("}")) {
            items.push(this.parseExpr());
            if (this.isOp(",")) this.next();
            else break;
          }
          this.expectOp("}");
          return { kind: "table", items };
        }
        throw new Error(
          `Unexpected token ${JSON.stringify(token.value)} in an EVAL script.`,
        );
      case "name": {
        if (token.value === "nil") return { kind: "nil" };
        if (token.value === "true") return { kind: "bool", value: true };
        if (token.value === "false") return { kind: "bool", value: false };
        let name = token.value;
        while (this.isOp(".")) {
          this.next();
          name += `.${this.expectName()}`;
        }
        if (this.isOp("(")) {
          this.next();
          const args = this.parseArguments();
          return { kind: "call", name, args };
        }
        if (this.isOp("[")) {
          this.next();
          const key = this.parseExpr();
          this.expectOp("]");
          return { kind: "index", object: { kind: "name", name }, key };
        }
        return { kind: "name", name };
      }
      default:
        throw new Error("Unexpected token in an EVAL script.");
    }
  }

  private parseArguments(): LuaExpr[] {
    const args: LuaExpr[] = [];
    while (!this.isOp(")")) {
      args.push(this.parseExpr());
      if (this.isOp(",")) this.next();
      else break;
    }
    this.expectOp(")");
    return args;
  }
}

class ReturnSignal {
  constructor(public readonly value: LuaValue) {}
}

class LuaRuntime {
  private readonly scopeStack: Array<Map<string, LuaValue>> = [new Map()];

  constructor(
    private readonly keys: string[],
    private readonly args: Array<string | number>,
  ) {}

  run(program: LuaProgram): LuaValue {
    try {
      this.execBlock(program.body);
    } catch (error) {
      if (error instanceof ReturnSignal) return error.value;
      throw error;
    }
    return null;
  }

  private pushScope(): void {
    this.scopeStack.push(new Map());
  }

  private popScope(): void {
    this.scopeStack.pop();
  }

  private declare(name: string, value: LuaValue): void {
    const scope = this.scopeStack[this.scopeStack.length - 1]!;
    scope.set(name, value);
  }

  private lookup(name: string): LuaValue {
    for (let index = this.scopeStack.length - 1; index >= 0; index -= 1) {
      const value = this.scopeStack[index]!.get(name);
      if (value !== undefined) return value;
    }
    if (name === "KEYS") return new LuaTable(this.keys);
    if (name === "ARGV") return new LuaTable(this.args);
    return null;
  }

  private assign(name: string, value: LuaValue): void {
    for (let index = this.scopeStack.length - 1; index >= 0; index -= 1) {
      const scope = this.scopeStack[index]!;
      if (scope.has(name)) {
        scope.set(name, value);
        return;
      }
    }
    this.declare(name, value);
  }

  private execBlock(statements: LuaStmt[]): void {
    this.pushScope();
    try {
      for (const statement of statements) this.execStatement(statement);
    } finally {
      this.popScope();
    }
  }

  private execStatement(statement: LuaStmt): void {
    switch (statement.kind) {
      case "local":
        this.declare(
          statement.name!,
          statement.expr ? this.evalExpr(statement.expr) : null,
        );
        break;
      case "assign":
        this.assign(statement.name!, this.evalExpr(statement.expr!));
        break;
      case "exprstmt":
        this.evalExpr(statement.expr!);
        break;
      case "return":
        throw new ReturnSignal(
          statement.expr ? this.evalExpr(statement.expr) : null,
        );
      case "if": {
        for (const clause of statement.clauses!) {
          if (this.truthy(this.evalExpr(clause.cond))) {
            this.execBlock(clause.body);
            return;
          }
        }
        if (statement.elseBody) this.execBlock(statement.elseBody);
        break;
      }
      case "fornum": {
        const start = this.asNumber(this.evalExpr(statement.start!));
        const end = this.asNumber(this.evalExpr(statement.end!));
        const step = statement.step
          ? this.asNumber(this.evalExpr(statement.step))
          : 1;
        if (step === 0) throw new Error("Zero step in a numeric for loop.");
        for (
          let value = start;
          step > 0 ? value <= end : value >= end;
          value += step
        ) {
          this.pushScope();
          try {
            this.declare(statement.name!, value);
            for (const inner of statement.body!) this.execStatement(inner);
          } finally {
            this.popScope();
          }
        }
        break;
      }
      case "forin": {
        const iterable = statement.iterable!;
        const values =
          iterable.kind === "call"
            ? this.evalCall(iterable.name!, iterable.args ?? [])
            : this.evalExpr(iterable);
        if (!Array.isArray(values))
          throw new Error("ipairs(...) must be used in a generic for loop.");
        for (let index = 0; index < values.length; index += 1) {
          this.pushScope();
          try {
            this.declare(statement.indexName!, index + 1);
            this.declare(statement.valueName!, values[index]!);
            for (const inner of statement.body!) this.execStatement(inner);
          } finally {
            this.popScope();
          }
        }
        break;
      }
    }
  }

  private evalExpr(expr: LuaExpr): LuaValue {
    switch (expr.kind) {
      case "num":
        return expr.value as number;
      case "str":
        return expr.value as string;
      case "nil":
        return null;
      case "bool":
        return expr.value as boolean;
      case "name":
        return this.lookup(expr.name!);
      case "index": {
        const object = this.evalExpr(expr.object!);
        const key = this.evalExpr(expr.key!);
        if (object instanceof LuaTable && typeof key === "number")
          return object.get(key);
        return null;
      }
      case "table":
        return new LuaTable(expr.items!.map((item) => this.evalExpr(item)));
      case "unop":
        return this.evalUnary(expr.op!, expr.operand!);
      case "binop":
        return this.evalBinary(expr.op!, expr.left!, expr.right!);
      case "call": {
        const value = this.evalCall(expr.name!, expr.args ?? []);
        return Array.isArray(value) ? (value[0] ?? null) : value;
      }
    }
  }

  private evalUnary(op: string, operand: LuaExpr): LuaValue {
    const value = this.evalExpr(operand);
    if (op === "not") return !this.truthy(value);
    if (op === "-") {
      if (typeof value !== "number")
        throw new Error("Attempt to negate a non-number in an EVAL script.");
      return -value;
    }
    if (op === "#") {
      if (value instanceof LuaTable) return value.length;
      if (typeof value === "string") return value.length;
      throw new Error(
        "Attempt to take the length of a non-table in an EVAL script.",
      );
    }
    throw new Error(`Unsupported unary operator ${op}.`);
  }

  private evalBinary(op: string, left: LuaExpr, right: LuaExpr): LuaValue {
    if (op === "and") {
      const leftValue = this.evalExpr(left);
      return this.truthy(leftValue) ? this.evalExpr(right) : leftValue;
    }
    if (op === "or") {
      const leftValue = this.evalExpr(left);
      return this.truthy(leftValue) ? leftValue : this.evalExpr(right);
    }
    const leftValue = this.evalExpr(left);
    const rightValue = this.evalExpr(right);
    switch (op) {
      case "==":
        return leftValue === rightValue;
      case "~=":
        return leftValue !== rightValue;
      case "+":
        return this.asNumber(leftValue) + this.asNumber(rightValue);
      case "-":
        return this.asNumber(leftValue) - this.asNumber(rightValue);
      case "*":
        return this.asNumber(leftValue) * this.asNumber(rightValue);
      case "/":
        return this.asNumber(leftValue) / this.asNumber(rightValue);
      case "%":
        return this.asNumber(leftValue) % this.asNumber(rightValue);
      case "<":
        return this.compare(leftValue, rightValue) < 0;
      case ">":
        return this.compare(leftValue, rightValue) > 0;
      case "<=":
        return this.compare(leftValue, rightValue) <= 0;
      case ">=":
        return this.compare(leftValue, rightValue) >= 0;
      default:
        throw new Error(`Unsupported binary operator ${op}.`);
    }
  }

  private compare(left: LuaValue, right: LuaValue): number {
    if (typeof left === "number" && typeof right === "number")
      return left < right ? -1 : left > right ? 1 : 0;
    if (typeof left === "string" && typeof right === "string")
      return left < right ? -1 : left > right ? 1 : 0;
    throw new Error("Cannot compare these values in an EVAL script.");
  }

  private asNumber(value: LuaValue): number {
    if (typeof value === "number") return value;
    throw new Error("Expected a number in an EVAL script.");
  }

  private asString(value: LuaValue): string {
    if (typeof value === "string") return value;
    return String(value);
  }

  private truthy(value: LuaValue): boolean {
    return value !== null && value !== false;
  }

  private evalArguments(exprs: LuaExpr[]): LuaValue[] {
    const result: LuaValue[] = [];
    for (const expr of exprs) {
      const value =
        expr.kind === "call"
          ? this.evalCall(expr.name!, expr.args ?? [])
          : this.evalExpr(expr);
      if (Array.isArray(value)) result.push(...value);
      else result.push(value);
    }
    return result;
  }

  private evalCall(name: string, args: LuaExpr[]): LuaValue | LuaValue[] {
    const evaluated = this.evalArguments(args);
    switch (name) {
      case "redis.call": {
        const commandName = this.asString(evaluated[0] ?? null);
        const commandArgs = evaluated.slice(1);
        return toLuaValue(memoryRedisCommand([commandName, ...commandArgs]));
      }
      case "tonumber": {
        const value = evaluated[0] ?? null;
        if (typeof value === "number") return value;
        if (typeof value === "string") {
          const parsed = Number(value.trim());
          return Number.isNaN(parsed) ? null : parsed;
        }
        return null;
      }
      case "tostring": {
        const value = evaluated[0] ?? null;
        if (value === null) return "nil";
        if (typeof value === "boolean") return value ? "true" : "false";
        return String(value);
      }
      case "math.max":
        return Math.max(...evaluated.map((value) => this.asNumber(value)));
      case "math.min":
        return Math.min(...evaluated.map((value) => this.asNumber(value)));
      case "string.find": {
        const subject = evaluated[0] ?? null;
        const pattern = evaluated[1] ?? null;
        const start = typeof evaluated[2] === "number" ? evaluated[2] : 1;
        const plain = evaluated[3] === true;
        if (typeof subject !== "string" || typeof pattern !== "string")
          throw new Error("string.find needs string arguments.");
        const from =
          start < 0 ? Math.max(subject.length + start + 1, 1) : start;
        const found = plain
          ? subject.indexOf(pattern, from - 1)
          : subject.search(this.patternToRegExp(pattern));
        return found < 0 ? null : found + 1;
      }
      case "string.sub": {
        const subject = evaluated[0] ?? null;
        const start = evaluated[1] ?? null;
        const stop = evaluated[2] ?? -1;
        if (typeof subject !== "string" || typeof start !== "number")
          throw new Error("string.sub needs a string and a start index.");
        const length = subject.length;
        const from = start < 0 ? Math.max(length + start + 1, 1) : start;
        const to = typeof stop === "number" ? (stop < 0 ? length + stop + 1 : stop) : length;
        const sliceStart = Math.max(from, 1) - 1;
        const sliceEnd = Math.min(to, length);
        if (sliceEnd < sliceStart) return "";
        return subject.slice(sliceStart, sliceEnd);
      }
      case "string.match": {
        const subject = evaluated[0] ?? null;
        const pattern = evaluated[1] ?? null;
        if (typeof subject !== "string" || typeof pattern !== "string")
          throw new Error("string.match needs string arguments.");
        const match = new RegExp(this.patternToRegExp(pattern)).exec(subject);
        if (!match) return null;
        return match[1] ?? match[0] ?? null;
      }
      case "unpack": {
        const table = evaluated[0] ?? null;
        if (!(table instanceof LuaTable))
          throw new Error("unpack needs a table.");
        const from = typeof evaluated[1] === "number" ? evaluated[1] : 1;
        const to = typeof evaluated[2] === "number" ? evaluated[2] : table.length;
        const result: LuaValue[] = [];
        for (let index = from; index <= to; index += 1)
          result.push(table.get(index));
        return result;
      }
      case "ipairs": {
        const table = evaluated[0] ?? null;
        if (!(table instanceof LuaTable))
          throw new Error("ipairs needs a table.");
        return [...table.items];
      }
      default:
        throw new Error(`Unsupported function in an EVAL script: ${name}.`);
    }
  }

  private patternToRegExp(pattern: string): RegExp {
    let source = "";
    for (let index = 0; index < pattern.length; index += 1) {
      const char = pattern[index]!;
      if (char === "%") {
        const next = pattern[index + 1] ?? "";
        index += 1;
        const escapes: Record<string, string> = {
          d: "\\d",
          D: "\\D",
          w: "\\w",
          W: "\\W",
          s: "\\s",
          S: "\\S",
          a: "[a-zA-Z]",
          A: "[^a-zA-Z]",
          l: "[a-z]",
          u: "[A-Z]",
          ".": "\\.",
          "(": "\\(",
          ")": "\\)",
          "[": "\\[",
          "]": "\\]",
          "{": "\\{",
          "}": "\\}",
          "*": "\\*",
          "+": "\\+",
          "?": "\\?",
          "-": "\\-",
          "^": "\\^",
          "$": "\\$",
          "|": "\\|",
          '"': '\\"',
          "%": "%",
        };
        source += escapes[next] ?? next;
      } else {
        source += char;
      }
    }
    return new RegExp(source);
  }
}

function toLuaValue(result: unknown): LuaValue {
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return new LuaTable(result.map(toLuaValue));
  if (typeof result === "boolean") return result;
  if (typeof result === "number") return result;
  return String(result);
}

function toJsValue(value: LuaValue): unknown {
  if (value instanceof LuaTable) return value.items.map(toJsValue);
  return value;
}

/** Runs an EVAL script against the in-memory store. */
export function memoryRedisEval(params: {
  script: string;
  keys?: string[];
  args?: Array<string | number>;
}): unknown {
  const parser = new LuaParser(tokenizeLua(params.script));
  const runtime = new LuaRuntime(params.keys ?? [], params.args ?? []);
  return toJsValue(runtime.run(parser.parseProgram()));
}

/** Clears the in-memory store; used by tests. */
export function resetMemoryRedisForTests(): void {
  getStore().clear();
}
