import { upsertBill } from "./bills.js";

const DB_NAME = "ambar-energia-offline";
const DB_VERSION = 1;
const STORE = "pending_bills";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "localId" });
        store.createIndex("by_user", "userId", { unique: false });
        store.createIndex("by_month", ["userId", "monthKey"], { unique: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Falha ao abrir IndexedDB."));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Falha na transação offline."));
    tx.onabort = () => reject(tx.error || new Error("Transação offline abortada."));
  });
}

function makeLocalId(userId, monthKey) {
  return `${userId}:${monthKey}`;
}

export function isProbablyOffline(error) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    msg.includes("failed to fetch") ||
    msg.includes("network") ||
    msg.includes("offline") ||
    msg.includes("fetch") ||
    msg.includes("timeout") ||
    error?.name === "TypeError"
  );
}

export async function queueBill(userId, payload) {
  const db = await openDb();
  const localId = makeLocalId(userId, payload.monthKey);
  const record = {
    localId,
    userId,
    monthKey: payload.monthKey,
    payload: {
      previous: payload.previous,
      current: payload.current,
      factor: payload.factor,
      rate: payload.rate,
      extras: payload.extras,
      status: payload.status === "paid" ? "paid" : "pending",
      monthKey: payload.monthKey,
    },
    queuedAt: new Date().toISOString(),
  };

  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(record);
  await txDone(tx);
  db.close();
  return record;
}

export async function listQueuedBills(userId) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const index = tx.objectStore(STORE).index("by_user");
  const request = index.getAll(userId);
  const rows = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  await txDone(tx);
  db.close();
  return rows.sort((a, b) => String(a.monthKey).localeCompare(String(b.monthKey)));
}

export async function removeQueuedBill(localId) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete(localId);
  await txDone(tx);
  db.close();
}

/**
 * Envia faturas enfileiradas para o Supabase.
 * @returns {{ synced: number, remaining: number, errors: string[] }}
 */
export async function flushQueuedBills(userId) {
  const queued = await listQueuedBills(userId);
  let synced = 0;
  const errors = [];

  for (const item of queued) {
    try {
      await upsertBill(userId, item.payload);
      await removeQueuedBill(item.localId);
      synced += 1;
    } catch (error) {
      if (isProbablyOffline(error)) break;
      errors.push(`${item.monthKey}: ${error.message || "erro ao sincronizar"}`);
    }
  }

  const remaining = (await listQueuedBills(userId)).length;
  return { synced, remaining, errors };
}

export function watchOnline(callback) {
  const handler = () => callback(navigator.onLine !== false);
  window.addEventListener("online", handler);
  window.addEventListener("offline", handler);
  return () => {
    window.removeEventListener("online", handler);
    window.removeEventListener("offline", handler);
  };
}
