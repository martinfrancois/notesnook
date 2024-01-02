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
  Attachment,
  Color,
  Note,
  Notebook,
  Reminder,
  Shortcut,
  Tag,
  VirtualizedGrouping,
  HistorySession
} from "@notesnook/core";
import React, { useEffect, useRef, useState } from "react";
import { db } from "../common/database";
import {
  eSendEvent,
  eSubscribeEvent,
  eUnSubscribeEvent
} from "../services/event-manager";
import { eDBItemUpdate } from "../utils/events";
import { useSettingStore } from "../stores/use-setting-store";

type ItemTypeKey = {
  note: Note;
  notebook: Notebook;
  tag: Tag;
  color: Color;
  reminder: Reminder;
  attachment: Attachment;
  shortcut: Shortcut;
  noteHistory: HistorySession;
};

function isValidIdOrIndex(idOrIndex?: string | number) {
  return typeof idOrIndex === "number" || typeof idOrIndex === "string";
}

export const useDBItem = <T extends keyof ItemTypeKey>(
  idOrIndex?: string | number,
  type?: T,
  items?: VirtualizedGrouping<ItemTypeKey[T]>
): [ItemTypeKey[T] | undefined, () => void] => {
  const [item, setItem] = useState<ItemTypeKey[T]>();
  const itemIdRef = useRef<string>();
  const prevIdOrIndexRef = useRef<string | number>();

  if (prevIdOrIndexRef.current !== idOrIndex) {
    itemIdRef.current = undefined;
    prevIdOrIndexRef.current = idOrIndex;
  }

  useEffect(() => {
    const onUpdateItem = (itemId?: string) => {
      if (typeof itemId === "string" && itemId !== itemIdRef.current) return;

      if (!isValidIdOrIndex(idOrIndex)) return;

      console.log("useDBItem.onUpdateItem", idOrIndex, type);

      if (items && typeof idOrIndex === "number") {
        items.item(idOrIndex).then((item) => {
          setItem(item.item);
          itemIdRef.current = item.item.id;
        });
      } else {
        if (!(db as any)[type + "s"][type]) {
          console.warn(
            "no method found for",
            `db.${type}s.${type}(id: string)`
          );
        } else {
          (db as any)[type + "s"]
            ?.[type]?.(idOrIndex as string)
            .then((item: ItemTypeKey[T]) => {
              setItem(item);
              itemIdRef.current = item.id;
            });
        }
      }
    };
    if (useSettingStore.getState().isAppLoading) {
      useSettingStore.subscribe((state) => {
        if (!state.isAppLoading) {
          onUpdateItem();
        }
      });
    } else {
      onUpdateItem();
    }
    eSubscribeEvent(eDBItemUpdate, onUpdateItem);
    return () => {
      eUnSubscribeEvent(eDBItemUpdate, onUpdateItem);
    };
  }, [idOrIndex, type, items]);

  return [
    isValidIdOrIndex(idOrIndex) ? (item as ItemTypeKey[T]) : undefined,
    () => {
      if (idOrIndex) {
        eSendEvent(eDBItemUpdate, itemIdRef.current || idOrIndex);
      }
    }
  ];
};

export const useTotalNotes = (type: "notebook" | "tag" | "color") => {
  const [totalNotesById, setTotalNotesById] = useState<{
    [id: string]: number;
  }>({});

  const getTotalNotes = React.useCallback(
    (ids: string[]) => {
      if (!ids || !ids.length || !type) return;
      db.relations
        .from({ type: type, ids: ids as string[] }, ["note"])
        .get()
        .then((relations) => {
          const totalNotesById: any = {};
          for (const id of ids) {
            totalNotesById[id] = relations.filter(
              (relation) => relation.fromId === id && relation.toType === "note"
            )?.length;
          }
          setTotalNotesById(totalNotesById);
        });
      console.log("useTotalNotes.getTotalNotes");
    },
    [type]
  );

  return {
    totalNotes: (id: string) => {
      return totalNotesById[id] || 0;
    },
    getTotalNotes: getTotalNotes
  };
};
