/**
 * better-sqlite3 类型声明
 */

declare module 'better-sqlite3' {
  interface Statement {
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint }
    get(...params: any[]): any
    all(...params: any[]): any[]
  }

  class Database {
    constructor(filename: string, options?: { readonly?: boolean; fileMustExist?: boolean })
    prepare(sql: string): Statement
    exec(sql: string): void
    close(): void
    pragma(pragma: string, options?: { simple?: boolean }): any
    loadExtension(path: string): void
  }

  namespace Database {
    type DatabaseType = Database
  }

  export = Database
}
