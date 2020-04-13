import "jest-fetch-mock";

const SUCCESS_LOGIN_RESPONSE = {
  access_token: "access_token",
  refresh_token: "refresh_token",
  payload: {
    username: "thecodrr",
    email: process.env.EMAIL,
    lastSynced: 0,
  },
  scopes: "sync",
  expiry: 36000,
};

async function login(db) {
  fetchMock.mockResponseOnce(JSON.stringify(SUCCESS_LOGIN_RESPONSE));
  await db.user.login("username", "password");
}

function mainCollectionParams(collection, itemKey, item) {
  async function addItem(db) {
    const id = await db[collection].add(item);
    return db[collection][itemKey](id).data;
  }

  async function editItem(db, item) {
    await db[collection].add({ ...item, title: "dobido" });
  }

  function getItem(db, item) {
    return db[collection][itemKey](item.id).data;
  }

  return [collection, addItem, editItem, getItem];
}

function tagsCollectionParams(collection, item) {
  async function addItem(db) {
    const id = await db[collection].add(item, 20);
    return db[collection].tag(id);
  }

  async function editItem(db) {
    await db[collection].add(item, 240);
  }

  function getItem(db, item) {
    return db[collection].tag(item.id);
  }

  return [collection, addItem, editItem, getItem];
}

function getEncrypted(item) {
  return {
    iv: "some_iv",
    cipher: JSON.stringify(item),
  };
}

export { tagsCollectionParams, mainCollectionParams, login, getEncrypted };
