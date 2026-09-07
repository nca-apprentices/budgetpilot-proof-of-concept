/**
 * Minimale Typen für Nodes eingebautes `node:sqlite`.
 *
 * Wird ausschliesslich von __tests__/db.test.ts benutzt, um echtes SQLite
 * hinter den SqlDatabase-Port zu hängen (op-sqlite ist ein natives Modul und
 * in Jest nicht ladbar — siehe src/db/sql.ts).
 *
 * Warum nicht `@types/node`: die Basis-Config (@react-native/typescript-config)
 * setzt `types: ["jest"]`. Um @types/node zu aktivieren, müsste "node" dort
 * ergänzt werden — damit lägen aber alle Node-Globals (process, Buffer,
 * NodeJS.Timeout …) auch über dem App-Code, der auf Hermes läuft und sie nicht
 * hat. Deklariert ist deshalb nur, was der Test-Adapter wirklich aufruft.
 *
 * @format
 */

declare module 'node:sqlite' {
  export type SQLInputValue = string | number | bigint | null | Uint8Array;
  export type SQLOutputValue = string | number | bigint | null | Uint8Array;

  export class StatementSync {
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[];
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
    run(...params: SQLInputValue[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
