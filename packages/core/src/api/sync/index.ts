/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import {
  checkSyncStatus,
  CURRENT_DATABASE_VERSION,
  EV,
  EVENTS,
  sendSyncProgressEvent,
  SYNC_CHECK_IDS
} from "../../common";
import Constants from "../../utils/constants";
import TokenManager from "../token-manager";
import Collector from "./collector";
import * as signalr from "@microsoft/signalr";
import Merger from "./merger";
import { AutoSync } from "./auto-sync";
import { MessagePackHubProtocol } from "@microsoft/signalr-protocol-msgpack";
import { logger } from "../../logger";
import { Mutex } from "async-mutex";
import Database from "..";
import { migrateItem, migrateVaultKey } from "../../migrations";
import { SerializedKey } from "@notesnook/crypto";
import {
  Attachment,
  Item,
  MaybeDeletedItem,
  Note,
  Notebook
} from "../../types";
import { SYNC_COLLECTIONS_MAP, SyncTransferItem } from "./types";
import { DownloadableFile } from "../../database/fs";
import { SyncDevices } from "./devices";
import { DefaultColors } from "../../collections/colors";

export default class SyncManager {
  sync = new Sync(this.db);
  devices = this.sync.devices;
  constructor(private readonly db: Database) {}

  async start(full?: boolean, force?: boolean) {
    try {
      if (await checkSyncStatus(SYNC_CHECK_IDS.autoSync))
        await this.sync.autoSync.start();
      await this.sync.start(full, force);
      return true;
    } catch (e) {
      const isHubException = (e as Error).message.includes("HubException:");
      if (isHubException) {
        const actualError = /HubException: (.*)/gm.exec((e as Error).message);
        const errorText =
          actualError && actualError.length > 1
            ? actualError[1]
            : (e as Error).message;

        // NOTE: sometimes there's the case where the user has already
        // confirmed their email but the server still thinks that it
        // isn't confirmed. This check is added to trigger a force
        // update of the access token.
        if (
          (errorText.includes("Please confirm your email ") ||
            errorText.includes("Invalid token.")) &&
          (await this.db.user.getUser())?.isEmailConfirmed
        ) {
          await this.db.tokenManager._refreshToken(true);
          return false;
        }

        throw new Error(errorText);
      }
      throw e;
    }
  }

  async acquireLock(callback: () => Promise<void>) {
    try {
      this.sync.autoSync.stop();
      await callback();
    } finally {
      await this.sync.autoSync.start();
    }
  }

  async stop() {
    await this.sync.cancel();
  }
}

class Sync {
  collector = new Collector(this.db);
  merger = new Merger(this.db);
  autoSync = new AutoSync(this.db, 1000);
  logger = logger.scope("Sync");
  syncConnectionMutex = new Mutex();
  connection?: signalr.HubConnection;
  devices = new SyncDevices(this.db.kv, this.db.tokenManager);

  constructor(private readonly db: Database) {
    EV.subscribe(EVENTS.userLoggedOut, async () => {
      await this.connection?.stop();
      this.autoSync.stop();
    });
  }

  async start(full?: boolean, force?: boolean) {
    this.createConnection();

    if (!this.connection) return;
    if (!(await checkSyncStatus(SYNC_CHECK_IDS.sync))) {
      await this.connection.stop();
      return;
    }
    if (!(await this.db.user.getUser())) return;

    this.logger.info("Starting sync", { full, force });

    this.connection.onclose((error = new Error("Connection closed.")) => {
      this.db.eventManager.publish(EVENTS.syncAborted);
      this.logger.error(error);
      throw new Error("Connection closed.");
    });

    const { deviceId } = await this.init(force);
    this.logger.info("Initialized sync", { deviceId });

    if (full) {
      await this.fetch(deviceId);
      this.logger.info("Data fetched");
    }

    if (await this.send(deviceId, force)) this.logger.info("New data sent");

    await this.stop();

    if (!(await checkSyncStatus(SYNC_CHECK_IDS.autoSync))) {
      await this.connection.stop();
      this.autoSync.stop();
    }
  }

