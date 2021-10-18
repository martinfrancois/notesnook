import StorageInterface from "../interfaces/storage";
import FS from "../interfaces/fs";
import EventSource from "eventsource";
import Config from "../utils/config";
import http from "notes-core/utils/http";
import { EV, EVENTS } from "notes-core/common";
import { getCurrentHash, hashNavigate } from "../navigation";
import { isTesting } from "../utils/platform";

global.HTMLParser = new DOMParser().parseFromString(
  "<body></body>",
  "text/html"
);
/**
 * @type {import("notes-core/api").default}
 */
var db;
async function initializeDatabase() {
  const { default: Database } = await import("notes-core/api");
  db = new Database(StorageInterface, EventSource, FS);

  if (isTesting()) {
    db.host({
      API_HOST: "https://api.notesnook.com",
      AUTH_HOST: "https://auth.streetwriters.co",
      SSE_HOST: "https://events.streetwriters.co",
    });
  } else {
    db.host({
      API_HOST: "http://localhost:5264",
      AUTH_HOST: "http://localhost:8264",
      SSE_HOST: "http://localhost:7264",
    });
    // db.host({
    //   API_HOST: "http://192.168.10.29:5264",
    //   AUTH_HOST: "http://192.168.10.29:8264",
    //   SSE_HOST: "http://192.168.10.29:7264",
    // });
  }

  await db.init();

  if (!isAppHydrated() && !isTesting()) {
    try {
      loadDefaultNotes(db);
    } catch (e) {}
  }
  return db;
}

export { db, initializeDatabase };

function isAppHydrated() {
  return Config.get("hydrated", false);
}

function setAppHydrated() {
  return Config.set("hydrated", true);
}

async function loadDefaultNotes(db) {
  const notes = await http.get("/notes/index_v14.json");
  if (!notes) return;
  let autoOpenId;
  const hash = getCurrentHash().replaceAll("#", "");
  for (let note of notes) {
    const content = await http.get(note.webContent);
    let id = await db.notes.add({
      title: note.title,
      headline: note.headline,
      localOnly: true,
      content: { type: "tiny", data: content },
    });
    if (note.autoOpen) autoOpenId = id;
  }

  if (autoOpenId) {
    hashNavigate(`/notes/${autoOpenId}/edit`);
    if (hash) setTimeout(() => hashNavigate(hash), 100);
  }
  setAppHydrated();
  EV.publish(EVENTS.appRefreshRequested);
}
