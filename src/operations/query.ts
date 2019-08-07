import {
  getFieldAlias,
  getFieldArguments,
  getName,
  getSelectionSet,
  forEachFieldNode,
} from '../ast';

import { joinKeys, keyOfField } from '../helpers';
import { Store } from '../store';
import { Entity, Link, SelectionSet } from '../types';

import { makeContext } from './shared';
import { Context, Data, Request, Result } from './types';

/** Reads a request entirely from the store */
export const query = (store: Store, request: Request): Result => {
  const ctx = makeContext(store, request);
  if (ctx === undefined) {
    return { isComplete: false, dependencies: [] };
  }

  const select = getSelectionSet(ctx.operation);
  const data = readEntity(ctx, 'Query', select, Object.create(null));

  return {
    data,
    isComplete: ctx.isComplete,
    dependencies: ctx.dependencies,
  };
};

const readEntity = (
  ctx: Context,
  key: string,
  select: SelectionSet,
  data: Data
): Data | null => {
  const { store } = ctx;
  const entity = store.find(key);
  if (entity === null) {
    // Cache Incomplete: A missing entity for a key means it wasn't cached
    ctx.isComplete = false;
    return null;
  } else if (key !== 'Query') {
    ctx.dependencies.push(key);
  }

  return readSelection(ctx, entity, key, select, data);
};

const readSelection = (
  ctx: Context,
  entity: Entity,
  key: string,
  select: SelectionSet,
  data: Data
): Data => {
  data.__typename = entity.__typename as string;

  const { store, fragments, vars } = ctx;
  forEachFieldNode(select, fragments, vars, node => {
    const fieldName = getName(node);
    // The field's key can include arguments if it has any
    const fieldKey = keyOfField(fieldName, getFieldArguments(node, vars));
    const fieldValue = entity[fieldKey];
    const fieldAlias = getFieldAlias(node);
    const childFieldKey = joinKeys(key, fieldKey);
    if (key === 'Query') {
      ctx.dependencies.push(childFieldKey);
    }

    if (fieldValue === undefined) {
      // Cache Incomplete: A missing field means it wasn't cached
      ctx.isComplete = false;
      data[fieldAlias] = null;
    } else if (node.selectionSet === undefined || fieldValue !== null) {
      data[fieldAlias] = fieldValue;
    } else {
      // null values mean that a field might be linked to other entities
      const fieldSelect = getSelectionSet(node);
      const link = store.readLink(childFieldKey);

      // Cache Incomplete: A missing link for a field means it's not cached
      if (link === undefined) {
        ctx.isComplete = false;
        data[fieldAlias] = null;
      } else {
        const prevData = data[fieldAlias] as Data;
        data[fieldAlias] = readField(ctx, link, fieldSelect, prevData);
      }
    }
  });

  return data;
};

const readField = (
  ctx: Context,
  link: Link,
  select: SelectionSet,
  prevData: void | Data | Data[]
): null | Data | Data[] => {
  if (Array.isArray(link)) {
    // @ts-ignore: Link cannot be expressed as a recursive type
    return link.map((childLink, index) => {
      const data = prevData !== undefined ? prevData[index] : undefined;
      return readField(ctx, childLink, select, data);
    });
  } else if (link === null) {
    return null;
  } else {
    const data = prevData === undefined ? Object.create(null) : prevData;
    return readEntity(ctx, link, select, data);
  }
};
