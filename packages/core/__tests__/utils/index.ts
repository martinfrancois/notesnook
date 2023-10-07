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

import DB from "../../src/api";
import { NodeStorageInterface } from "../../__mocks__/node-storage.mock";
import dayjs from "dayjs";
import { groupArray } from "../../src/utils/grouping";
import { FS } from "../../__mocks__/fs.mock";
import Compressor from "../../__mocks__/compressor.mock";
import { expect } from "vitest";
import { EventSourcePolyfill as EventSource } from "event-source-polyfill";
import { randomBytes } from "../../src/utils/random";
import { GroupOptions, Note, Notebook } from "../../src/types";
import { NoteContent } from "../../src/collections/session-content";
import { SqliteDriver } from "kysely";
import BetterSQLite3 from "better-sqlite3";

const TEST_NOTEBOOK: Partial<Notebook> = {
  title: "Test Notebook",
  description: "Test Description"
};

const TEST_NOTEBOOK2: Partial<Notebook> = {
  title: "Test Notebook 2",
  description: "Test Description 2"
};

function databaseTest() {
  const db = new DB();
  db.setup({
    storage: new NodeStorageInterface(),
    eventsource: EventSource,
    fs: FS,
    compressor: Compressor,
    sqlite: new SqliteDriver({ database: BetterSQLite3(":memory:") })
  });
  return db.init().then(() => db);
}

const notebookTest = (notebook = TEST_NOTEBOOK) =>
  databaseTest().then(async (db) => {
    const id = await db.notebooks.add(notebook);
    return { db, id };
  });

const TEST_NOTE: { content: NoteContent<false> } = {
  content: {
    type: "tiptap",
    data: `<p>Hello <span style="color:#f00">This is colorful</span></p>`
  }
};

const IMG_CONTENT = `<p>This is a note for me.j</p>\n<p><img src="data:image/png;base64,iVBORw0K" data-hash="d3eab72e94e3cd35" class="attachment" alt="Screenshot_20210915_102333.png" data-mime="image/png" data-filename="Screenshot_20210915_102333.png" data-size="68609" style="float: left;" /> &nbsp;</p>\n<p>&nbsp;</p>`;
const IMG_CONTENT_WITHOUT_HASH = `<p>This is a note for me.j</p>\n<p><img src="data:image/png;base64,iVBORw0K" class="attachment" alt="Screenshot_20210915_102333.png" data-mime="image/png" data-filename="Screenshot_20210915_102333.png" data-size="68609" style="float: left;" /> &nbsp;</p>\n<p>&nbsp;</p>`;

const LONG_TEXT =
  "Lorem Ipsum is simply dummy text of the printing and typesetting industry. Lorem Ipsum has been the industry's standard dummy text ever since the 1500s, when an unknown printer took a galley of type and scrambled it to make a type specimen book. It has survived not only five centuries, but also the leap into electronic typesetting, remaining essentially unchanged. It was popularised in the 1960s with the release of Letraset sheets containing Lorem Ipsum passages, and more recently with desktop publishing software like Aldus PageMaker including versions of Lorem Ipsum.";

const noteTest = (
  note: Partial<
    Note & { content: NoteContent<false>; sessionId: string }
  > = TEST_NOTE
) =>
  databaseTest().then(async (db) => {
    const id = await db.notes.add(note);
    if (!id) throw new Error("Failed to add note.");
    return { db, id };
  });

const groupedTest = (type: GroupOptions["groupBy"]) =>
  noteTest().then(async ({ db }) => {
    await db.notes.add({ ...TEST_NOTE, title: "HELLO WHAT!" });
    await db.notes.add({
      ...TEST_NOTE,
      title: "Some title",
      dateCreated: dayjs().startOf("week").subtract(1, "day").unix()
    });
    await db.notes.add({
      ...TEST_NOTE,
      title: "Some title and title title",
      dateCreated: dayjs().subtract(2, "weeks").unix()
    });
    const grouped = groupArray(db.notes.all, {
      groupBy: type,
      sortDirection: "desc",
      sortBy: "dateCreated"
    });
    expect(grouped.length).toBeGreaterThan(1);
    expect(grouped.some((i) => i.type === "header")).toBe(true);
  });

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginFakeUser(db) {
  const email = "johndoe@example.com";
  const userSalt = randomBytes(16).toString("base64");
  await db.storage().deriveCryptoKey(`_uk_@${email}`, {
    password: "password",
    salt: userSalt
  });

  const userEncryptionKey = await db.storage().getCryptoKey(`_uk_@${email}`);

  const key = await db.crypto().generateRandomKey();
  const attachmentsKey = await db
    .storage()
    .encrypt({ password: userEncryptionKey }, JSON.stringify(key));

  await db.user.setUser({
    email,
    salt: userSalt,
    attachmentsKey: attachmentsKey
  });
}

export {
  databaseTest,
  notebookTest,
  noteTest,
  groupedTest,
  IMG_CONTENT,
  IMG_CONTENT_WITHOUT_HASH,
  TEST_NOTEBOOK,
  TEST_NOTEBOOK2,
  TEST_NOTE,
  LONG_TEXT,
  delay,
  loginFakeUser
};