  async init(isForceSync?: boolean) {
    await this.checkConnection();

    if (isForceSync) {
      await this.devices.unregister();
      await this.devices.register();
    }

    let deviceId = await this.devices.get();
    if (!deviceId) {
      await this.devices.register();
      deviceId = await this.devices.get();
    }

    if (!deviceId) throw new Error("Sync device not registered.");

    return { deviceId };
  }

  async fetch(deviceId: string) {
    await this.checkConnection();

    const key = await this.db.user.getEncryptionKey();
    if (!key || !key.key || !key.salt) {
      this.logger.error(
        new Error("User encryption key not generated. Please relogin.")
      );
      EV.publish(EVENTS.userSessionExpired);
      return;
    }

    let count = 0;
    this.connection?.off("SendItems");
    this.connection?.off("SendVaultKey");

    this.connection?.on("SendVaultKey", async (vaultKey) => {
      if (this.connection?.state !== signalr.HubConnectionState.Connected)
        return false;

      if (
        vaultKey &&
        vaultKey.cipher !== null &&
        vaultKey.iv !== null &&
        vaultKey.salt !== null &&
        vaultKey.length > 0
      ) {
        const vault = await this.db.vaults.default();
        if (!vault)
          await migrateVaultKey(
            this.db,
            vaultKey,
            5.9,
            CURRENT_DATABASE_VERSION
          );
      }

      return true;
    });

    this.connection?.on("SendItems", async (chunk) => {
      if (this.connection?.state !== signalr.HubConnectionState.Connected)
        return false;

      await this.processChunk(chunk, key);

      count += chunk.items.length;
      sendSyncProgressEvent(this.db.eventManager, `download`, count);

      return true;
    });
    await this.connection?.invoke("RequestFetch", deviceId);

    this.connection?.off("SendItems");
    this.connection?.off("SendVaultKey");
  }

  async send(deviceId: string, isForceSync?: boolean) {
    // TODO: remove this.
    if (process.env.NODE_ENV !== "test") return false;
    await this.uploadAttachments();

    let done = 0;
    for await (const item of this.collector.collect(100, isForceSync)) {
      const result = await this.pushItem(deviceId, item);
      if (result) {
        done += item.items.length;
        sendSyncProgressEvent(this.db.eventManager, "upload", done);

        this.logger.info(`Batch sent (${done})`);
      } else {
        this.logger.error(
          new Error(`Failed to send batch. Server returned falsy response.`)
        );
      }
    }
    await this.connection?.send("PushCompleted");
    return true;
  }

  async stop() {
    // refresh monographs on sync completed
    await this.db.monographs.refresh();

    this.logger.info("Stopping sync");
    await this.db.setLastSynced(Date.now());
    this.db.eventManager.publish(EVENTS.syncCompleted);
  }

  async cancel() {
    this.logger.info("Sync canceled");
    await this.connection?.stop();
  }

  /**
   * @private
   */
  async uploadAttachments() {
    const attachments = await this.db.attachments.pending.items();
    this.logger.info("Uploading attachments...", { total: attachments.length });

    await this.db.fs().queueUploads(
      attachments.map<DownloadableFile>((a) => ({
        filename: a.hash,
        chunkSize: a.chunkSize
      })),
      "sync-uploads"
    );
  }

  /**
   * @private
   */
  async onPushCompleted() {
    this.db.eventManager.publish(EVENTS.databaseSyncRequested, true, false);
  }

  async processChunk(chunk: SyncTransferItem, key: SerializedKey) {
    const itemType = chunk.type;
    const decrypted = await this.db.storage().decryptMulti(key, chunk.items);

    const deserialized: MaybeDeletedItem<Item>[] = [];
    for (let i = 0; i < decrypted.length; ++i) {
      const decryptedItem = decrypted[i];
      const version = chunk.items[i].v;
      const item = await deserializeItem(decryptedItem, version, this.db);
      if (item) deserialized.push(item);
    }

    const collectionType = SYNC_COLLECTIONS_MAP[itemType];
    const collection = this.db[collectionType].collection;
    const localItems = await collection.records(chunk.items.map((i) => i.id));
    let items: (MaybeDeletedItem<Item> | undefined)[] = [];
    if (itemType === "content") {
      items = await Promise.all(
        deserialized.map((item) =>
          this.merger.mergeContent(item, localItems[item.id])
        )
      );
    } else {
      items =
        itemType === "attachment"
          ? await Promise.all(
              deserialized.map((item) =>
                this.merger.mergeAttachment(
                  item as MaybeDeletedItem<Attachment>,
                  localItems[item.id] as MaybeDeletedItem<Attachment>
                )
              )
            )
          : deserialized.map((item) =>
              this.merger.mergeItem(item, localItems[item.id])
            );
    }

    if ((itemType === "note" || itemType === "content") && items.length > 0) {
      items.forEach((item) =>
        this.db.eventManager.publish(EVENTS.syncItemMerged, item)
      );
    }

    await collection.put(items as any);
  }

