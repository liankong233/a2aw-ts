/**
 * 模型层公共小类型（与具体协议无关）。
 * @packageDocumentation
 */

/** 可能直接返回值的异步函数。 */
export type MaybePromise<T> = T | Promise<T>;