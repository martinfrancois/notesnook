import React from "react";
import { db, ev } from "../common";
import * as Icon from "react-feather";
import ListItem from "../components/listview";
import { showSnack } from "../components/snackbar";
import { ask } from "../components/dialogs";
const dropdownRefs = [];
const menuItems = item => [
  {
    title: "Unfavorite",
    onClick: async () => {
      ask(
        Icon.Star,
        "Unfavorite",
        "Are you sure you want to remove this item from favorites?"
      ).then(res => {
        if (res) {
          db.favoriteItem(item.type, item.dateCreated).then(() => {
            let itemType = item.type[0] + item.type.substring(1);
            showSnack(itemType + " Unfavorited!", Icon.Check);
            ev.emit(`refreshFavorites`);
          });
        }
      });
    }
  },
  {
    title: "Delete",
    color: "red",
    onClick: async () => {
      ask(
        Icon.Trash2,
        "Delete",
        "Are you sure you want to delete this note? It will be moved to trash and permanently deleted after 7 days."
      ).then(res => {
        if (res) {
          let itemType = item.type[0] + item.type.substring(1);
          db["delete" + itemType]([item]).then(() => {
            showSnack(itemType + " Deleted!", Icon.Trash);
            ev.emit(`refreshFavorites`);
          });
        }
      });
    }
  }
];

function Favorites() {
  return (
    <ListItem
      type="Favorites"
      getItems={db.getFavorites.bind(db)}
      menu={{ menuItems, dropdownRefs }}
      button={undefined}
    />
  );
}

export default Favorites;