  private async pushItem(deviceId: string, item: SyncTransferItem) {
    await this.checkConnection();
    return (await this.connection?.invoke("PushItems", deviceId, item)) === 1;
  }

  private createConnection() {
    if (this.connection) return;

    const tokenManager = new TokenManager(this.db.kv);
    this.connection = new signalr.HubConnectionBuilder()
      .withUrl(`${Constants.API_HOST}/hubs/sync/v2`, {
        accessTokenFactory: async () => {
          const token = await tokenManager.getAccessToken();
          if (!token) throw new Error("Failed to get access token.");
          return token;
        },
        skipNegotiation: true,
        transport: signalr.HttpTransportType.WebSockets,
        logger: {
          log: (level, message) => {
            const scopedLogger = logger.scope("SignalR::SyncHub");
            switch (level) {
              case signalr.LogLevel.Critical:
                return scopedLogger.fatal(new Error(message));
              case signalr.LogLevel.Error: {
                this.db.eventManager.publish(EVENTS.syncAborted, message);
                return scopedLogger.error(new Error(message));
              }
              case signalr.LogLevel.Warning:
                return scopedLogger.warn(message);
            }
          }
        }
      })
      .withHubProtocol(new MessagePackHubProtocol({ ignoreUndefined: true }))
      .build();
    this.connection.serverTimeoutInMilliseconds = 60 * 1000 * 5;
    this.connection.on("PushCompleted", () => this.onPushCompleted());
  }

  private async checkConnection() {
    await this.syncConnectionMutex.runExclusive(async () => {
      try {
        if (
          this.connection &&
          this.connection.state !== signalr.HubConnectionState.Connected
        ) {
          if (
            this.connection.state !== signalr.HubConnectionState.Disconnected
          ) {
            await this.connection.stop();
          }

          await promiseTimeout(30000, this.connection.start());
        }
      } catch (e) {
        console.error(e);
        if (e instanceof Error) {
          this.logger.warn(e.message);
          throw new Error(
            "Could not connect to the Sync server. Please try again."
          );
        }
      }
    });
  }
}

function promiseTimeout(ms: number, promise: Promise<unknown>) {
  // Create a promise that rejects in <ms> milliseconds
  const timeout = new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error("Sync timed out in " + ms + "ms."));
    }, ms);
  });
  // Returns a race between our timeout and the passed in promise
  return Promise.race([promise, timeout]);
}

async function deserializeItem(
  decryptedItem: string,
  version: number,
  database: Database
): Promise<MaybeDeletedItem<Item> | undefined> {
  const item = JSON.parse(decryptedItem);
  item.remote = true;
  item.synced = true;

  if (!item.cipher) {
    let migrationResult = await migrateItem(
      item,
      version,
      CURRENT_DATABASE_VERSION,
      item.type,
      database,
      "sync"
    );
    if (migrationResult === "skip") return;

    // since items in trash can have their own set of migrations,
    // we have to run the migration again to account for that.
    if (item.type === "trash" && item.itemType) {
      migrationResult = await migrateItem(
        item as unknown as Note | Notebook,
        version,
        CURRENT_DATABASE_VERSION,
        item.itemType,
        database,
        "backup"
      );
      if (migrationResult === "skip") return;
    }

    const itemType =
      // colors are naively of type "tag" instead of "color" so we have to fix that.
      item.type === "tag" && DefaultColors[item.title.toLowerCase()]
        ? "color"
        : item.type === "trash" && "itemType" in item && item.itemType
        ? item.itemType
        : item.type;

    if (!itemType || itemType === "topic" || itemType === "settings") return;

    if (migrationResult) item.synced = false;
  }
  return item;
}
