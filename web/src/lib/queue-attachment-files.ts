// 排队消息里粘贴的文件（浏览器 File，没有本机路径）存 IndexedDB，重启后恢复（design.md 4.22）。
// localStorage 放不下文件内容，那里只记元信息；这里按附件 id 存内容。所有操作失败都不抛出。

const DB_NAME = "agentdeck.composerQueue";
const STORE_NAME = "attachmentFiles";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前环境没有 IndexedDB"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("打开 IndexedDB 失败"));
  });
  dbPromise = opening;
  opening.catch(() => {
    dbPromise = null;
  });
  return opening;
}

/** 执行一次请求，事务提交后才算完成（写入已落盘，刷新不会丢）。 */
async function runRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 事务中止"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 事务失败"));
  });
}

export async function saveAttachmentFile(id: string, file: File): Promise<boolean> {
  try {
    await runRequest("readwrite", (store) => store.put(file, id));
    return true;
  } catch (error) {
    console.warn("保存排队附件失败：", error);
    return false;
  }
}

/** 取不到（不存在或读取失败）时返回 null。 */
export async function loadAttachmentFile(id: string): Promise<File | null> {
  try {
    const value: unknown = await runRequest("readonly", (store) => store.get(id));
    return value instanceof File ? value : null;
  } catch (error) {
    console.warn("读取排队附件失败：", error);
    return null;
  }
}

export async function deleteAttachmentFile(id: string): Promise<void> {
  try {
    await runRequest("readwrite", (store) => store.delete(id));
  } catch (error) {
    console.warn("删除排队附件失败：", error);
  }
}

/** 清理不再被任何排队消息引用的文件。 */
export async function pruneAttachmentFiles(keep: ReadonlySet<string>): Promise<void> {
  try {
    const keys = await runRequest("readonly", (store) => store.getAllKeys());
    await Promise.all(
      keys.filter((key) => typeof key === "string" && !keep.has(key)).map((key) => deleteAttachmentFile(key as string)),
    );
  } catch (error) {
    console.warn("清理排队附件失败：", error);
  }
}
