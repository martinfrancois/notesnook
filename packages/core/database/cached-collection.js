import Indexer from "./indexer";
import sort from "fast-sort";

export default class CachedCollection {
  constructor(context, type) {
    this.map = new Map();
    this.indexer = new Indexer(context, type);
    this.transactionOpen = false;
  }

  async init() {
    await this.indexer.init();
    const data = await this.indexer.readMulti(this.indexer.indices);
    this.map = new Map(data);
  }

  /**
   *
   * @param {Promise} ops
   */
  transaction(ops) {
    this.transactionOpen = true;
    return ops().then(() => Promise.resolve((this.transactionOpen = false)));
  }

  async addItem(item) {
    if (this.transactionOpen) return;
    if (!item.id) throw new Error("The item must contain the id field.");

    let exists = this.map.has(item.id);
    if (!exists) {
      item.dateCreated = item.dateCreated || Date.now();
    }
    await this.updateItem(item);
    if (!exists) {
      await this.indexer.index(item.id);
    }
  }

  async updateItem(item) {
    if (this.transactionOpen) return;
    if (!item.id) throw new Error("The item must contain the id field.");
    // if item is newly synced, remote will be true.
    item.dateEdited = item.remote ? item.dateEdited : Date.now();
    // the item has become local now, so remove the flag.
    delete item.remote;
    this.map.set(item.id, item);
    await this.indexer.write(item.id, item);
  }

  async removeItem(id) {
    if (this.transactionOpen) return;
    await this.indexer.deindex(id);
    await this.indexer.remove(id);
    this.map.delete(id);
  }

  exists(id) {
    return this.map.has(id);
  }

  getItem(id) {
    return this.map.get(id);
  }

  getAllItems(sortFn = u => u.dateCreated) {
    let items = [];
    this.map.forEach(value => {
      items[items.length] = value;
    });
    return sort(items).desc(sortFn);
  }
}
